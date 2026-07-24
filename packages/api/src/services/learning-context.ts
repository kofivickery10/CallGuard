import { query } from '../db/client.js';
import { EXEMPLAR_EXCERPT_CHARS, type LearningContext } from './scoring.js';
import type { CallCoaching, Plan } from '@callguard/shared';
import { hasFeature } from '@callguard/shared';

/**
 * Build the tenant-specific learning context that gets fed into the scoring prompt.
 * Contains: past human corrections, firm exemplars, agent's prior coaching.
 * Gated by plan — core and above get learning context (requires ai_learning feature).
 */
export async function getLearningContext(
  organizationId: string,
  plan: Plan,
  scorecardItemIds: string[],
  agentId: string | null
): Promise<LearningContext | undefined> {
  if (!hasFeature(plan, 'ai_learning')) {
    return undefined;
  }

  const correctionsByItem: Record<string, LearningContext['correctionsByItem'][string]> = {};

  // Corrections per scorecard item (last 10, most recent first)
  if (scorecardItemIds.length > 0) {
    const corrections = await query<{
      scorecard_item_id: string;
      corrected_pass: boolean;
      reason: string | null;
      transcript_excerpt: string | null;
    }>(
      `SELECT scorecard_item_id, corrected_pass, reason, transcript_excerpt
         FROM score_corrections
        WHERE organization_id = $1
          AND scorecard_item_id = ANY($2::uuid[])
        ORDER BY created_at DESC
        LIMIT 50`,
      [organizationId, scorecardItemIds]
    );

    for (const c of corrections) {
      if (!correctionsByItem[c.scorecard_item_id]) correctionsByItem[c.scorecard_item_id] = [];
      if (correctionsByItem[c.scorecard_item_id]!.length < 5) {
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

  // Prior coaching for this agent (last 3)
  let priorCoaching: LearningContext['priorCoaching'] = [];
  if (agentId && hasFeature(plan, 'coaching')) {
    const rows = await query<{ coaching: CallCoaching; created_at: string }>(
      `SELECT cs.coaching, cs.created_at
         FROM call_scores cs
         JOIN calls c ON c.id = cs.call_id
        WHERE c.agent_id = $1
          AND c.organization_id = $2
          AND cs.coaching IS NOT NULL
        ORDER BY cs.created_at DESC
        LIMIT 3`,
      [agentId, organizationId]
    );
    priorCoaching = rows.map((r) => ({ created_at: r.created_at, coaching: r.coaching }));
  }

  return { correctionsByItem, exemplars, priorCoaching };
}
