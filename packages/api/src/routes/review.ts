import { Router } from 'express';
import { authenticate, requireOrgView, requireActioner } from '../middleware/auth.js';
import { query, queryOne, withTransaction } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { recordAuditEvent } from '../services/audit.js';
import { getScoringSettings } from '../services/tenant-settings.js';
import { pushCallScoreUpdate, pushJourneyScoreUpdate } from '../services/score-writeback.js';
import { locateEvidence } from '../services/evidence-locator.js';
import { deriveSeverity, isItemPass, callPasses } from '@callguard/shared';
import type { ManualReviewItem, BreachSeverity, EvidenceLocation } from '@callguard/shared';

export const reviewRouter = Router();
reviewRouter.use(authenticate);

// GET /api/review-items — checkpoints awaiting human sign-off: manual items and
// consent gates routed to manual_review. Spans per-call and journey scoring.
reviewRouter.get('/', requireOrgView, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;

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
          AND si.archived_at IS NULL`,
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
          AND si.archived_at IS NULL`,
      [orgId]
    );

    const items = [...callItems, ...journeyItems].sort(
      (a, b) => new Date(b.detected_at).getTime() - new Date(a.detected_at).getTime()
    );
    res.json({ data: items });
  } catch (err) {
    next(err);
  }
});

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
            `SELECT cis.evidence, c.id AS call_id, c.file_name, c.call_date,
                    c.duration_seconds, c.file_key, c.transcript_text, c.transcript_raw,
                    c.speaker_integrity_flag
               FROM call_item_scores cis
               JOIN call_scores cs ON cs.id = cis.call_score_id
               JOIN calls c ON c.id = cs.call_id
              WHERE cis.id = $1 AND c.organization_id = $2`,
            [itemScoreId, orgId]
          )
        : await queryOne<EvidenceRow>(
            `SELECT jis.evidence, c.id AS call_id, c.file_name, c.call_date,
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

    // Deliberately NOT gated by transcript access (services/transcript-access.ts).
    //
    // This returns a bounded excerpt — the quoted line plus two blocks either side
    // — tied to one checkpoint a reviewer has been asked to settle. The DPIA's
    // action 11 restriction is on reading the conversation, and it explicitly
    // preserves the evidence quote in context, because a supervisor who cannot see
    // the moment cannot do the review that the restriction exists to support.
    //
    // If CONTEXT_BLOCKS is ever widened materially, or this endpoint starts
    // returning the whole transcript on a failed match, that reasoning stops
    // holding and this needs the gate.
    const located = locateEvidence({
      quote: row.evidence,
      transcriptText: row.transcript_text,
      transcriptRaw: row.transcript_raw,
    });

    const location: EvidenceLocation = {
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
    };
    res.json(location);
  } catch (err) {
    next(err);
  }
});

interface EvidenceRow {
  evidence: string | null;
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

    const orgId = req.user!.organizationId;
    const settings = await getScoringSettings(orgId);
    // A checkpoint that did not apply carries no score. NULL rather than 0: the
    // recompute reads pass/fail rows only, so the row must not look like a fail
    // to anything that later widens that filter.
    const normalized = result === 'na' ? null : result === 'pass' ? 100 : 0;
    const rawScore = result === 'na' ? null : result === 'pass' ? 1 : 0;

    if (kind === 'call') {
      const callId = await resolveCallItem(orgId, req.user!.userId, item_score_id, result, normalized, rawScore, settings.passThreshold);
      // Re-push the corrected score downstream (webhook + Zoho), so the CRM
      // reflects the human verdict rather than the AI's provisional score.
      // Best-effort and after commit — never blocks the reviewer's response.
      void pushCallScoreUpdate(orgId, callId);
    } else {
      const journeyId = await resolveJourneyItem(orgId, req.user!.userId, item_score_id, result, normalized, rawScore, settings.passThreshold);
      void pushJourneyScoreUpdate(orgId, journeyId);
    }

    void recordAuditEvent({
      organizationId: orgId,
      userId: req.user!.userId,
      actionType: 'review.resolve',
      entityType: 'score',
      entityId: item_score_id,
      summary: `Resolved manual-review ${kind} checkpoint to ${result}`,
      metadata: { kind, result, note: note || null },
      req,
    });

    res.json({ message: 'Resolved' });
  } catch (err) {
    next(err);
  }
});

async function resolveCallItem(
  orgId: string,
  userId: string,
  itemScoreId: string,
  result: 'pass' | 'fail' | 'na',
  normalized: number | null,
  rawScore: number | null,
  threshold: number
): Promise<string> {
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
    await tx.query(
      "UPDATE call_item_scores SET result = $2, score = $3, normalized_score = $4 WHERE id = $1",
      [itemScoreId, result, rawScore, normalized]
    );

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

  return row.call_id;
}

async function resolveJourneyItem(
  orgId: string,
  userId: string,
  itemScoreId: string,
  result: 'pass' | 'fail' | 'na',
  normalized: number | null,
  rawScore: number | null,
  threshold: number
): Promise<string> {
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
    await tx.query(
      "UPDATE journey_item_scores SET result = $2, score = $3, normalized_score = $4 WHERE id = $1",
      [itemScoreId, result, rawScore, normalized]
    );

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
        result === 'na' ? 'Not applicable to this sale' : 'Confirmed on manual review',
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

  return row.journey_id;
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
