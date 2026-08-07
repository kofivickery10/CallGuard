import { query, queryOne } from '../db/client.js';
import { scoringQueue } from '../jobs/queue.js';
import { listSaleAttachments, downloadSaleAttachment, type ZohoAttachment } from './zoho.js';
import {
  extractPdfText,
  rankAttachmentCandidates,
  matchProfile,
  parseApplication,
  detectDrift,
  type ParseConfig,
  type ParseStrategy,
  type ParsedApplication,
} from './application-pdf.js';
import { learnDocumentProfile, type ValidationProblem } from './document-profile-learner.js';
import { recordUsage } from './usage.js';
import { attemptJobId } from './reconciliation-sweep.js';

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
  questions: Array<{ question: string; absence_meaningful?: boolean }>;
  version: number;
  status: 'needs_confirmation' | 'active' | 'superseded';
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
 * Why a document could not be resolved. Each maps to a run status, and the
 * distinction matters: 'no_attachments' is the ordinary case of the pack not
 * having been uploaded yet, whereas 'no_profile_match' means a human needs to
 * teach the system a new insurer's format.
 */
export type ResolutionFailure =
  | 'not_configured'
  | 'no_attachments'
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
  /** Populated when the failure is 'drifted'. */
  drift?: { profile: DocumentProfileRow; added: string[]; removed: string[]; reordered: boolean };
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
  if (candidates.length === 0) return { document: null, failure: 'no_attachments', candidates: attachments };

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

    // The fingerprint is the cache-validity check and the drift detector in one.
    // A mismatch means the insurer changed their question set, and nothing is
    // judged against a stale profile — a removed question would read as missed on
    // every sale, and a new one would go unchecked entirely.
    if (parsed.fingerprint !== profile.question_fingerprint) {
      const drift = detectDrift(
        (profile.questions ?? []).map((q) => q.question),
        parsed.pairs.map((p) => p.question)
      );
      return { document: null, failure: 'drifted', candidates, drift: { profile, ...drift } };
    }

    return { document: { attachment, profile, parsed, text }, failure: null, candidates };
  }

  return { document: null, failure: 'no_profile_match', candidates };
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
  } else {
    // No pick: take the highest-ranked one we can actually read. A scanned or
    // corrupt file at the top of the ranking must not stop the whole operation.
    for (const candidate of candidates) {
      try {
        const buffer = await downloadSaleAttachment(organizationId, zohoRecordId, candidate.id);
        text = await extractPdfText(buffer);
        chosen = candidate;
        break;
      } catch (err) {
        console.warn(
          `[Reconciliation] Could not read ${candidate.file_name}: ${(err as Error).message}`
        );
      }
    }
    if (!chosen || text === null) return { ...empty, failure: 'unreadable', candidates };
  }

  const { learned, usage, model } = await learnDocumentProfile(text);
  await recordUsage({
    organizationId,
    provider: 'anthropic',
    operation: 'reconcile',
    modelId: model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  });

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

  // The same document learned twice — an admin clicking again, or two sales with
  // the same unrecognised format — should not fill the queue with duplicates.
  const duplicate = await queryOne<{ id: string }>(
    `SELECT id FROM capture_document_profiles
      WHERE organization_id = $1 AND question_fingerprint = $2 AND status = 'needs_confirmation'
      ORDER BY created_at DESC LIMIT 1`,
    [organizationId, learned.fingerprint]
  );
  if (duplicate) return { ...base, failure: null, profileId: duplicate.id, reusedExisting: true };

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
        question_fingerprint, questions, version, status, learned_from_journey_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, 'needs_confirmation', $10)
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
    ]
  );

  return { ...base, failure: null, profileId: created?.id ?? null };
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
