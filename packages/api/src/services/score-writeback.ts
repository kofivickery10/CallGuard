import { query, queryOne } from '../db/client.js';
import { deliverCallScored } from './webhook-delivery.js';
import { pushCallScored, pushJourneyScored } from './zoho.js';
import type { WebhookCallScoredPayload, WebhookJourneyScoredPayload } from '@callguard/shared';

/**
 * Re-push an already-scored journey/call to downstream integrations after its
 * overall score changed *outside* the scoring job — currently when a reviewer
 * resolves a manual_review checkpoint (routes/review.ts), which recomputes the
 * parent score in the DB but does not re-run the scorecard.
 *
 * These mirror the scoring jobs' downstream side effects (the outbound
 * `*.scored` webhook + the Zoho write-back) so a human's final pass/fail verdict
 * reaches the CRM instead of leaving Zoho stale on the AI's provisional score.
 * The payloads are rebuilt from persisted state — deliberately NOT by
 * re-enqueuing score-journey/score, which would spend LLM tokens and overwrite
 * the manual verdict. Both are best-effort and never throw to the caller.
 */

// The wrap-up (closing) call's agent — the QA record's owner/attribution point.
// Mirrors the scoring job's selection exactly: the earliest call flagged
// `wrap_up`, else the latest call in the journey (both over ASC date order).
async function resolveWrapUpAgent(
  journeyId: string
): Promise<{ agent_name: string | null; agent_email: string | null }> {
  const calls = await query<{ role: string | null; agent_name: string | null; agent_id: string | null }>(
    `SELECT jc.role, c.agent_name, c.agent_id
       FROM journey_calls jc
       JOIN calls c ON c.id = jc.call_id
      WHERE jc.journey_id = $1
      ORDER BY COALESCE(c.call_date::timestamptz, c.created_at) ASC`,
    [journeyId]
  );
  const wrapUp = calls.find((c) => c.role === 'wrap_up') ?? calls[calls.length - 1] ?? null;
  if (!wrapUp) return { agent_name: null, agent_email: null };

  const agent = wrapUp.agent_id
    ? await queryOne<{ email: string | null }>('SELECT email FROM users WHERE id = $1', [wrapUp.agent_id])
    : null;
  return { agent_name: wrapUp.agent_name, agent_email: agent?.email ?? null };
}

export async function pushJourneyScoreUpdate(organizationId: string, journeyId: string): Promise<void> {
  const journey = await queryOne<{
    scorecard_id: string;
    branch: string | null;
    overall_score: string | null;
    pass: boolean | null;
    customer_id: string;
    zoho_record_id: string | null;
    client_name: string | null;
  }>(
    `SELECT scorecard_id, branch, overall_score, pass, customer_id, zoho_record_id, client_name
       FROM journeys WHERE id = $1 AND organization_id = $2`,
    [journeyId, organizationId]
  );
  if (!journey) return;

  const customer = await queryOne<{
    name: string | null;
    phone_normalized: string | null;
    external_crm_id: string | null;
  }>('SELECT name, phone_normalized, external_crm_id FROM customers WHERE id = $1', [journey.customer_id]);

  const { agent_name, agent_email } = await resolveWrapUpAgent(journeyId);

  const breachRows = await query<{
    scorecard_item_id: string;
    scorecard_item_label: string;
    severity: string;
    evidence: string | null;
  }>(
    `SELECT b.scorecard_item_id, si.label AS scorecard_item_label, b.severity, jis.evidence
       FROM breaches b
       JOIN scorecard_items si ON si.id = b.scorecard_item_id
       LEFT JOIN journey_item_scores jis ON jis.id = b.journey_item_score_id
      WHERE b.journey_id = $1`,
    [journeyId]
  );

  const payload: WebhookJourneyScoredPayload = {
    event: 'journey.scored',
    journey_id: journeyId,
    scorecard_id: journey.scorecard_id,
    branch: journey.branch,
    overall_score: Number(journey.overall_score ?? 0),
    pass: journey.pass ?? false,
    scored_at: new Date().toISOString(),
    agent_name,
    agent_email,
    customer_id: journey.customer_id,
    customer_phone: customer?.phone_normalized ?? null,
    customer_external_crm_id: customer?.external_crm_id ?? null,
    zoho_record_id: journey.zoho_record_id,
    client_name: journey.client_name ?? customer?.name ?? null,
    breaches: breachRows.map((b) => ({
      scorecard_item_id: b.scorecard_item_id,
      scorecard_item_label: b.scorecard_item_label,
      severity: b.severity,
      evidence: b.evidence ?? '',
    })),
  };

  deliverCallScored(organizationId, payload).catch((err) => {
    console.error(`[ScoreWriteback] journey.scored webhook failed for ${journeyId}:`, (err as Error).message);
  });
  pushJourneyScored(organizationId, payload).catch((err) => {
    console.error(`[ScoreWriteback] Zoho write-back failed for journey ${journeyId}:`, (err as Error).message);
  });
}

export async function pushCallScoreUpdate(organizationId: string, callId: string): Promise<void> {
  const row = await queryOne<{
    external_id: string | null;
    agent_name: string | null;
    customer_id: string | null;
    customer_phone: string | null;
    scorecard_id: string;
    overall_score: string | null;
    pass: boolean | null;
  }>(
    `SELECT c.external_id, c.agent_name, c.customer_id, c.customer_phone,
            cs.scorecard_id, cs.overall_score, cs.pass
       FROM call_scores cs
       JOIN calls c ON c.id = cs.call_id
      WHERE cs.call_id = $1 AND c.organization_id = $2`,
    [callId, organizationId]
  );
  if (!row) return;

  const customerExternalCrmId = row.customer_id
    ? (
        await queryOne<{ external_crm_id: string | null }>(
          'SELECT external_crm_id FROM customers WHERE id = $1',
          [row.customer_id]
        )
      )?.external_crm_id ?? null
    : null;

  const breachRows = await query<{
    scorecard_item_id: string;
    scorecard_item_label: string;
    severity: string;
    evidence: string | null;
  }>(
    `SELECT b.scorecard_item_id, si.label AS scorecard_item_label, b.severity, cis.evidence
       FROM breaches b
       JOIN scorecard_items si ON si.id = b.scorecard_item_id
       LEFT JOIN call_item_scores cis ON cis.id = b.call_item_score_id
      WHERE b.call_id = $1`,
    [callId]
  );

  const payload: WebhookCallScoredPayload = {
    event: 'call.scored',
    call_id: callId,
    external_id: row.external_id,
    agent_name: row.agent_name,
    scorecard_id: row.scorecard_id,
    overall_score: Number(row.overall_score ?? 0),
    pass: row.pass ?? false,
    scored_at: new Date().toISOString(),
    customer_id: row.customer_id,
    customer_phone: row.customer_phone,
    customer_external_crm_id: customerExternalCrmId,
    breaches: breachRows.map((b) => ({
      scorecard_item_id: b.scorecard_item_id,
      scorecard_item_label: b.scorecard_item_label,
      severity: b.severity,
      evidence: b.evidence ?? '',
    })),
  };

  deliverCallScored(organizationId, payload).catch((err) => {
    console.error(`[ScoreWriteback] call.scored webhook failed for ${callId}:`, (err as Error).message);
  });
  pushCallScored(organizationId, payload).catch((err) => {
    console.error(`[ScoreWriteback] Zoho write-back failed for call ${callId}:`, (err as Error).message);
  });
}
