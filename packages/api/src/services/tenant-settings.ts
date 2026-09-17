import crypto from 'crypto';
import { queryOne } from '../db/client.js';
import { decrypt } from './crypto.js';
import {
  MIN_SCOREABLE_WORDS,
  MIN_SCOREABLE_DURATION_SECONDS,
  PASS_THRESHOLD,
  hasFeature,
} from '@callguard/shared';
import type {
  Plan,
  FeatureFlag,
  ScoringScope,
  TranscriptionMode,
  MonoFirstSpeaker,
  DeepgramRegion,
  DialerProvider,
  DialerFieldMap,
  ZohoWritebackTrigger,
} from '@callguard/shared';

// ============================================================
// Per-tenant scoring/ingestion policy. Reads the organizations row (see
// migration 038); the columns' DB defaults reproduce the previous global
// constants exactly, so this always resolves to a value — there is no
// fallback-to-constant branch needed here, only at the column-default level.
// The constants above stay in shared as the canonical floor/default value
// new orgs are created with (see db/migrations/038 and scripts/seed-demo.ts).
// ============================================================

// Upper bound on organizations.journey_window_days, mirroring the column's CHECK
// (migration 072). Two years: long enough for the slowest new-build mortgage
// case, short enough that a mis-set value can't sweep a customer's entire
// history into a single journey.
export const MAX_JOURNEY_WINDOW_DAYS = 730;

// Upper bound on organizations.review_confidence_floor, mirroring the column's
// CHECK (migration 082). Deliberately short of 1.0: at 1.0 every checkpoint the
// model is not certain about routes to a human, which in practice is all of
// them, and a scoring product that scores nothing is not a safer scoring
// product — it just moves the whole job back to the QA team unannounced.
export const MAX_REVIEW_CONFIDENCE_FLOOR = 0.95;

export interface ScoringSettings {
  scoringScope: ScoringScope;
  minScoreableSeconds: number;
  minScoreableWords: number;
  passThreshold: number;
  // How many independent scoring passes to run and vote across (migration 076).
  // 1 = single pass. Above 1, checkpoints the runs disagree on go to manual
  // review rather than being auto-scored, so the score covers unanimous
  // verdicts only and stops moving between runs.
  scoringSamples: number;
  // Route a checkpoint to manual review when the model's own confidence is
  // below this (migration 082). 0 = off. See MAX_REVIEW_CONFIDENCE_FLOOR for
  // why it cannot be set to 1.
  reviewConfidenceFloor: number;
  retentionDays: number;
  transcriptionMode: TranscriptionMode;
  monoFirstSpeaker: MonoFirstSpeaker;
  deepgramRegion: DeepgramRegion;
  deepgramMipOptOut: boolean;
  // When the Zoho write-back fires (CG-4). Gates the CRM push only — scoring
  // runs automatically off the sale trigger either way.
  zohoWritebackTrigger: ZohoWritebackTrigger;
  // Download a dialler call's recording only when a sale for that customer
  // arrives, capturing metadata alone until then (migration 119). Only ever
  // true for a sales_only firm. Deliberately separate from scoringScope: holding
  // a score keeps the transcript, but a recording never fetched is lost for
  // good once the dialler's retention expires.
  fetchRecordingsOnSale: boolean;
}

interface ScoringSettingsRow {
  scoring_scope: ScoringScope;
  min_scoreable_seconds: number;
  min_scoreable_words: number;
  pass_threshold: string;
  retention_days: number;
  transcription_mode: TranscriptionMode;
  mono_first_speaker: MonoFirstSpeaker;
  deepgram_region: DeepgramRegion;
  deepgram_mip_opt_out: boolean;
  scoring_samples: number;
  review_confidence_floor: string;
  zoho_writeback_trigger: ZohoWritebackTrigger;
  fetch_recordings_on_sale: boolean;
}

const FALLBACK: ScoringSettings = {
  scoringScope: 'sales_only',
  minScoreableSeconds: MIN_SCOREABLE_DURATION_SECONDS,
  minScoreableWords: MIN_SCOREABLE_WORDS,
  passThreshold: PASS_THRESHOLD,
  scoringSamples: 1,
  reviewConfidenceFloor: 0,
  retentionDays: 1825,
  transcriptionMode: 'mono_diarize',
  monoFirstSpeaker: 'agent',
  deepgramRegion: 'eu',
  deepgramMipOptOut: true,
  // Matches migration 113's column default: the historic behaviour, so a
  // missing org row never silently stops a tenant's records reaching Zoho.
  zohoWritebackTrigger: 'on_scoring',
  // Matches migration 119's column default. Downloading is the safe reading of
  // a missing row: a recording not fetched may never be fetchable again.
  fetchRecordingsOnSale: false,
};

/**
 * Resolve an org's scoring/ingestion policy. Falls back to the pre-tenant-
 * config defaults if the org row is somehow missing (should not happen in
 * practice — every org row has these columns from migration 038 onward).
 */
export async function getScoringSettings(organizationId: string): Promise<ScoringSettings> {
  const row = await queryOne<ScoringSettingsRow>(
    `SELECT scoring_scope, min_scoreable_seconds, min_scoreable_words, pass_threshold,
            retention_days, transcription_mode, mono_first_speaker, deepgram_region,
            deepgram_mip_opt_out, scoring_samples, review_confidence_floor,
            zoho_writeback_trigger, fetch_recordings_on_sale
       FROM organizations WHERE id = $1`,
    [organizationId]
  );
  if (!row) return FALLBACK;
  return {
    scoringScope: row.scoring_scope,
    minScoreableSeconds: row.min_scoreable_seconds,
    minScoreableWords: row.min_scoreable_words,
    passThreshold: Number(row.pass_threshold),
    // Clamped: a bad row value must not multiply every tenant's scoring spend.
    scoringSamples: Math.min(5, Math.max(1, Number(row.scoring_samples) || 1)),
    // Clamped for the mirror-image reason: a floor at or above 1 would send
    // every checkpoint on every sale to the review queue and score nothing.
    reviewConfidenceFloor: Math.min(
      MAX_REVIEW_CONFIDENCE_FLOOR,
      Math.max(0, Number(row.review_confidence_floor) || 0)
    ),
    retentionDays: row.retention_days,
    transcriptionMode: row.transcription_mode,
    monoFirstSpeaker: row.mono_first_speaker,
    deepgramRegion: row.deepgram_region,
    // Floor: never let a bad row value disable the opt-out.
    deepgramMipOptOut: row.deepgram_mip_opt_out !== false,
    // Anything unrecognised falls back to the historic behaviour rather than
    // holding the write-back: a bad value must not quietly stop a tenant's
    // records reaching their CRM.
    zohoWritebackTrigger: row.zoho_writeback_trigger === 'on_feedback' ? 'on_feedback' : 'on_scoring',
    // Same rule as the column's CHECK, applied again here so a row that somehow
    // breaks it downloads recordings rather than silently not fetching them for
    // a firm that scores every call.
    fetchRecordingsOnSale: row.scoring_scope === 'sales_only' && row.fetch_recordings_on_sale === true,
  };
}

/**
 * The org's journey lookback window in days (migration 072), or null when the
 * org has no opinion and the caller should fall back to the dialler
 * connection's history window and then the default. See services/journey.ts for
 * the precedence and why a too-short window is a silent scoring hazard rather
 * than a visible failure.
 *
 * Kept out of getScoringSettings deliberately: that object is loaded on the
 * transcription/scoring path for every call, and this is only needed when a
 * journey is assembled.
 */
export async function getJourneyWindowDays(organizationId: string): Promise<number | null> {
  const row = await queryOne<{ journey_window_days: number | null }>(
    'SELECT journey_window_days FROM organizations WHERE id = $1',
    [organizationId]
  );
  return sanitiseJourneyWindowDays(row?.journey_window_days ?? null);
}

/**
 * Coerce a stored journey_window_days into either a usable window or null
 * ("no opinion — use the fallback").
 *
 * Guarded in code as well as by the column's CHECK constraint, because a value
 * can reach us from a route added later, a manual SQL edit, or a restored
 * backup taken before migration 072. The failure mode is the reason for the
 * belt and braces: a zero or negative window matches no calls at all, so
 * assembleJourney finds nothing and skips the journey silently instead of
 * scoring it badly. Falling back to the default is always the safer reading of
 * a nonsensical value.
 */
export function sanitiseJourneyWindowDays(days: number | null | undefined): number | null {
  if (days === null || days === undefined) return null;
  const n = Number(days);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(Math.floor(n), MAX_JOURNEY_WINDOW_DAYS);
}

export const SCORING_SCOPES: readonly ScoringScope[] = ['sales_only', 'over_threshold', 'everything'];

/**
 * Said whenever a firm is created without a valid scoring_scope. The owner's
 * rule (17 Sep 2026): how a firm is scored is chosen when it is set up, never
 * left to a default. organizations.scoring_scope still has a column default
 * ('sales_only', migration 038) — changing it would buy nothing once every
 * creation path sets the scope explicitly, which is what this enforces.
 */
export const SCORING_SCOPE_CHOICE_MESSAGE =
  'Choose how this firm is scored; there is no default. scoring_scope "sales_only" scores sales: ' +
  "a customer's calls are held, unscored, until a sale arrives (from the CRM, \"Score sale\" or the " +
  'upload sale flag) and are then scored together. "everything" scores calls: every call is scored ' +
  'on its own as it arrives ("over_threshold" is the same, but skips calls under the length threshold).';

/** null when `value` is a valid scoring_scope, otherwise the message to show. */
export function checkScoringScopeChoice(value: unknown): string | null {
  return typeof value === 'string' && (SCORING_SCOPES as readonly string[]).includes(value)
    ? null
    : SCORING_SCOPE_CHOICE_MESSAGE;
}

export const FETCH_RECORDINGS_ON_SALE_SCOPE_MESSAGE =
  'fetch_recordings_on_sale can only be on when scoring_scope is sales_only';

/**
 * Whether a database error is the organizations CHECK that holds the same rule
 * (migration 119). The route validates against the row it read, but two staff
 * saving at once can each pass that check — one turning the flag on, the other
 * moving the firm off sales_only — and the second UPDATE then hits the
 * constraint. That is the same mistake the validation catches, so it should
 * read the same way: a 400 with the same sentence, not a 500.
 */
export function isFetchRecordingsOnSaleScopeViolation(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return (
    !!e &&
    e.code === '23514' &&
    e.constraint === 'organizations_fetch_recordings_on_sale_scope_check'
  );
}

/**
 * Check the shape of a superadmin's fetch_recordings_on_sale change before
 * anything is read from the database: it must be a boolean, and it cannot be
 * switched on in the same request that moves the firm off sales_only. Returns
 * an error message, or null when the body is acceptable so far —
 * resolveFetchRecordingsOnSale finishes the check against the stored row.
 */
export function checkFetchRecordingsOnSaleBody(body: {
  scoring_scope?: unknown;
  fetch_recordings_on_sale?: unknown;
}): string | null {
  if (body.fetch_recordings_on_sale === undefined) return null;
  if (typeof body.fetch_recordings_on_sale !== 'boolean') {
    return 'fetch_recordings_on_sale must be true or false';
  }
  if (
    body.fetch_recordings_on_sale &&
    body.scoring_scope !== undefined &&
    body.scoring_scope !== 'sales_only'
  ) {
    return FETCH_RECORDINGS_ON_SALE_SCOPE_MESSAGE;
  }
  return null;
}

/**
 * Work out what fetch_recordings_on_sale should be after a superadmin's change,
 * given what is stored now, or refuse the change.
 *
 * The rule (also the column's CHECK, migration 119): the flag may only be on
 * for a sales_only firm, because a firm scoring every call needs every
 * recording.
 *
 * Moving a firm off sales_only while the flag is on is REFUSED rather than
 * quietly fixed by switching the flag off. Switching it off is not a neutral
 * tidy-up: from that moment every recording is downloaded and stored as it
 * arrives, including calls with customers who never buy, which is exactly what
 * the firm chose not to have. That has to be a decision somebody makes and the
 * audit log records, so the request must carry fetch_recordings_on_sale: false
 * itself. The superadmin form sends it, visibly, when the scope changes.
 *
 * Returns { value } — the flag to store, or undefined to leave it untouched —
 * or { error } with a message for a 400.
 */
export function resolveFetchRecordingsOnSale(
  current: { scoring_scope: string; fetch_recordings_on_sale: boolean },
  body: { scoring_scope?: string; fetch_recordings_on_sale?: boolean }
): { value: boolean | undefined } | { error: string } {
  const scope = body.scoring_scope ?? current.scoring_scope;
  const flag = body.fetch_recordings_on_sale ?? current.fetch_recordings_on_sale;
  if (flag && scope !== 'sales_only') {
    if (body.fetch_recordings_on_sale === undefined) {
      return {
        error:
          'This firm only downloads recordings when a sale arrives. Moving it off sales_only ' +
          'downloads every recording from then on, so send fetch_recordings_on_sale: false with the change.',
      };
    }
    return { error: FETCH_RECORDINGS_ON_SALE_SCOPE_MESSAGE };
  }
  return { value: body.fetch_recordings_on_sale };
}

/**
 * Whether this firm's scoring setting is one under which calls are scored on
 * their own: any `scoring_scope` but 'sales_only'. Such a firm may feed back on
 * calls (migration 118) and, when it pushes to Zoho on feedback, holds each
 * call's write-back for that feedback.
 *
 * THE ONE PLACE THIS RULE LIVES. The supervisor's call feedback routes
 * (routes/journey-feedback.ts) and the write-back hold (services/
 * score-writeback.ts, holdsCallWritebackForFeedback) both ask this, so the
 * firms that may send a call round and the firms whose calls wait for one can
 * never disagree — a disagreement would hold a call's CRM push for a round
 * nobody is allowed to send.
 *
 * It reads the tenant's setting and nothing else, deliberately. It is not a
 * statement about which calls actually get scored individually: a sales_only
 * firm can still have calls scored one at a time (see deferToSaleTrigger in
 * jobs/processors/transcribe.ts, and an admin's re-score). Whether a CRM
 * integration is connected plays no part in it — that is one tenant's
 * integration, not the firm's choice of what it scores.
 */
export function scoresCallsIndividually(settings: Pick<ScoringSettings, 'scoringScope'>): boolean {
  return settings.scoringScope !== 'sales_only';
}

// ============================================================
// Per-tenant dialer connection (CloudTalk today). Decrypted secrets — for
// internal service use only, never returned from a route directly.
// ============================================================

export interface DialerConnectionRow {
  id: string;
  organization_id: string;
  provider: DialerProvider;
  name: string;
  signing_secret_encrypted: string | null;
  api_key_id_encrypted: string | null;
  api_secret_encrypted: string | null;
  api_base_url: string;
  recording_fetch_delay_seconds: number;
  history_window_days: number;
  field_map: DialerFieldMap;
  is_active: boolean;
}

const DIALER_ROW_COLUMNS = `id, organization_id, provider, name,
  signing_secret_encrypted, api_key_id_encrypted, api_secret_encrypted,
  api_base_url, recording_fetch_delay_seconds, history_window_days,
  field_map, is_active`;

export async function getDialerConnection(
  organizationId: string,
  provider: DialerProvider = 'cloudtalk'
): Promise<DialerConnectionRow | null> {
  return queryOne<DialerConnectionRow>(
    `SELECT ${DIALER_ROW_COLUMNS} FROM dialer_connections
      WHERE organization_id = $1 AND provider = $2 AND is_active = true`,
    [organizationId, provider]
  );
}

/**
 * Verify an inbound dialer webhook's HMAC signature against the org's
 * configured signing secret. The org is already known (from X-API-Key auth
 * on the route) — this is a second, stronger layer on top of key
 * possession, not the sole gate, so existing CloudTalk setups that can't yet
 * send a signature keep working unaffected until a signing secret is set.
 * Returns true if verification is not configured (nothing to check against)
 * OR the signature matches; false only on an explicit mismatch.
 */
export function verifyDialerSignature(
  conn: Pick<DialerConnectionRow, 'signing_secret_encrypted'> | null,
  rawBody: Buffer,
  signatureHeader: string | null | undefined
): boolean {
  if (!conn?.signing_secret_encrypted) return true;
  if (!signatureHeader) return false;

  const secret = decrypt(conn.signing_secret_encrypted);
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const gotBuf = Buffer.from(signatureHeader.replace(/^sha256=/, ''), 'utf8');
  return expectedBuf.length === gotBuf.length && crypto.timingSafeEqual(expectedBuf, gotBuf);
}

export function decryptDialerSecret(encrypted: string): string {
  return decrypt(encrypted);
}

/**
 * Is a feature granted to this organisation, by plan tier or superadmin override?
 *
 * The plan + feature_overrides pair is read in five other places by hand
 * (routes/share.ts, routes/stream.ts twice, routes/auth.ts twice). This is the
 * one place that should own it; those call sites are left alone here rather than
 * migrated in a change about the feedback email.
 *
 * Server-side callers must gate the VALUE, not just its display. routes/share.ts
 * sets that precedent for score_only: "the client hides the badge, but the value
 * must not ship in the payload either". An email is the stronger case — there is
 * no client to hide anything.
 */
export async function orgHasFeature(
  organizationId: string,
  feature: FeatureFlag
): Promise<boolean> {
  const row = await queryOne<{
    plan: string | null;
    feature_overrides: Record<string, boolean> | null;
  }>('SELECT plan, feature_overrides FROM organizations WHERE id = $1', [organizationId]);
  return hasFeature((row?.plan ?? null) as Plan | null, feature, row?.feature_overrides);
}
