import { query, queryOne } from '../db/client.js';
import { scoringQueue } from '../jobs/queue.js';
import { listSaleAttachments, downloadSaleAttachment, type ZohoAttachment } from './zoho.js';
import {
  extractPdfText,
  rankAttachmentCandidates,
  matchProfile,
  parseApplication,
  parseLooksHealthy,
  formatSignature,
  detectDrift,
  type ParseConfig,
  type ParseStrategy,
  type ParsedApplication,
} from './application-pdf.js';
import {
  learnDocumentProfile,
  isPlaceholder,
  type LearnedProfile,
  type ValidationProblem,
} from './document-profile-learner.js';
import { recordUsage } from './usage.js';
import { attemptJobId } from './reconciliation-sweep.js';
import type { QuestionCheckMode } from './reconciliation.js';

// ============================================================
// Reconciliation run orchestration: which document, which profile, and starting
// runs.
//
// Deliberately separate from scoring, exactly as capture-runs.ts is: a
// reconciliation failure never blocks or taints a score, and reconciliation only
// runs for orgs with reconciliation_enabled.
// ============================================================

export interface DocumentProfileRow {
  id: string;
  organization_id: string;
  insurer: string;
  product: string | null;
  strategy: ParseStrategy;
  detect_patterns: string[];
  parse_config: ParseConfig;
  question_fingerprint: string;
  questions: Array<{
    question: string;
    absence_meaningful?: boolean;
    /** Absent on profiles stored before check modes existed; defaulted at read. */
    check_mode?: QuestionCheckMode;
  }>;
  version: number;
  status: 'needs_confirmation' | 'active' | 'superseded';
  /** Migration 090. True for a form that asks conditional follow-ups. */
  questions_vary: boolean;
  /**
   * Who approved this format, or null where it went live by corroboration.
   *
   * Read at judgement time, not just for display: the per-question rulings
   * stored on a profile outrank the measured defaults only because a person
   * made them. On an auto-confirmed profile nobody did, so those values are a
   * stale copy of the heuristics and must not outrank the current ones.
   */
  confirmed_by: string | null;
}

export async function isReconciliationEnabled(organizationId: string): Promise<boolean> {
  const row = await queryOne<{ reconciliation_enabled: boolean }>(
    'SELECT reconciliation_enabled FROM organizations WHERE id = $1',
    [organizationId]
  );
  return row?.reconciliation_enabled === true;
}

export async function getActiveProfiles(organizationId: string): Promise<DocumentProfileRow[]> {
  return query<DocumentProfileRow>(
    `SELECT * FROM capture_document_profiles
      WHERE organization_id = $1 AND status = 'active'
      ORDER BY insurer, product`,
    [organizationId]
  );
}

/**
 * Formats proposed but not yet live.
 *
 * Matched against BEFORE a new document is sent to the model, because "have we
 * already proposed this format" is the same question as "does this document
 * match that profile" — and matchProfile is the thing that answers it. Comparing
 * the model's own descriptions of two documents does not work: asked to describe
 * the same format twice it picks different literal strings each time, so three
 * MetLife sales produced three separate proposals for one format. Testing the
 * document against the stored patterns is stable, because it asks about the
 * document rather than about the model.
 */
export async function getPendingProfiles(organizationId: string): Promise<DocumentProfileRow[]> {
  return query<DocumentProfileRow>(
    `SELECT * FROM capture_document_profiles
      WHERE organization_id = $1 AND status = 'needs_confirmation'
      ORDER BY created_at DESC`,
    [organizationId]
  );
}

/**
 * A second sale reached a format already waiting to be confirmed.
 *
 * That agreement is the whole basis for going live unattended: a model misread
 * cannot be reproduced from a different customer's document, so two independent
 * sales matching the same stored patterns is evidence no single proposal can
 * provide about itself.
 *
 * Parsing here as well is not redundant. A different question set from the same
 * patterns is exactly what a form with conditional follow-ups looks like, and it
 * is only visible once a second document exists to compare — which makes this
 * the one place questions_vary can be established rather than guessed.
 */
async function corroborate(
  profile: DocumentProfileRow,
  journeyId: string,
  text: string
): Promise<{ journeys: string[]; activated: boolean }> {
  const row = await queryOne<{ corroborating_journeys: string[] }>(
    'SELECT corroborating_journeys FROM capture_document_profiles WHERE id = $1',
    [profile.id]
  );
  const journeys = [...new Set([...(row?.corroborating_journeys ?? []), journeyId])];

  const parsed = parseApplication(text, profile.strategy, profile.parse_config);
  const varies = profile.questions_vary || parsed.fingerprint !== profile.question_fingerprint;

  await query(
    `UPDATE capture_document_profiles
        SET corroborating_journeys = $2::uuid[], questions_vary = $3, updated_at = now()
      WHERE id = $1`,
    [profile.id, journeys, varies]
  );

  // The parse has to still work on the second document, or the agreement is
  // only that both documents look alike — not that we can read either.
  const broken = parseLooksHealthy(parsed);
  if (broken) {
    console.warn(
      `[Reconciliation] ${profile.id} matched journey ${journeyId} but ${broken} — not activating`
    );
    return { journeys, activated: false };
  }

  if (journeys.length < CORROBORATION_THRESHOLD) return { journeys, activated: false };
  const activated = await activateProfile(profile.organization_id, profile.id, { auto: true });
  return { journeys, activated: activated !== null };
}

/**
 * Why a document could not be resolved. Each maps to a run status, and the
 * distinction matters: 'no_attachments' is the ordinary case of the pack not
 * having been uploaded yet, whereas 'no_profile_match' means a human needs to
 * teach the system a new insurer's format.
 */
export type ResolutionFailure =
  | 'not_configured'
  | 'no_attachments'
  /** Documents ARE attached; the ranking rejected every one. See below. */
  | 'no_usable_attachment'
  | 'no_profile_match'
  | 'drifted';

export interface ResolvedDocument {
  attachment: ZohoAttachment;
  profile: DocumentProfileRow;
  parsed: ParsedApplication;
  text: string;
}

export interface ResolutionResult {
  document: ResolvedDocument | null;
  failure: ResolutionFailure | null;
  /** Candidates inspected, for a human deciding what to do about a failure. */
  candidates: ZohoAttachment[];
  /**
   * How many active profiles the document was tested against. 0 means the
   * tenant has not set up a single format yet, which is a different problem
   * from a document that failed to match the ones they have — undefined where
   * the resolution ended before the profiles were loaded.
   */
  profilesAvailable?: number;
  /** Populated when the failure is 'drifted'. */
  drift?: {
    profile: DocumentProfileRow;
    added: string[];
    removed: string[];
    reordered: boolean;
    /**
     * Set instead of added/removed when the profile's questions are marked as
     * varying: there is no question-set change to report, the parse itself
     * stopped working. Carries the reason.
     */
    brokenReason?: string;
  };
}

/**
 * Find and parse the application for a sale.
 *
 * Downloads candidates in ranked order and stops at the first whose CONTENT
 * matches a known profile. Filenames only decide the order — the two real naming
 * conventions seen ("Client review for <name>.pdf", "Application Details (5).pdf")
 * share no pattern, and the firm's own suitability report sits alongside looking
 * plausible, so content is the only safe test.
 *
 * Never learns a new profile on its own. An unrecognised document stops with
 * 'no_profile_match' for a human to look at, rather than running a model against
 * every attachment on every sale and possibly learning a profile from the wrong
 * document.
 */
export async function resolveApplicationDocument(
  organizationId: string,
  zohoRecordId: string
): Promise<ResolutionResult> {
  const { configured, attachments } = await listSaleAttachments(organizationId, zohoRecordId);
  if (!configured) return { document: null, failure: 'not_configured', candidates: [] };
  if (attachments.length === 0) return { document: null, failure: 'no_attachments', candidates: [] };

  const profiles = await getActiveProfiles(organizationId);
  const candidates = rankAttachmentCandidates(attachments);
  if (candidates.length === 0) {
    // Attachments exist, the ranking dropped all of them — a link rather than
    // an upload, or a photograph of the form. Telling the firm nothing is
    // attached sends them to look at a record where they can plainly see one.
    return {
      document: null,
      failure: 'no_usable_attachment',
      candidates: attachments,
      profilesAvailable: profiles.length,
    };
  }

  for (const attachment of candidates) {
    let text: string;
    try {
      const buffer = await downloadSaleAttachment(organizationId, zohoRecordId, attachment.id);
      text = await extractPdfText(buffer);
    } catch (err) {
      // One unreadable attachment must not abandon the sale — a scanned or
      // corrupt file sitting alongside the real application is entirely normal.
      console.warn(
        `[Reconciliation] Could not read attachment ${attachment.file_name}: ${(err as Error).message}`
      );
      continue;
    }

    const profile = matchProfile(text, profiles);
    if (!profile) continue;

    const parsed = parseApplication(text, profile.strategy, profile.parse_config);

    // A form that asks conditional follow-ups has no fixed question set to drift
    // FROM. The same broker-portal export produced between 23 and 95 questions
    // across eight of one tenant's sales, purely because customers with more to
    // disclose are asked more. Comparing that against a stored list parks every
    // sale after the first for a review with nothing in it.
    //
    // Safe because reconciliation reads its questions from this sale's document
    // rather than from the profile (see processors/reconcile.ts). What a stale
    // profile actually risks here is the parse breaking, so that is what gets
    // checked — see migration 090 for the full reasoning.
    if (profile.questions_vary) {
      const broken = parseLooksHealthy(parsed);
      if (broken) {
        return {
          document: null,
          failure: 'drifted',
          candidates,
          profilesAvailable: profiles.length,
          drift: {
            profile,
            added: [],
            removed: [],
            reordered: false,
            brokenReason: broken,
          },
        };
      }
      return {
        document: { attachment, profile, parsed, text },
        failure: null,
        candidates,
        profilesAvailable: profiles.length,
      };
    }

    // The fingerprint is the cache-validity check and the drift detector in one.
    // A mismatch means the insurer changed their question set, and nothing is
    // judged against a stale profile — a removed question would read as missed on
    // every sale, and a new one would go unchecked entirely.
    if (parsed.fingerprint !== profile.question_fingerprint) {
      const drift = detectDrift(
        (profile.questions ?? []).map((q) => q.question),
        parsed.pairs.map((p) => p.question)
      );
      return {
        document: null,
        failure: 'drifted',
        candidates,
        profilesAvailable: profiles.length,
        drift: { profile, ...drift },
      };
    }

    return {
      document: { attachment, profile, parsed, text },
      failure: null,
      candidates,
      profilesAvailable: profiles.length,
    };
  }

  return {
    document: null,
    failure: 'no_profile_match',
    candidates,
    profilesAvailable: profiles.length,
  };
}

// ============================================================
// Learning a profile from a sale's document.
//
// The ONLY way a profile enters the system. Deliberately manual: resolveApplicationDocument
// never learns on its own, because doing so would run a model over every
// attachment on every sale and could learn a profile from the firm's own
// suitability report, which sits in the same pack and looks plausible.
//
// Nothing learned here is ever used to judge a sale until a human confirms it —
// it lands as 'needs_confirmation' and PUT /profiles/:id/confirm promotes it.
// ============================================================

/**
 * How many documents in a pack are worth a model pass before settling for the
 * best seen so far. Packs run to nine attachments; the application has never
 * been below the fourth once ranking has had its say.
 */
const MAX_LEARN_CANDIDATES = 5;

/**
 * How good a candidate document is, as the thing to reconcile a sale against.
 *
 * Selecting the FIRST document that verifies cleanly is wrong, and measurably
 * so. Run over a real pack it dropped a 39-question health-and-lifestyle
 * questionnaire in favour of a 7-field quote summary, purely because the
 * questionnaire does not name its insurer and so failed verification. The pack
 * that has both is exactly the pack where the choice matters.
 *
 * So disclosures dominate everything else. A document that asks the customer
 * about their health beats a clean administrative summary even when it needs a
 * human to finish it off, because the point of the module is checking what the
 * customer disclosed. A sale whose best document merely needs its insurer named
 * is in a far better place than one quietly reconciling a quote sheet.
 */
function candidateScore(learned: LearnedProfile): number {
  return (
    (learned.hasDisclosureQuestions ? 1_000_000 : 0) +
    (learned.usable ? 1_000 : 0) +
    Math.min(learned.questions.length, 999)
  );
}

export type LearnFailure =
  | 'not_configured'
  | 'no_attachments'
  | 'attachment_not_found'
  | 'unreadable'
  | 'unusable';

export interface LearnOutcome {
  profileId: string | null;
  failure: LearnFailure | null;
  /** Which attachment was read, so a reviewer can tell it was the right one. */
  attachment: ZohoAttachment | null;
  /** Everything considered, ranked — the UI offers these if we picked wrong. */
  candidates: ZohoAttachment[];
  problems: ValidationProblem[];
  /** The model's own account of how it read the document. */
  notes: string | null;
  insurer: string | null;
  product: string | null;
  questionCount: number;
  /** True when an identical profile was already awaiting confirmation. */
  reusedExisting: boolean;
}

/**
 * Read a sale's application document and propose a profile for it.
 *
 * Covers both cases that need one: a format never seen before, and a format
 * whose question set has drifted. They are the same operation — parse the
 * document as it is now, and put the result in front of a human.
 */
export async function learnProfileFromSale(
  organizationId: string,
  journeyId: string,
  zohoRecordId: string,
  attachmentId: string | null = null
): Promise<LearnOutcome> {
  const empty = {
    profileId: null,
    attachment: null,
    candidates: [] as ZohoAttachment[],
    problems: [] as ValidationProblem[],
    notes: null,
    insurer: null,
    product: null,
    questionCount: 0,
    reusedExisting: false,
  };

  const { configured, attachments } = await listSaleAttachments(organizationId, zohoRecordId);
  if (!configured) return { ...empty, failure: 'not_configured' };

  const candidates = rankAttachmentCandidates(attachments);
  if (candidates.length === 0) {
    return { ...empty, failure: 'no_attachments', candidates: [] };
  }

  // An explicit pick wins outright: it means a human looked at the ranking and
  // disagreed with it, which is the whole reason the picker exists.
  let chosen: ZohoAttachment | null = null;
  let text: string | null = null;

  if (attachmentId) {
    const pick = candidates.find((c) => c.id === attachmentId);
    if (!pick) return { ...empty, failure: 'attachment_not_found', candidates };
    try {
      const buffer = await downloadSaleAttachment(organizationId, zohoRecordId, attachmentId);
      text = await extractPdfText(buffer);
      chosen = pick;
    } catch (err) {
      console.warn(`[Reconciliation] Could not read ${pick.file_name}: ${(err as Error).message}`);
      return { ...empty, failure: 'unreadable', candidates, attachment: pick };
    }
  }

  let learned: LearnedProfile | null = null;

  if (chosen && text !== null) {
    const run = await learnDocumentProfile(text);
    learned = run.learned;
    await recordUsage({
      organizationId,
      provider: 'anthropic',
      operation: 'reconcile',
      modelId: run.model,
      inputTokens: run.usage.input_tokens,
      outputTokens: run.usage.output_tokens,
    });
  } else {
    // No explicit pick: work DOWN the ranking until a document actually yields a
    // usable profile, rather than stopping at the first one that merely opens.
    //
    // Reading only the top candidate looked equivalent, because ranking is meant
    // to put the application first. On a real pack it is not: a sanctions search
    // named "<Name>-ss.pdf" and a trustee form both read perfectly well, produce
    // no question set, and outranked the actual application on 4 of 13 sales.
    // The application was sitting at rank 1 or 2 the whole time, and the tenant
    // was told their document could not be parsed.
    //
    // Ranking still decides the ORDER, so the common case costs exactly one
    // model pass. Only a pack whose best guess turns out to be the wrong
    // document pays for a second look, which is precisely when it is worth it.
    let best = -1;
    const attempts: string[] = [];
    const pending = await getPendingProfiles(organizationId);
    for (const candidate of candidates.slice(0, MAX_LEARN_CANDIDATES)) {
      let candidateText: string;
      try {
        const buffer = await downloadSaleAttachment(organizationId, zohoRecordId, candidate.id);
        candidateText = await extractPdfText(buffer);
      } catch (err) {
        console.warn(
          `[Reconciliation] Could not read ${candidate.file_name}: ${(err as Error).message}`
        );
        continue;
      }

      // Already-proposed formats are tested first, and on the document rather
      // than on a fresh description of it. Cheaper — no model pass at all — and
      // more reliable, since the same document described twice does not
      // describe itself the same way.
      const already = matchProfile(candidateText, pending);
      if (already) {
        const { journeys, activated } = await corroborate(already, journeyId, candidateText);
        console.log(
          `[Reconciliation] ${candidate.file_name} matches pending format ${already.id} ` +
            `(${journeys.length} sale(s) agree)${activated ? ' — now live' : ''}`
        );
        return {
          ...empty,
          failure: null,
          profileId: already.id,
          attachment: candidate,
          candidates,
          insurer: already.insurer,
          product: already.product,
          questionCount: already.questions?.length ?? 0,
          reusedExisting: true,
        };
      }

      const run = await learnDocumentProfile(candidateText);
      await recordUsage({
        organizationId,
        provider: 'anthropic',
        operation: 'reconcile',
        modelId: run.model,
        inputTokens: run.usage.input_tokens,
        outputTokens: run.usage.output_tokens,
      });

      const score = candidateScore(run.learned);
      attempts.push(`${candidate.file_name}(${score})`);
      if (score > best) {
        best = score;
        chosen = candidate;
        text = candidateText;
        learned = run.learned;
      }

      // The ideal outcome: a document that asks the customer things AND parses
      // cleanly. Nothing further down a pack can beat it, so stop paying for
      // model passes.
      if (run.learned.usable && run.learned.hasDisclosureQuestions) break;
    }

    if (!chosen || text === null || !learned) {
      return { ...empty, failure: 'unreadable', candidates };
    }
    console.log(
      `[Reconciliation] chose ${chosen.file_name} from ${attempts.length} candidate(s): ` +
        attempts.join(', ')
    );
  }

  const base = {
    ...empty,
    attachment: chosen,
    candidates,
    problems: learned.problems,
    notes: learned.proposal.notes,
    insurer: learned.proposal.insurer,
    product: learned.proposal.product,
    questionCount: learned.questions.length,
  };

  // A proposal that fails its own verification is reported, never stored. Putting
  // it in the confirmation queue would invite someone to approve a config that has
  // already been shown to mis-read the document.
  if (!learned.usable) return { ...base, failure: 'unusable' };

  const signature = formatSignature(learned.proposal.strategy, learned.proposal.detect_patterns);

  // Have we met this FORM before, whatever question set this particular copy of
  // it happens to carry? Keyed on the signature rather than the question
  // fingerprint, because a form with conditional follow-ups produces a different
  // fingerprint on every sale and would otherwise queue a fresh proposal each
  // time — 8 sales of one tenant's portal export produced 8 distinct question
  // sets between 23 and 95 questions.
  const existing = await queryOne<{
    id: string;
    status: string;
    question_fingerprint: string;
    questions_vary: boolean;
    corroborating_journeys: string[];
  }>(
    `SELECT id, status, question_fingerprint, questions_vary, corroborating_journeys
       FROM capture_document_profiles
      WHERE organization_id = $1 AND format_signature = $2
        AND status IN ('needs_confirmation', 'active')
      ORDER BY status = 'active' DESC, created_at DESC
      LIMIT 1`,
    [organizationId, signature]
  );

  if (existing) {
    // A DIFFERENT sale reaching the same format is the corroboration that lets
    // it go live without anyone approving it. The same sale re-read (an admin
    // clicking twice) proves nothing and must not count towards the threshold.
    const corroborated = [...new Set([...existing.corroborating_journeys, journeyId])];

    // Same form, different question set, and it parsed cleanly. Nothing changed
    // at the insurer — this form asks different questions depending on the
    // answers, and that is the only way to find out, because one copy of a
    // document cannot tell you what a different customer would have been asked.
    const varies =
      existing.questions_vary || existing.question_fingerprint !== learned.fingerprint;

    await query(
      `UPDATE capture_document_profiles
          SET corroborating_journeys = $2::uuid[], questions_vary = $3, updated_at = now()
        WHERE id = $1`,
      [existing.id, corroborated, varies]
    );

    if (existing.status === 'needs_confirmation' && corroborated.length >= CORROBORATION_THRESHOLD) {
      await activateProfile(organizationId, existing.id, { auto: true });
    }
    return { ...base, failure: null, profileId: existing.id, reusedExisting: true };
  }

  // Version numbers run per insurer+product across all statuses, so a superseded
  // v2 is never confusable with a fresh v2 for the same document.
  const previous = await queryOne<{ max: number | null }>(
    `SELECT max(version) AS max FROM capture_document_profiles
      WHERE organization_id = $1 AND insurer = $2 AND COALESCE(product, '') = COALESCE($3, '')`,
    [organizationId, learned.proposal.insurer, learned.proposal.product]
  );

  const created = await queryOne<{ id: string }>(
    `INSERT INTO capture_document_profiles
       (organization_id, insurer, product, strategy, detect_patterns, parse_config,
        question_fingerprint, questions, version, status, learned_from_journey_id,
        format_signature, corroborating_journeys)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, 'needs_confirmation', $10,
             $11, ARRAY[$10]::uuid[])
     RETURNING id`,
    [
      organizationId,
      learned.proposal.insurer,
      learned.proposal.product,
      learned.proposal.strategy,
      JSON.stringify(learned.proposal.detect_patterns),
      JSON.stringify(learned.proposal.parse_config),
      learned.fingerprint,
      JSON.stringify(learned.questions),
      (previous?.max ?? 0) + 1,
      journeyId,
      signature,
    ]
  );

  return { ...base, failure: null, profileId: created?.id ?? null };
}

/**
 * How many DIFFERENT sales must produce the same format before it goes live on
 * its own.
 *
 * Two, not one. One document agreeing with itself is not evidence — the learner
 * is a model pass and its output genuinely varies run to run, so a single clean
 * proposal can be a one-off misread that looks perfect. Two independent sales
 * reaching the same strategy and the same detect patterns is something a misread
 * cannot fake.
 *
 * Not higher, because the cost of waiting is real: a format seen on only one
 * sale so far would sit unconfirmed while that sale goes unchecked, and most
 * formats do arrive more than once.
 */
const CORROBORATION_THRESHOLD = 2;

/**
 * Make a profile live, and release every sale that was waiting for it.
 *
 * One function for both routes in, deliberately. A person confirming and
 * corroboration confirming must supersede the same way, requeue the same sales
 * and leave the same audit trail — the only difference being who is recorded as
 * responsible, which is exactly the thing that must not drift between two
 * copies of this logic.
 *
 * `auto` sets auto_confirmed_at and leaves confirmed_by NULL, so nothing can
 * later present a machine's decision as a named person's approval.
 */
export async function activateProfile(
  organizationId: string,
  profileId: string,
  opts: { auto: true } | { auto: false; userId: string }
): Promise<{ insurer: string; product: string | null; requeued: number } | null> {
  const profile = await queryOne<{
    insurer: string;
    product: string | null;
    format_signature: string | null;
  }>(
    `SELECT insurer, product, format_signature FROM capture_document_profiles
      WHERE id = $1 AND organization_id = $2 AND status = 'needs_confirmation'`,
    [profileId, organizationId]
  );
  if (!profile) return null;

  // An active profile is uniquely keyed on insurer+product, and a broker portal
  // export names no insurer at all. Two such formats going live would therefore
  // collide: the supersede below matches on insurer+product, so activating the
  // second would silently retire the first and every sale on it would stop being
  // read. Nothing would report that, because retiring a superseded profile is
  // exactly what confirming a new version is supposed to do.
  //
  // So an unnamed format is given a name it cannot share — derived from the
  // format signature, which is what actually makes it distinct. Honest about
  // what it is, stable across runs, and a person can rename it later without
  // anything breaking, because the signature is what matching uses.
  if (isPlaceholder(profile.insurer)) {
    const suffix = (profile.format_signature ?? profileId).slice(0, 8);
    const insurer = 'Unidentified insurer';
    const product = `Format ${suffix}`;
    await query(
      `UPDATE capture_document_profiles SET insurer = $2, product = $3, updated_at = now()
        WHERE id = $1`,
      [profileId, insurer, product]
    );
    profile.insurer = insurer;
    profile.product = product;
  }

  await query(
    `UPDATE capture_document_profiles
        SET status = 'superseded', superseded_at = now(), updated_at = now()
      WHERE organization_id = $1 AND insurer = $2
        AND COALESCE(product, '') = COALESCE($3, '')
        AND status = 'active'`,
    [organizationId, profile.insurer, profile.product]
  );
  await query(
    `UPDATE capture_document_profiles
        SET status = 'active',
            confirmed_by = $2,
            confirmed_at = now(),
            auto_confirmed_at = CASE WHEN $2::uuid IS NULL THEN now() ELSE NULL END,
            updated_at = now()
      WHERE id = $1`,
    [profileId, opts.auto ? null : opts.userId]
  );

  // Sales parked on the old question set — and any whose format we had never
  // seen — can now be reconciled. Completed MODEL-read runs are re-queued too:
  // the model fallback is explicitly provisional, and a live profile is the
  // deterministic re-read it has been waiting for. processReconcile lets those
  // runs through its already-finished guard on exactly this condition.
  const waiting = await query<{ id: string; attempts: number }>(
    `SELECT id, attempts FROM capture_reconciliation_runs
      WHERE organization_id = $1
        AND (status = 'needs_profile'
             OR (status = 'completed' AND extraction_method = 'model'))`,
    [organizationId]
  );
  for (const run of waiting) {
    await scoringQueue.add('reconcile', { runId: run.id }, { jobId: attemptJobId(run.id, run.attempts) });
  }

  return { insurer: profile.insurer, product: profile.product, requeued: waiting.length };
}

/** Run status implied by a resolution failure. */
export function statusForFailure(failure: ResolutionFailure): string {
  switch (failure) {
    case 'drifted':
    case 'no_profile_match':
      // Both need the same human act: read the document as it is now and confirm
      // how to parse it. 'drifted' is a format we know whose questions changed,
      // 'no_profile_match' one we have never seen — the panel tells them apart on
      // whether the run carries a profile_id.
      //
      // Keeping these apart from 'needs_document' matters more than it looks: the
      // sweep retries waiting runs, and an unrecognised format would otherwise be
      // re-downloaded and re-parsed on every tick to reach the same conclusion,
      // when what it actually needs is a person, once.
      return 'needs_profile';
    case 'no_attachments':
    case 'no_usable_attachment':
    case 'not_configured':
    default:
      // Genuinely waiting: the pack is attached by hand after the call, so a
      // promptly-scored sale legitimately lands here and is retried on a cadence
      // until it arrives or the window closes (services/reconciliation-sweep.ts).
      return 'needs_document';
  }
}

/**
 * Create (or reuse) a reconciliation run for a scored journey and enqueue it.
 *
 * Idempotent on the partial unique index over journey_id. Fire-and-forget from
 * scoring: errors are logged, never thrown into the scoring path.
 */
export async function maybeStartReconciliation(
  organizationId: string,
  journeyId: string
): Promise<void> {
  try {
    if (!(await isReconciliationEnabled(organizationId))) return;

    const journey = await queryOne<{ zoho_record_id: string | null }>(
      'SELECT zoho_record_id FROM journeys WHERE id = $1 AND organization_id = $2',
      [journeyId, organizationId]
    );
    if (!journey) return;
    if (!journey.zoho_record_id) {
      // No CRM record means no attachment to fetch. Nothing to reconcile, and
      // not worth a row that will sit in the attention queue forever.
      console.log(`[Reconciliation] Journey ${journeyId} has no zoho_record_id — skipping`);
      return;
    }

    const existing = await queryOne<{ id: string; status: string; attempts: number }>(
      `SELECT id, status, attempts FROM capture_reconciliation_runs
        WHERE journey_id = $1 AND status <> 'failed'`,
      [journeyId]
    );
    if (existing) {
      // Terminal states are left alone. 'abandoned' belongs here: the sweep gave
      // up after the document never arrived, and quietly restarting it would put
      // the sale back into a waiting state nobody asked to reopen. Re-running it
      // is a deliberate act, via the admin re-run.
      if (
        existing.status === 'completed' ||
        existing.status === 'summary_only' ||
        existing.status === 'abandoned'
      ) {
        return;
      }
      // 'needs_profile' waits on a person, not on us: requeueing it would
      // re-download and re-parse to reach the same answer. Confirming the profile
      // is what releases it (routes/reconciliation.ts).
      if (existing.status === 'needs_profile') return;

      // A waiting run is retried, since the document may have been uploaded since.
      await scoringQueue.add(
        'reconcile',
        { runId: existing.id },
        { jobId: attemptJobId(existing.id, existing.attempts) }
      );
      return;
    }

    const created = await queryOne<{ id: string; attempts: number }>(
      `INSERT INTO capture_reconciliation_runs (organization_id, journey_id, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (journey_id) WHERE status <> 'failed' DO NOTHING
       RETURNING id, attempts`,
      [organizationId, journeyId]
    );
    if (!created) return;

    await scoringQueue.add(
      'reconcile',
      { runId: created.id },
      { jobId: attemptJobId(created.id, created.attempts) }
    );
  } catch (err) {
    console.error(
      `[Reconciliation] Failed to start run for journey ${journeyId}:`,
      (err as Error).message
    );
  }
}
