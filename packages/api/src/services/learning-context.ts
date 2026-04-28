import { query } from '../db/client.js';
import type { LearningContext } from './scoring.js';
import type { CallCoaching, Plan } from '@callguard/shared';
import { hasFeature } from '@callguard/shared';

/**
 * Build the tenant-specific learning context that gets fed into the scoring prompt.
 * Contains: past human corrections, firm exemplars, agent's prior coaching.
 * Gated by plan - starter plan gets no learning context.
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

  // Exemplars (random 2)
  const exemplarRows = await query<{ transcript_text: string | null; exemplar_reason: string | null }>(
    `SELECT transcript_text, exemplar_reason
       FROM calls
      WHERE organization_id = $1 AND is_exemplar = true AND transcript_text IS NOT NULL
      ORDER BY random()
      LIMIT 2`,
    [organizationId]
  );
  const exemplars = exemplarRows
    .filter((e) => e.transcript_text)
    .map((e) => ({
      excerpt: (e.transcript_text as string).slice(0, 600),
      reason: e.exemplar_reason,
    }));

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
