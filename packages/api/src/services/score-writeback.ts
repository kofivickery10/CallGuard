import { query, queryOne } from '../db/client.js';
import { deliverCallScored } from './webhook-delivery.js';
import { pushCallScored, pushJourneyScored } from './zoho.js';
import { getScoringSettings } from './tenant-settings.js';
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

// Rebuild the journey.scored payload from persisted state. Shared by the
// score-correction path and the feedback release below so both describe the
// sale identically — a CRM record that disagreed with itself depending on which
// action produced it would be worse than either.
//
// Returns null when there is nothing honest to push: the sale is gone, or every
// applicable checkpoint is still with a reviewer so there is no score. The
// payload's score is non-nullable and a missing one coerces to 0/fail, which
// would put a 0% QA record in the client's CRM for a sale nobody has judged.
async function buildJourneyPayload(
  organizationId: string,
  journeyId: string
): Promise<WebhookJourneyScoredPayload | null> {
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
  if (!journey) return null;
  // No score yet — every applicable checkpoint is still with a reviewer (see
  // jobs/processors/score-journey.ts). Holding is the only honest option: the
  // next resolution recomputes a real score and pushes then.
  if (journey.overall_score === null) {
    console.log(`[ScoreWriteback] Holding journey ${journeyId} — no score yet, all checkpoints await review`);
    return null;
  }

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
  return payload;
}

export async function pushJourneyScoreUpdate(organizationId: string, journeyId: string): Promise<void> {
  const payload = await buildJourneyPayload(organizationId, journeyId);
  if (!payload) return;

  deliverCallScored(organizationId, payload).catch((err) => {
    console.error(`[ScoreWriteback] journey.scored webhook failed for ${journeyId}:`, (err as Error).message);
  });

  // A human's corrected verdict reaches Zoho only if a record for this sale is
  // already there to correct (CG-4).
  //
  // This path fires when a reviewer resolves a checkpoint or overturns a score.
  // On a tenant that pushes on feedback, the sale may never have been sent — and
  // creating the QA record here would defeat the whole point of the setting:
  // the record would appear in the CRM off the back of an internal review step,
  // before anyone pressed Feedback. Once a round HAS been sent, the same edit is
  // exactly what should be reflected, so the update goes through.
  const settings = await getScoringSettings(organizationId);
  if (settings.zohoWritebackTrigger === 'on_feedback') {
    const sent = await queryOne<{ id: string }>(
      'SELECT id FROM journey_feedback WHERE journey_id = $1 LIMIT 1',
      [journeyId]
    );
    if (!sent) {
      console.log(
        `[ScoreWriteback] Holding Zoho write-back for journey ${journeyId} — tenant pushes on feedback and none has been sent`
      );
      return;
    }
  }

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
  // No score yet — every checkpoint on the call is still with a reviewer. Same
  // reasoning as the journey path above: a null score would push as 0%/fail.
  if (row.overall_score === null) {
    console.log(`[ScoreWriteback] Holding call ${callId} — no score yet, all checkpoints await review`);
    return;
  }

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

/**
 * Release a scored sale to Zoho because a supervisor has just fed it back
 * (CG-4).
 *
 * This is the write-back trigger Trust Point asked for: on a tenant set to
 * `on_feedback`, the scoring job holds the push, and this is what lets it go —
 * so nothing reaches the CRM, and nothing reaches an adviser's commission
 * process, that a person has not reviewed and released.
 *
 * No-op on the default `on_scoring` tenant. There the record went out when the
 * sale was scored, and pushing again here would either duplicate it or restate
 * a score nothing has changed. Feedback is not a scoring event.
 *
 * Scoped to `feedbackId`, so each round writes its own QA record: a second
 * round is a second conversation with the adviser, not a correction of the
 * first. The delivery layer retries against that same round (migration 113),
 * so a transient failure re-updates rather than duplicating.
 *
 * Best-effort, like every write-back here: never throws to the caller. The
 * feedback email has already gone out by this point and a Zoho outage must not
 * turn that into a failed request.
 */
export async function pushJourneyFeedbackRelease(
  organizationId: string,
  journeyId: string,
  feedbackId: string
): Promise<void> {
  try {
    const settings = await getScoringSettings(organizationId);
    if (settings.zohoWritebackTrigger !== 'on_feedback') return;

    const payload = await buildJourneyPayload(organizationId, journeyId);
    if (!payload) return;

    // Deliberately no webhook here. The `journey.scored` webhook already fired
    // when the sale was scored — that event was true then and re-firing it on
    // feedback would tell every integration a sale had been re-scored when
    // nothing about the score changed.
    await pushJourneyScored(organizationId, payload, feedbackId);
  } catch (err) {
    console.error(
      `[ScoreWriteback] Zoho feedback release failed for journey ${journeyId}:`,
      (err as Error).message
    );
  }
}
