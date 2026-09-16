import { query } from '../db/client.js';
import { CALIBRATION_EXAMPLES_PER_ITEM, EXEMPLAR_EXCERPT_CHARS, type LearningContext } from './scoring.js';
import type { CallCoaching, Plan } from '@callguard/shared';
import { hasFeature } from '@callguard/shared';

// How many of the adviser's most recent coaching briefs reach the prompt,
// counting calls and sales together.
export const PRIOR_COACHING_LIMIT = 3;

export interface LearningContextOptions {
  // The sale being scored. Its brief from an earlier run of the same sale is not
  // coaching the adviser received before it, so it must not come back as
  // "prior coaching" when the sale is re-scored.
  excludeJourneyId?: string | null;
}

/**
 * Build the tenant-specific learning context that gets fed into the scoring prompt.
 * Contains: past human corrections, firm exemplars, agent's prior coaching.
 * Gated by plan — core and above get learning context (requires ai_learning feature).
 */
export async function getLearningContext(
  organizationId: string,
  plan: Plan,
  scorecardItemIds: string[],
  agentId: string | null,
  options: LearningContextOptions = {}
): Promise<LearningContext | undefined> {
  if (!hasFeature(plan, 'ai_learning')) {
    return undefined;
  }

  const correctionsByItem: Record<string, LearningContext['correctionsByItem'][string]> = {};

  // Corrections: up to CALIBRATION_EXAMPLES_PER_ITEM per criterion, most recent
  // first.
  //
  // The cap is per criterion in the query itself. It used to be one LIMIT 50
  // across every criterion, trimmed to five each afterwards, so a criterion
  // corrected often (a consent gate the review queue sees daily) could fill all
  // 50 rows and leave a rarely-corrected criterion with no examples at all,
  // however relevant its corrections were.
  //
  // One bounded lookup per criterion rather than ROW_NUMBER() over the whole
  // set: idx_corrections_org_item (organization_id, scorecard_item_id,
  // created_at DESC, migration 011) serves each lookup in order and stops after
  // five rows. A window function would read every correction ever recorded on
  // those criteria before discarding all but five of each.
  //
  // "Not applicable" rulings (corrected_pass NULL, migration 108) are excluded
  // here, so they do not take up a slot a real verdict could use. See
  // buildScoringPrompt for why they are not examples.
  if (scorecardItemIds.length > 0) {
    const corrections = await query<{
      scorecard_item_id: string;
      corrected_pass: boolean | null;
      reason: string | null;
      transcript_excerpt: string | null;
    }>(
      `SELECT recent.scorecard_item_id, recent.corrected_pass, recent.reason, recent.transcript_excerpt
         FROM unnest($2::uuid[]) AS item(id)
         CROSS JOIN LATERAL (
           SELECT sc.scorecard_item_id, sc.corrected_pass, sc.reason, sc.transcript_excerpt, sc.created_at
             FROM score_corrections sc
            WHERE sc.organization_id = $1
              AND sc.scorecard_item_id = item.id
              AND sc.corrected_pass IS NOT NULL
            ORDER BY sc.created_at DESC
            LIMIT $3
         ) recent
        ORDER BY recent.scorecard_item_id, recent.created_at DESC`,
      [organizationId, [...new Set(scorecardItemIds)], CALIBRATION_EXAMPLES_PER_ITEM]
    );

    for (const c of corrections) {
      // Belt and braces: the query already excludes these and caps each
      // criterion, and the prompt must hold either way.
      if (c.corrected_pass === null) continue;
      if (!correctionsByItem[c.scorecard_item_id]) correctionsByItem[c.scorecard_item_id] = [];
      if (correctionsByItem[c.scorecard_item_id]!.length < CALIBRATION_EXAMPLES_PER_ITEM) {
        correctionsByItem[c.scorecard_item_id]!.push({
          corrected_pass: c.corrected_pass,
          reason: c.reason,
          transcript_excerpt: c.transcript_excerpt,
        });
      }
    }
  }

  // Exemplars: most recently marked, deterministic. scoreTranscript splits a
  // "stable, cacheable" prompt prefix that includes these — ORDER BY random()
  // changed the prefix on every single call for any org with exemplars,
  // defeating prompt caching (paying full cache-write price every time)
  // rather than the intended cache-read discount on repeat scoring calls.
  //
  // Two sources, merged: per-call exemplars (calls.is_exemplar, marked in
  // per_call mode) and whole-SALE exemplars (journeys.is_exemplar, the only
  // ones markable in sales_only mode, since calls never reach 'scored' there).
  // Both are org-level and feed every scoring run regardless of call vs journey.
  const callExemplarRows = await query<{ transcript_text: string | null; exemplar_reason: string | null; updated_at: string }>(
    `SELECT transcript_text, exemplar_reason, updated_at
       FROM calls
      WHERE organization_id = $1 AND is_exemplar = true AND transcript_text IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 2`,
    [organizationId]
  );

  const journeyExemplarRows = await query<{ id: string; exemplar_reason: string | null; updated_at: string }>(
    `SELECT id, exemplar_reason, updated_at
       FROM journeys
      WHERE organization_id = $1 AND is_exemplar = true
      ORDER BY updated_at DESC
      LIMIT 2`,
    [organizationId]
  );

  const candidates: Array<{ excerpt: string; reason: string | null; updated_at: string }> = [];
  for (const e of callExemplarRows) {
    if (e.transcript_text) {
      candidates.push({ excerpt: e.transcript_text.slice(0, EXEMPLAR_EXCERPT_CHARS), reason: e.exemplar_reason, updated_at: e.updated_at });
    }
  }
  for (const j of journeyExemplarRows) {
    // A sale's exemplar text is its CLOSING call — the wrap-up (or latest) call,
    // where the compliant close/sale usually sits. Better "what good looks like"
    // than the opening of call 1 that a combined-transcript slice would give.
    const closingCall = await query<{ transcript_text: string | null }>(
      `SELECT c.transcript_text
         FROM journey_calls jc
         JOIN calls c ON c.id = jc.call_id
        WHERE jc.journey_id = $1 AND c.transcript_text IS NOT NULL
        ORDER BY (jc.role = 'wrap_up') DESC, COALESCE(c.call_date::timestamptz, c.created_at) DESC
        LIMIT 1`,
      [j.id]
    );
    const text = closingCall[0]?.transcript_text;
    if (text) candidates.push({ excerpt: text.slice(0, EXEMPLAR_EXCERPT_CHARS), reason: j.exemplar_reason, updated_at: j.updated_at });
  }

  // Most-recently-marked first, capped at 2 total — keeps the cacheable prompt
  // prefix small and stable whether the org uses call or sale exemplars.
  const exemplars = candidates
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 2)
    .map((e) => ({ excerpt: e.excerpt, reason: e.reason }));

  // Prior coaching for this agent: the most recent PRIOR_COACHING_LIMIT briefs,
  // from calls and sales combined.
  //
  // This used to read call_scores only. A sales_only firm never scores calls on
  // their own, so its coaching lives on journeys.coaching and the adviser's
  // coaching memory was always empty: each sale's brief was written as if the
  // adviser had never been coached.
  let priorCoaching: LearningContext['priorCoaching'] = [];
  if (agentId && hasFeature(plan, 'coaching')) {
    const callRows = await query<{ coaching: CallCoaching; created_at: string }>(
      `SELECT cs.coaching, cs.created_at
         FROM call_scores cs
         JOIN calls c ON c.id = cs.call_id
        WHERE c.agent_id = $1
          AND c.organization_id = $2
          AND cs.coaching IS NOT NULL
        ORDER BY cs.created_at DESC
        LIMIT ${PRIOR_COACHING_LIMIT}`,
      [agentId, organizationId]
    );

    // A sale's brief belongs to its wrap-up adviser, chosen exactly as
    // score-journey.ts chooses wrapUp: the earliest wrap_up call, else the
    // latest call on the sale (the same rule migration 111 records). Joining
    // from the adviser's own calls keeps this on idx_calls_agent_id, and the
    // closer check means each sale is counted once, however many of its calls
    // the adviser took.
    const saleRows = await query<{ coaching: CallCoaching; created_at: string }>(
      `SELECT j.coaching, COALESCE(j.scored_at, j.updated_at) AS created_at
         FROM calls c
         JOIN journey_calls jc ON jc.call_id = c.id
         JOIN journeys j ON j.id = jc.journey_id
        WHERE c.agent_id = $1
          AND c.organization_id = $2
          AND j.organization_id = $2
          AND j.coaching IS NOT NULL
          AND ($3::uuid IS NULL OR j.id <> $3::uuid)
          AND c.id = (
            SELECT c2.id
              FROM journey_calls jc2
              JOIN calls c2 ON c2.id = jc2.call_id
             WHERE jc2.journey_id = j.id
             ORDER BY (jc2.role = 'wrap_up') DESC,
                      CASE WHEN jc2.role = 'wrap_up' THEN COALESCE(c2.call_date::timestamptz, c2.created_at) END ASC,
                      COALESCE(c2.call_date::timestamptz, c2.created_at) DESC
             LIMIT 1
          )
        ORDER BY COALESCE(j.scored_at, j.updated_at) DESC
        LIMIT ${PRIOR_COACHING_LIMIT}`,
      [agentId, organizationId, options.excludeJourneyId ?? null]
    );

    // Each source is already capped, so the combined top three is among these
    // six rows. Most recent first, whichever kind it came from.
    priorCoaching = [...callRows, ...saleRows]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, PRIOR_COACHING_LIMIT)
      .map((r) => ({ created_at: r.created_at, coaching: r.coaching }));
  }

  return { correctionsByItem, exemplars, priorCoaching };
}
