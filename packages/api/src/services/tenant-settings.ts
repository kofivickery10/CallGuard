import crypto from 'crypto';
import { queryOne } from '../db/client.js';
import { decrypt } from './crypto.js';
import {
  MIN_SCOREABLE_WORDS,
  MIN_SCOREABLE_DURATION_SECONDS,
  PASS_THRESHOLD,
} from '@callguard/shared';
import type {
  ScoringScope,
  TranscriptionMode,
  MonoFirstSpeaker,
  DeepgramRegion,
  DialerProvider,
  DialerFieldMap,
} from '@callguard/shared';

// ============================================================
// Per-tenant scoring/ingestion policy. Reads the organizations row (see
// migration 038); the columns' DB defaults reproduce the previous global
// constants exactly, so this always resolves to a value — there is no
// fallback-to-constant branch needed here, only at the column-default level.
// The constants above stay in shared as the canonical floor/default value
// new orgs are created with (see db/migrations/038 and scripts/seed-demo.ts).
// ============================================================

export interface ScoringSettings {
  scoringScope: ScoringScope;
  minScoreableSeconds: number;
  minScoreableWords: number;
  passThreshold: number;
  retentionDays: number;
  transcriptionMode: TranscriptionMode;
  monoFirstSpeaker: MonoFirstSpeaker;
  deepgramRegion: DeepgramRegion;
  deepgramMipOptOut: boolean;
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
}

const FALLBACK: ScoringSettings = {
  scoringScope: 'sales_only',
  minScoreableSeconds: MIN_SCOREABLE_DURATION_SECONDS,
  minScoreableWords: MIN_SCOREABLE_WORDS,
  passThreshold: PASS_THRESHOLD,
  retentionDays: 1825,
  transcriptionMode: 'mono_diarize',
  monoFirstSpeaker: 'agent',
  deepgramRegion: 'eu',
  deepgramMipOptOut: true,
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
            deepgram_mip_opt_out
       FROM organizations WHERE id = $1`,
    [organizationId]
  );
  if (!row) return FALLBACK;
  return {
    scoringScope: row.scoring_scope,
    minScoreableSeconds: row.min_scoreable_seconds,
    minScoreableWords: row.min_scoreable_words,
    passThreshold: Number(row.pass_threshold),
    retentionDays: row.retention_days,
    transcriptionMode: row.transcription_mode,
    monoFirstSpeaker: row.mono_first_speaker,
    deepgramRegion: row.deepgram_region,
    // Floor: never let a bad row value disable the opt-out.
    deepgramMipOptOut: row.deepgram_mip_opt_out !== false,
  };
}

/**
 * Whether the org has a Zoho sale trigger that can actually drive journey
 * scoring — an active connection that the admin has marked as having a
 * configured trigger, either by setting a signing secret (the HMAC path) OR
 * by ticking sale_trigger_enabled (the API-key-only path, for Zoho's plain
 * Webhook action which can't sign). Used to decide whether 'sales_only'
 * deferral is safe: deferring scoring (or, now, capturing calls metadata-only)
 * with no working trigger would silently stop scoring forever, so callers fall
 * back to scoring immediately when this is false. Shared by
 * jobs/processors/transcribe.ts and the CloudTalk webhook capture branch
 * (routes/ingestion.ts).
 */
export async function hasUsableSaleTrigger(organizationId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM zoho_connections
      WHERE organization_id = $1 AND status = 'active'
        AND (inbound_secret_encrypted IS NOT NULL OR sale_trigger_enabled = true)`,
    [organizationId]
  );
  return !!row;
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
