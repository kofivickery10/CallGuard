import { Router } from 'express';
import { authenticate, requireOrgView, requireActioner } from '../middleware/auth.js';
import { query, queryOne, withTransaction } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { recordAuditEvent } from '../services/audit.js';
import { getScoringSettings, orgHasFeature } from '../services/tenant-settings.js';
import { pushCallScoreUpdate, pushJourneyScoreUpdate } from '../services/score-writeback.js';
import { evaluateAlertsForResolvedItem } from '../services/alert-evaluator.js';
import { locateEvidence } from '../services/evidence-locator.js';
import { mayShowEvidenceExcerpt, resolveTranscriptAccess } from '../services/transcript-access.js';
import { deriveSeverity, isItemPass, callPasses, REVIEW_SEVERITIES } from '@callguard/shared';
import type {
  ManualReviewItem,
  BreachSeverity,
  EvidenceLocation,
  ReviewQueueResponse,
  ReviewQueueSort,
  ReviewQueueSummary,
  ReviewSeverity,
} from '@callguard/shared';

export const reviewRouter = Router();
reviewRouter.use(authenticate);

// Hard ceiling on what one request will assemble, per kind. This queue is a
// human backlog — the largest live tenant sits at 130 checkpoints — so no firm
// is legitimately near this; it exists so a runaway scoring run cannot turn the
// endpoint into a whole-table read shipped down the wire, which is what it was
// before (no LIMIT at all). Both queries order oldest-first, so if the ceiling
// ever did bite, what it dropped would be the newest checkpoints, never the
// ones that have been waiting.
const QUEUE_CEILING = 2000;

// Sales per page. The page unit is the SALE, not the checkpoint: one live sale
// holds 41 of those 130, and a page boundary through the middle of it would
// make the grouping this queue is built on a lie.
const DEFAULT_SALES_PER_PAGE = 10;
const MAX_SALES_PER_PAGE = 50;

// GET /api/review-items — checkpoints awaiting human sign-off: manual items and
// consent gates routed to manual_review. Spans per-call and journey scoring.
//
// Grouped by the sale (or call) they sit on, longest wait first, filterable by
// adviser and severity, and paged by sale. It also reports what the WHOLE queue
// holds (`summary`), whatever the filters say, because these checkpoints are
// holes in published scores rather than a to-do list: one awaiting a ruling is
// out of its parent's denominator, so the screen has to be able to state the
// backlog in totals no filter can shrink.
reviewRouter.get('/', requireOrgView, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;

    // score_only gates the VALUE, not just its display (services/
    // tenant-settings.ts), exactly as the sale and call lists do: the AI's
    // provisional verdict must not ship in the payload to a tenant that is
    // never shown one. normalized_score is that verdict — the evidence panel
    // renders it as "AI suggests: Pass/Fail" — so it is nulled here rather
    // than hidden in the client.
    const scoreOnly = await orgHasFeature(orgId, 'score_only');

    const callItems = await query<ManualReviewItem>(
      `SELECT 'call' AS kind, cis.id AS item_score_id, cis.scorecard_item_id,
              si.label, si.section, si.severity,
              cs.call_id AS parent_id,
              cust.name AS customer_name, c.agent_name,
              cis.created_at AS detected_at,
              cis.evidence, cis.reasoning,
              cis.confidence::float AS confidence,
              cis.normalized_score::float AS normalized_score,
              -- A per-call checkpoint's evidence is, by definition, in its own call.
              cs.call_id AS source_call_id, c.file_name AS source_call_name,
              c.file_key IS NOT NULL AS has_audio
         FROM call_item_scores cis
         JOIN call_scores cs ON cs.id = cis.call_score_id
         JOIN calls c ON c.id = cs.call_id
         JOIN scorecard_items si ON si.id = cis.scorecard_item_id
         LEFT JOIN customers cust ON cust.id = c.customer_id
        WHERE c.organization_id = $1 AND cis.result = 'manual_review'
          -- A checkpoint taken off the scorecard is not a job for the reviewer.
          -- Archiving keeps the historical rows (see scripts/remove-manual-items.ts),
          -- which otherwise sit in this queue forever asking for a verdict on a
          -- criterion the tenant has retired.
          AND si.archived_at IS NULL
        ORDER BY cis.created_at ASC, cis.id ASC
        LIMIT ${QUEUE_CEILING}`,
      [orgId]
    );

    const journeyItems = await query<ManualReviewItem>(
      `SELECT 'journey' AS kind, jis.id AS item_score_id, jis.scorecard_item_id,
              si.label, si.section, si.severity,
              jis.journey_id AS parent_id,
              cust.name AS customer_name, ja.agent_name,
              jis.created_at AS detected_at,
              jis.evidence, jis.reasoning,
              jis.confidence::float AS confidence,
              jis.normalized_score::float AS normalized_score,
              jis.source_call_id, sc.file_name AS source_call_name,
              sc.file_key IS NOT NULL AS has_audio
         FROM journey_item_scores jis
         JOIN journeys j ON j.id = jis.journey_id
         JOIN scorecard_items si ON si.id = jis.scorecard_item_id
         LEFT JOIN customers cust ON cust.id = j.customer_id
         -- The call the scorer quoted, when it cited one — the transcript and
         -- recording the reviewer needs to check the quote against.
         LEFT JOIN calls sc ON sc.id = jis.source_call_id AND sc.organization_id = j.organization_id
         -- A journey has no call of its own: attribute it to the wrap-up
         -- (closing) agent — earliest call flagged wrap_up, else the latest
         -- call in the set — as journeys are attributed elsewhere.
         LEFT JOIN LATERAL (
           SELECT jac.agent_name
             FROM journey_calls jajc
             JOIN calls jac ON jac.id = jajc.call_id
            WHERE jajc.journey_id = j.id
            ORDER BY (jajc.role = 'wrap_up') DESC,
                     CASE WHEN jajc.role = 'wrap_up'
                          THEN COALESCE(jac.call_date, jac.created_at) END ASC,
                     COALESCE(jac.call_date, jac.created_at) DESC
            LIMIT 1
         ) ja ON true
        WHERE j.organization_id = $1 AND jis.result = 'manual_review'
          -- Retired checkpoints drop out of the queue (see the per-call query).
          AND si.archived_at IS NULL
        ORDER BY jis.created_at ASC, jis.id ASC
        LIMIT ${QUEUE_CEILING}`,
      [orgId]
    );

    // The gate is applied once, before anything else reads these rows, so no
    // later branch can reintroduce the verdict into the payload.
    const all = [...callItems, ...journeyItems].map((item) =>
      scoreOnly ? { ...item, normalized_score: null } : item
    );

    // Counted over everything in the queue, before the filters: see the route
    // comment. The adviser list comes from the same place, so the filter never
    // offers a name with nothing behind it.
    const summary = summariseQueue(all);
    const advisers = [...new Set(all.map((i) => i.agent_name).filter((n): n is string => !!n))].sort(
      (a, b) => a.localeCompare(b)
    );

    const agent = typeof req.query.agent === 'string' && req.query.agent ? req.query.agent : null;
    const severityParam = typeof req.query.severity === 'string' ? req.query.severity : '';
    const severity = (REVIEW_SEVERITIES as readonly string[]).includes(severityParam)
      ? (severityParam as ReviewSeverity)
      : null;
    const sort: ReviewQueueSort = req.query.sort === 'newest' ? 'newest' : 'oldest';
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(
      MAX_SALES_PER_PAGE,
      Math.max(1, parseInt(String(req.query.limit ?? String(DEFAULT_SALES_PER_PAGE)), 10) || DEFAULT_SALES_PER_PAGE)
    );

    const filtered = all.filter(
      (i) => (!agent || i.agent_name === agent) && (!severity || i.severity === severity)
    );

    const groups = groupBySale(filtered, sort);
    const pageGroups = groups.slice((page - 1) * limit, page * limit);

    const body: ReviewQueueResponse = {
      data: pageGroups.flatMap((g) => g.items),
      total: filtered.length,
      total_sales: groups.length,
      page,
      limit,
      summary,
      advisers,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// One sale (or, for a per-call tenant, one call) and the checkpoints held on it.
// The queue's unit of work: 41 of one live tenant's 130 checkpoints belong to a
// single sale, and ruling on them is one sitting with one set of recordings, not
// 41 unrelated decisions.
interface SaleGroup {
  kind: 'call' | 'journey';
  parent_id: string;
  oldest: number;
  items: ManualReviewItem[];
}

function detectedMs(item: ManualReviewItem): number {
  const t = new Date(item.detected_at).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Group the checkpoints by the sale they sit on, oldest wait first (or newest,
 * if asked). Inside a group the checkpoints stay in the order they were raised,
 * which is the order the scorecard runs.
 */
function groupBySale(items: ManualReviewItem[], sort: ReviewQueueSort): SaleGroup[] {
  const byParent = new Map<string, SaleGroup>();
  for (const item of items) {
    // Keyed on kind as well as id: a call id and a journey id are different
    // namespaces, and a collision would merge two unrelated pieces of work.
    const key = `${item.kind}:${item.parent_id}`;
    const group = byParent.get(key);
    if (group) {
      group.items.push(item);
      group.oldest = Math.min(group.oldest, detectedMs(item));
    } else {
      byParent.set(key, {
        kind: item.kind,
        parent_id: item.parent_id,
        oldest: detectedMs(item),
        items: [item],
      });
    }
  }
  const groups = [...byParent.values()];
  for (const group of groups) group.items.sort((a, b) => detectedMs(a) - detectedMs(b));
  // Tie-broken on the parent id so a page boundary is stable between requests —
  // without it two sales raised in the same second could swap places under a
  // reviewer working down the list.
  groups.sort((a, b) =>
    a.oldest === b.oldest
      ? a.parent_id.localeCompare(b.parent_id)
      : sort === 'newest'
        ? b.oldest - a.oldest
        : a.oldest - b.oldest
  );
  return groups;
}

/** Whole days since a timestamp, floored — a checkpoint raised this morning has waited 0. */
function daysSince(ms: number): number {
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

/**
 * What the whole queue holds. Every figure the screen prints comes from here
 * rather than from the page of rows it happens to be showing, so a reviewer on
 * page 2 of a filtered view is still told the true size of the backlog.
 */
function summariseQueue(items: ManualReviewItem[]): ReviewQueueSummary {
  const by_severity: ReviewQueueSummary['by_severity'] = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unrated: 0,
  };
  const perSale = new Map<string, { count: number; name: string | null; kind: 'call' | 'journey'; parent_id: string }>();
  let oldest: number | null = null;

  for (const item of items) {
    by_severity[item.severity ?? 'unrated'] += 1;
    const ms = detectedMs(item);
    if (oldest === null || ms < oldest) oldest = ms;
    const key = `${item.kind}:${item.parent_id}`;
    const seen = perSale.get(key);
    if (seen) seen.count += 1;
    else
      perSale.set(key, {
        count: 1,
        // The customer names the sale; the source call is the fallback, exactly
        // as the list rows name it.
        name: item.customer_name ?? item.source_call_name ?? null,
        kind: item.kind,
        parent_id: item.parent_id,
      });
  }

  let largest: ReviewQueueSummary['largest'] = null;
  for (const sale of perSale.values()) {
    if (!largest || sale.count > largest.count) {
      largest = { kind: sale.kind, parent_id: sale.parent_id, name: sale.name, count: sale.count };
    }
  }

  return {
    checkpoints: items.length,
    sales: perSale.size,
    oldest_days: oldest === null ? null : daysSince(oldest),
    by_severity,
    largest,
  };
}

// GET /api/review-items/:kind/:itemScoreId/evidence — where this checkpoint's
// evidence quote sits in the call: the transcript around it and the second of
// audio it starts at, so a reviewer can read and hear the moment before marking
// pass or fail. Resolved on demand (the position is never stored) and kept off
// the list endpoint, which would otherwise load every raw transcript at once.
reviewRouter.get('/:kind/:itemScoreId/evidence', requireOrgView, async (req, res, next) => {
  try {
    const { kind, itemScoreId } = req.params as { kind: string; itemScoreId: string };
    if (kind !== 'call' && kind !== 'journey') throw new AppError(400, "kind must be 'call' or 'journey'");
    const orgId = req.user!.organizationId;

    const row =
      kind === 'call'
        ? await queryOne<EvidenceRow>(
            `SELECT cis.evidence, cis.result, c.id AS call_id, c.file_name, c.call_date,
                    c.duration_seconds, c.file_key, c.transcript_text, c.transcript_raw,
                    c.speaker_integrity_flag
               FROM call_item_scores cis
               JOIN call_scores cs ON cs.id = cis.call_score_id
               JOIN calls c ON c.id = cs.call_id
              WHERE cis.id = $1 AND c.organization_id = $2`,
            [itemScoreId, orgId]
          )
        : await queryOne<EvidenceRow>(
            `SELECT jis.evidence, jis.result, c.id AS call_id, c.file_name, c.call_date,
                    c.duration_seconds, c.file_key, c.transcript_text, c.transcript_raw,
                    c.speaker_integrity_flag
               FROM journey_item_scores jis
               JOIN journeys j ON j.id = jis.journey_id
               JOIN calls c ON c.id = jis.source_call_id AND c.organization_id = j.organization_id
              WHERE jis.id = $1 AND j.organization_id = $2`,
            [itemScoreId, orgId]
          );

    // Either the checkpoint isn't this org's, or (journeys) the scorer cited no
    // source call — there is no single call to show evidence in.
    if (!row) throw new AppError(404, 'No source call for this checkpoint');

    // Gated narrowly by transcript access (services/transcript-access.ts).
    //
    // This returns a bounded excerpt — the quoted line plus two blocks either side.
    // The DPIA's action 11 restriction is on reading the conversation, and it
    // preserves the evidence quote in context for one purpose: a supervisor who
    // cannot see the moment cannot settle a checkpoint they have been asked to rule
    // on. So a user who may not read the transcript gets the lines only for a
    // checkpoint awaiting a ruling. Everywhere else — the sale page lets someone
    // open checkpoint after checkpoint — the excerpts would add up to most of the
    // transcript, and the user gets the AI's quote alone (restricted: true).
    //
    // If CONTEXT_BLOCKS is ever widened materially, or this endpoint starts
    // returning the whole transcript on a failed match, the review-case exception
    // stops holding too.
    const located = locateEvidence({
      quote: row.evidence,
      transcriptText: row.transcript_text,
      transcriptRaw: row.transcript_raw,
    });

    // The lines around the quote are sent only where the user may read the
    // transcript, or the checkpoint awaits their ruling (mayShowEvidenceExcerpt).
    // The position is still resolved — the recording is not gated, and cueing it
    // to the moment reveals nothing the quote itself does not.
    const access = await resolveTranscriptAccess(orgId, req.user!.role);
    const excerptAllowed = mayShowEvidenceExcerpt(access, row.result);

    const location: EvidenceLocation = {
      ...(excerptAllowed ? {} : { restricted: true }),
      call_id: row.call_id,
      call_file_name: row.file_name,
      call_date: row.call_date,
      has_audio: row.file_key !== null,
      duration_seconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
      // Whether the Agent/Customer labels on this transcript were found to be
      // contradicted by what was actually said (services/speaker-integrity.ts).
      // The reviewer is the last line of defence on a checkpoint the scorer
      // could not settle, and handing them mislabelled speakers as fact is how
      // a wrong verdict gets confirmed by a human and made permanent.
      speaker_integrity_flag: row.speaker_integrity_flag ?? null,
      ...located,
      ...(excerptAllowed ? {} : { excerpt: [] }),
    };
    res.json(location);
  } catch (err) {
    next(err);
  }
});

interface EvidenceRow {
  evidence: string | null;
  result: string | null;
  speaker_integrity_flag: string | null;
  call_id: string;
  file_name: string | null;
  call_date: string | null;
  duration_seconds: number | string | null;
  file_key: string | null;
  transcript_text: string | null;
  transcript_raw: unknown;
}

// POST /api/review-items/resolve — a reviewer marks a manual_review checkpoint
// pass, fail, or not applicable. Recomputes the parent overall score (scored
// items only) and raises/clears the breach, mirroring the per-call correction
// path, then re-pushes the corrected score downstream (webhook + Zoho) so the CRM
// reflects the human verdict rather than the AI's provisional score.
//
// 'na' exists because the queue offering only pass/fail forced reviewers to
// record a false pass on checkpoints that could not apply to the sale — a trust
// item on a product that cannot be placed in trust, a payment-date item where no
// Direct Debit was taken (migration 108). An 'na' resolution drops the checkpoint
// out of the denominator rather than passing it, which is the difference between
// "the adviser did this" and "this was never in scope".
reviewRouter.post('/resolve', requireActioner, async (req, res, next) => {
  try {
    const { kind, item_score_id, result, note } = req.body as {
      kind?: 'call' | 'journey';
      item_score_id?: string;
      result?: 'pass' | 'fail' | 'na';
      note?: string;
    };
    if (kind !== 'call' && kind !== 'journey') throw new AppError(400, "kind must be 'call' or 'journey'");
    if (!item_score_id) throw new AppError(400, 'item_score_id is required');
    if (result !== 'pass' && result !== 'fail' && result !== 'na') {
      throw new AppError(400, "result must be 'pass', 'fail' or 'na'");
    }
    // Why the reviewer ruled this way, in their words. Optional — the queue
    // must never be harder to clear than it already is — but where it is given
    // it is the record: on a journey it becomes the reason stored against the
    // correction, which is what the calibration pass and any later audit read,
    // and on every kind it is stamped on the audit event. Bounded so a pasted
    // transcript cannot arrive as a note.
    const reviewerNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 2000) : null;

    const orgId = req.user!.organizationId;
    const settings = await getScoringSettings(orgId);
    // A checkpoint that did not apply carries no score. NULL rather than 0: the
    // recompute reads pass/fail rows only, so the row must not look like a fail
    // to anything that later widens that filter.
    const normalized = result === 'na' ? null : result === 'pass' ? 100 : 0;
    const rawScore = result === 'na' ? null : result === 'pass' ? 1 : 0;

    const resolved =
      kind === 'call'
        ? await resolveCallItem(orgId, req.user!.userId, item_score_id, result, normalized, rawScore, settings.passThreshold)
        : await resolveJourneyItem(
            orgId,
            req.user!.userId,
            item_score_id,
            result,
            normalized,
            rawScore,
            settings.passThreshold,
            reviewerNote
          );

    // Re-push the corrected score downstream (webhook + Zoho), so the CRM
    // reflects the human verdict rather than the AI's provisional score.
    // Best-effort and after commit — never blocks the reviewer's response.
    if (kind === 'call') {
      void pushCallScoreUpdate(orgId, resolved.entityId);
    } else {
      void pushJourneyScoreUpdate(orgId, resolved.entityId);
    }

    // And tell the team, if a rule asks to hear about this checkpoint. A held
    // checkpoint raised no alert when the AI scored it — it was not a verdict
    // (#208) — so this ruling is the first moment there is anything to report.
    // A confirmed pass or a not-applicable ruling matches no rule and says
    // nothing; a checkpoint already alerted at scoring time is not re-announced
    // (alert_events, migration 117). Fire-and-forget: an alert must never fail
    // the reviewer's action.
    void evaluateAlertsForResolvedItem({
      kind,
      entityId: resolved.entityId,
      scorecardItemId: resolved.scorecardItemId,
    });

    void recordAuditEvent({
      organizationId: orgId,
      userId: req.user!.userId,
      actionType: 'review.resolve',
      entityType: 'score',
      entityId: item_score_id,
      summary: `Resolved manual-review ${kind} checkpoint to ${result}`,
      metadata: { kind, result, note: reviewerNote },
      req,
    });

    res.json({ message: 'Resolved' });
  } catch (err) {
    next(err);
  }
});

// What was ruled on: the call or sale it belongs to, and the checkpoint itself
// — both needed to re-push the score and to evaluate the alert rules the ruling
// can have made true.
interface ResolvedItem {
  entityId: string;
  scorecardItemId: string;
}

async function resolveCallItem(
  orgId: string,
  userId: string,
  itemScoreId: string,
  result: 'pass' | 'fail' | 'na',
  normalized: number | null,
  rawScore: number | null,
  threshold: number
): Promise<ResolvedItem> {
  const row = await queryOne<{ call_score_id: string; scorecard_item_id: string; call_id: string; weight: string; severity: string | null }>(
    `SELECT cis.call_score_id, cis.scorecard_item_id, cs.call_id, si.weight::text, si.severity
       FROM call_item_scores cis
       JOIN call_scores cs ON cs.id = cis.call_score_id
       JOIN calls c ON c.id = cs.call_id
       JOIN scorecard_items si ON si.id = cis.scorecard_item_id
      WHERE cis.id = $1 AND c.organization_id = $2 AND cis.result = 'manual_review'`,
    [itemScoreId, orgId]
  );
  if (!row) throw new AppError(404, 'Manual-review item not found');
  const severity = deriveSeverity(Number(row.weight), row.severity);

  await withTransaction(async (tx) => {
    // Serialise reviewers working the same call. The recompute below reads
    // every sibling checkpoint, so two people ruling on different checkpoints of
    // one call would each compute from a snapshot taken before the other
    // committed, and the second write would store a score that ignores the
    // first ruling. Locking the parent first makes them queue instead.
    await tx.query('SELECT id FROM call_scores WHERE id = $1 FOR UPDATE', [row.call_score_id]);

    // The check above ran outside this transaction, so another reviewer may
    // have ruled on this very checkpoint since. Claim it rather than
    // overwriting them: a lost race here replaces a human verdict silently,
    // and on the fail path the loser's DELETE of the breach row can land after
    // the winner's INSERT, leaving a confirmed failure off the register.
    const claimed = await tx.query<{ id: string }>(
      "UPDATE call_item_scores SET result = $2, score = $3, normalized_score = $4 WHERE id = $1 AND result = 'manual_review' RETURNING id",
      [itemScoreId, result, rawScore, normalized]
    );
    if (claimed.length === 0) {
      throw new AppError(409, 'Another reviewer has already ruled on this checkpoint.');
    }

    const items = await tx.query<{ normalized_score: string; weight: string; severity: string | null }>(
      `SELECT cis.normalized_score::text, si.weight::text, si.severity
         FROM call_item_scores cis
         JOIN scorecard_items si ON si.id = cis.scorecard_item_id
        WHERE cis.call_score_id = $1 AND cis.result IN ('pass', 'fail')
          -- Retired checkpoints are out of the denominator, matching scoring
          -- (jobs/processors/score.ts reads non-archived items only). Without
          -- this, resolving one review item on an old score silently folds
          -- checkpoints the tenant has since removed back into the maths.
          AND si.archived_at IS NULL`,
      [row.call_score_id]
    );
    const { overall, failing } = recompute(items, threshold);
    await tx.query('UPDATE call_scores SET overall_score = $1, pass = $2 WHERE id = $3', [
      overall,
      callPasses(overall, failing, threshold),
      row.call_score_id,
    ]);

    if (result === 'fail') {
      // Stamped confirmed: a person looked at this checkpoint and ruled it a
      // failure, which is the strongest standing migration 078 models. Without
      // it the register cannot tell a human verdict from an unreviewed AI
      // finding, and asks the QA team to confirm a decision they just made.
      await tx.query(
        `INSERT INTO breaches (organization_id, call_id, call_item_score_id, scorecard_item_id, severity,
                               detected_at, confirmed_by, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, now(), $6, now())
         ON CONFLICT (call_item_score_id)
           DO UPDATE SET confirmed_by = EXCLUDED.confirmed_by, confirmed_at = EXCLUDED.confirmed_at`,
        [orgId, row.call_id, itemScoreId, row.scorecard_item_id, severity, userId]
      );
    } else {
      await tx.query('DELETE FROM breaches WHERE call_item_score_id = $1', [itemScoreId]);
    }

    // Re-evaluate for auto-exemplar now this checkpoint is adjudicated (mirrors
    // jobs/processors/score.ts's gate): a call withheld exemplar status only
    // because a checkpoint was pending review can now earn it once every
    // checkpoint on the score has a human-confirmed result — nothing here is
    // scored blind, so nothing is lost by resolving into it rather than out of it.
    const stillPending = await tx.query<{ id: string }>(
      `SELECT cis.id
         FROM call_item_scores cis
         JOIN scorecard_items si ON si.id = cis.scorecard_item_id
        WHERE cis.call_score_id = $1 AND cis.result = 'manual_review'
          -- A retired checkpoint is never resolved (see the GET /review-items
          -- queue filter above), so it must not block re-evaluation forever.
          AND si.archived_at IS NULL`,
      [row.call_score_id]
    );
    if (stillPending.length === 0 && failing.length === 0 && overall >= 95) {
      await tx.query(
        `UPDATE calls SET
           is_exemplar = CASE WHEN is_exemplar = false THEN true ELSE is_exemplar END,
           exemplar_reason = CASE WHEN is_exemplar = false THEN $2 ELSE exemplar_reason END,
           updated_at = now()
         WHERE id = $1`,
        [row.call_id, 'Auto: 95%+ with zero breaches, confirmed on review']
      );
    }
  });

  return { entityId: row.call_id, scorecardItemId: row.scorecard_item_id };
}

async function resolveJourneyItem(
  orgId: string,
  userId: string,
  itemScoreId: string,
  result: 'pass' | 'fail' | 'na',
  normalized: number | null,
  rawScore: number | null,
  threshold: number,
  // The reviewer's own words, when they gave any (POST /resolve). Stored as the
  // correction's reason in place of the boilerplate, so the record says why the
  // checkpoint was ruled this way rather than only that it was.
  note: string | null
): Promise<ResolvedItem> {
  const row = await queryOne<{ journey_id: string; scorecard_item_id: string; weight: string; severity: string | null; evidence: string | null; normalized_score: number | null }>(
    `SELECT jis.journey_id, jis.scorecard_item_id, si.weight::text, si.severity, jis.evidence, jis.normalized_score
       FROM journey_item_scores jis
       JOIN journeys j ON j.id = jis.journey_id
       JOIN scorecard_items si ON si.id = jis.scorecard_item_id
      WHERE jis.id = $1 AND j.organization_id = $2 AND jis.result = 'manual_review'`,
    [itemScoreId, orgId]
  );
  if (!row) throw new AppError(404, 'Manual-review item not found');
  const severity = deriveSeverity(Number(row.weight), row.severity);

  await withTransaction(async (tx) => {
    // Serialise reviewers working the same sale. The recompute below reads
    // every sibling checkpoint, so two people ruling on different checkpoints of
    // one sale would each compute from a snapshot taken before the other
    // committed, and the second write would store a score that ignores the
    // first ruling. Locking the parent first makes them queue instead.
    await tx.query('SELECT id FROM journeys WHERE id = $1 FOR UPDATE', [row.journey_id]);

    // The check above ran outside this transaction, so another reviewer may
    // have ruled on this very checkpoint since. Claim it rather than
    // overwriting them: a lost race here replaces a human verdict silently,
    // and on the fail path the loser's DELETE of the breach row can land after
    // the winner's INSERT, leaving a confirmed failure off the register.
    const claimed = await tx.query<{ id: string }>(
      "UPDATE journey_item_scores SET result = $2, score = $3, normalized_score = $4 WHERE id = $1 AND result = 'manual_review' RETURNING id",
      [itemScoreId, result, rawScore, normalized]
    );
    if (claimed.length === 0) {
      throw new AppError(409, 'Another reviewer has already ruled on this checkpoint.');
    }

    // Record the reviewer's verdict as calibration, so confirming a manual-
    // review checkpoint teaches the AI for that criterion (the sales_only path
    // to calibration — mirrors the per-call correct endpoint). The AI's stored
    // evidence quote is the excerpt; original_pass is null (manual_review had
    // no confident AI verdict).
    await tx.query(
      `INSERT INTO score_corrections
         (organization_id, journey_id, journey_item_score_id, scorecard_item_id, corrected_by,
          original_score, corrected_score, original_pass, corrected_pass, reason, transcript_excerpt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10)
       -- Keyed on (journey, checkpoint), not the item-score row: that row is
       -- dropped and recreated on every scoring run, so its unique index went
       -- with migration 077. journey_item_score_id is only a pointer to the
       -- current row now, so re-link it on conflict.
       ON CONFLICT (journey_id, scorecard_item_id) WHERE journey_id IS NOT NULL
       DO UPDATE SET
         journey_item_score_id = EXCLUDED.journey_item_score_id,
         corrected_score = EXCLUDED.corrected_score,
         corrected_pass = EXCLUDED.corrected_pass,
         reason = EXCLUDED.reason,
         corrected_by = EXCLUDED.corrected_by,
         created_at = now()`,
      [
        orgId,
        row.journey_id,
        itemScoreId,
        row.scorecard_item_id,
        userId,
        row.normalized_score ?? 0,
        normalized,
        // NULL = resolved as not applicable (migration 108). Distinct from
        // false, which asserts the adviser did not do it.
        result === 'na' ? null : result === 'pass',
        // The reviewer's note when there is one; otherwise the boilerplate. The
        // pass/fail/na distinction is carried by corrected_pass (NULL for na),
        // never by this text, so replacing it loses nothing.
        note ?? (result === 'na' ? 'Not applicable to this sale' : 'Confirmed on manual review'),
        row.evidence,
      ]
    );

    const items = await tx.query<{ normalized_score: string; weight: string; severity: string | null }>(
      `SELECT jis.normalized_score::text, si.weight::text, si.severity
         FROM journey_item_scores jis
         JOIN scorecard_items si ON si.id = jis.scorecard_item_id
        WHERE jis.journey_id = $1 AND jis.result IN ('pass', 'fail')
          -- Retired checkpoints stay out of the denominator (see the per-call path).
          AND si.archived_at IS NULL`,
      [row.journey_id]
    );
    const { overall, failing } = recompute(items, threshold);
    await tx.query('UPDATE journeys SET overall_score = $1, pass = $2, updated_at = now() WHERE id = $3', [
      overall,
      callPasses(overall, failing, threshold),
      row.journey_id,
    ]);

    if (result === 'fail') {
      // Stamped confirmed — see the per-call path above for why.
      await tx.query(
        `INSERT INTO breaches (organization_id, journey_id, journey_item_score_id, scorecard_item_id, severity,
                               detected_at, confirmed_by, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, now(), $6, now())
         ON CONFLICT (journey_item_score_id)
           DO UPDATE SET confirmed_by = EXCLUDED.confirmed_by, confirmed_at = EXCLUDED.confirmed_at`,
        [orgId, row.journey_id, itemScoreId, row.scorecard_item_id, severity, userId]
      );
    } else {
      await tx.query('DELETE FROM breaches WHERE journey_item_score_id = $1', [itemScoreId]);
    }
  });

  return { entityId: row.journey_id, scorecardItemId: row.scorecard_item_id };
}

// Weighted overall + list of failing severities, over the pass/fail items only
// (na / manual_review carry no numeric score and are excluded).
function recompute(
  items: Array<{ normalized_score: string; weight: string; severity: string | null }>,
  threshold: number
): { overall: number; failing: BreachSeverity[] } {
  let totalWeighted = 0;
  let totalWeight = 0;
  const failing: BreachSeverity[] = [];
  for (const it of items) {
    const w = Number(it.weight);
    const n = Number(it.normalized_score);
    totalWeighted += n * w;
    totalWeight += w;
    if (!isItemPass(n, threshold)) failing.push(deriveSeverity(w, it.severity));
  }
  return { overall: totalWeight > 0 ? totalWeighted / totalWeight : 0, failing };
}
