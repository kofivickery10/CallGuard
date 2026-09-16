import { query, queryOne } from '../db/client.js';
import { alertsQueue } from '../jobs/queue.js';
import { isUuid } from './uuid.js';
import type { AlertRule, AlertChannelsConfig, AlertSeverity } from '@callguard/shared';

interface CallRow {
  id: string;
  organization_id: string;
  file_name: string;
  status: string;
  agent_name: string | null;
  error_message: string | null;
}

interface CallScoreRow {
  id: string;
  overall_score: number | null;
  pass: boolean | null;
}

// A sale, as an alert is raised on it: the score it reports, who it belongs to,
// and the wrap-up call the delivery hangs off. A sale has no call of its own,
// so alerts are attributed to the wrap-up (closing) adviser and delivered
// against the wrap-up call — the same attribution the score-writeback, the QA
// record and the review queue use.
interface JourneyRow {
  id: string;
  organization_id: string;
  overall_score: string | number | null;
  customer_name: string | null;
  anchor_call_id: string | null;
  anchor_file_name: string | null;
  agent_name: string | null;
}

interface ItemScoreRow {
  scorecard_item_id: string;
  // NULL for na and manual items, which carry no score (migration 040).
  normalized_score: number | null;
  // 'pass' | 'fail' is a verdict. 'manual_review' is a checkpoint held for a
  // person — possibly with the AI's provisional score attached — and 'na' did
  // not apply. Neither is a verdict an alert may report.
  result: string | null;
  label: string;
}

export interface AlertPayload {
  title: string;
  body: string;
  severity: AlertSeverity;
  call_id: string;
  call_file_name: string;
  agent_name: string | null;
  overall_score: number | null;
  matched_reason: string;
  // Where "view" should land, as an app-relative path. Optional: absent means
  // the classic per-call link (/calls/:call_id). Journey-level alerts (data
  // capture) point at the sale instead.
  action_url?: string | null;
  action_label?: string;
}

/**
 * Evaluate all active alert rules for a call and queue delivery jobs for any
 * that match. Called after a call is scored or has failed.
 */
export async function evaluateAlertsForCall(
  callId: string,
  status: 'scored' | 'failed'
): Promise<void> {
  await evaluateCallRules(callId, status, () => true);
}

/**
 * Evaluate the applicable alert rules for a SALE and queue delivery jobs for
 * any that match — the sale-scoring counterpart of evaluateAlertsForCall,
 * called from jobs/processors/score-journey.ts once a sale has been scored.
 *
 * Sale scoring used to raise no alerts at all. On a `sales_only` tenant the
 * calls behind a sale are never scored on their own (jobs/processors/
 * transcribe.ts), so evaluateAlertsForCall never ran for them and the firm's
 * email/Slack breach alerts simply never arrived, whatever rules they had
 * configured.
 *
 * Two of the four trigger types apply here, and the two that don't, don't for
 * reasons rather than by omission:
 *
 *  - item_below_threshold and low_overall_score are about a compliance verdict,
 *    which for a sales_only firm IS the sale. Both are evaluated below, against
 *    exactly the rules the per-call path uses.
 *  - processing_failed is about a recording that could not be processed. It
 *    still fires per call, from the transcription and scoring processors, which
 *    is where that failure happens and what its payload describes (a file name
 *    and the pipeline's error). A sale-scoring failure is a different event —
 *    the recordings are fine — and reporting it through a rule labelled "Call
 *    processing failed" would misdescribe it.
 *  - capture_missed_required is already a sale-level alert with its own entry
 *    point (evaluateCaptureRunAlerts), fired when the capture run completes.
 *    Data capture runs after scoring, so evaluating it here would either raise
 *    nothing or duplicate that alert.
 */
export async function evaluateAlertsForJourney(journeyId: string): Promise<void> {
  await evaluateJourneyRules(journeyId, () => true);
}

/**
 * Re-evaluate the rules that a reviewer's ruling can have made true, for one
 * checkpoint on one call or sale.
 *
 * Called after a manual-review checkpoint is resolved (routes/review.ts) and
 * after a verdict is corrected (routes/calls.ts, routes/journeys.ts). A held
 * checkpoint raises no alert when the AI scores it, because it is not a verdict
 * — so before this, the failure a PERSON confirmed, the one finding the
 * platform is most certain about, reached nobody at all.
 *
 * Only two rules can be made true by a ruling, so only those are evaluated:
 * the item rule for the checkpoint that was ruled on, and the overall-score
 * rule, since resolving changes the sale's or call's score. Everything else
 * about the entity is unchanged, and re-running the whole set would only find
 * alerts that were already sent. A confirmed pass or a "not applicable" ruling
 * matches neither rule and says nothing to anyone.
 *
 * Never throws into the caller: an alert must not fail a reviewer's action.
 */
export async function evaluateAlertsForResolvedItem(input: {
  kind: 'call' | 'journey';
  entityId: string;
  scorecardItemId: string;
}): Promise<void> {
  const { kind, entityId, scorecardItemId } = input;
  const applies = (rule: AlertRule): boolean =>
    rule.trigger_type === 'low_overall_score' ||
    (rule.trigger_type === 'item_below_threshold' &&
      String(rule.trigger_config.scorecard_item_id) === scorecardItemId);

  try {
    if (kind === 'call') {
      await evaluateCallRules(entityId, 'scored', applies);
    } else {
      await evaluateJourneyRules(entityId, applies);
    }
  } catch (err) {
    console.error(
      `[Alerts] Post-review evaluation failed for ${kind} ${entityId}:`,
      (err as Error).message
    );
  }
}

async function evaluateCallRules(
  callId: string,
  status: 'scored' | 'failed',
  applies: (rule: AlertRule) => boolean
): Promise<void> {
  const call = await queryOne<CallRow>(
    `SELECT id, organization_id, file_name, status, agent_name, error_message
       FROM calls WHERE id = $1`,
    [callId]
  );
  if (!call) return;

  const rules = (await loadActiveRules(call.organization_id)).filter(applies);
  if (rules.length === 0) return;

  // Load latest score + item scores if the call was scored
  let callScore: CallScoreRow | null = null;
  let itemScores: ItemScoreRow[] = [];
  if (status === 'scored') {
    callScore = await queryOne<CallScoreRow>(
      `SELECT id, overall_score, pass FROM call_scores
        WHERE call_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [callId]
    );
    if (callScore) {
      itemScores = await query<ItemScoreRow>(
        `SELECT cis.scorecard_item_id, cis.normalized_score, cis.result, si.label
           FROM call_item_scores cis
           JOIN scorecard_items si ON si.id = cis.scorecard_item_id
          WHERE cis.call_score_id = $1`,
        [callScore.id]
      );
    }
  }

  for (const rule of rules) {
    const match = evaluateRule(rule, status, call, callScore, itemScores);
    if (!match) continue;

    // Has this rule already been raised for this checkpoint on this call?
    // The durable record, not the job id, is what makes that answer survive a
    // re-score and the queue's 500-job memory (migration 117).
    if (!(await claimAlert(rule, 'call', call.id, call.organization_id, match.scorecardItemId))) {
      continue;
    }

    // BullMQ job id: the specific scoring pass when there is one, falling back
    // to the call itself for a 'failed' evaluation, which has no call_scores
    // row to key off. Unchanged, and now a second line of defence rather than
    // the only one — see claimAlert.
    await fanOutDeliveries(
      rule,
      { organizationId: call.organization_id, callId: call.id },
      match.payload,
      callScore?.id ?? call.id
    );
  }
}

async function evaluateJourneyRules(
  journeyId: string,
  applies: (rule: AlertRule) => boolean
): Promise<void> {
  const journey = await queryOne<JourneyRow>(
    `SELECT j.id, j.organization_id, j.overall_score::text AS overall_score,
            cust.name AS customer_name,
            wu.call_id AS anchor_call_id, wu.file_name AS anchor_file_name, wu.agent_name
       FROM journeys j
       LEFT JOIN customers cust ON cust.id = j.customer_id
       -- The wrap-up (closing) call: earliest call flagged wrap_up, else the
       -- latest call in the set. Mirrors jobs/processors/score-journey.ts and
       -- services/score-writeback.ts exactly, so the adviser an alert names is
       -- the adviser the sale is attributed to everywhere else.
       LEFT JOIN LATERAL (
         SELECT c.id AS call_id, c.file_name, c.agent_name
           FROM journey_calls jc
           JOIN calls c ON c.id = jc.call_id
          WHERE jc.journey_id = j.id
          ORDER BY (jc.role = 'wrap_up') DESC,
                   CASE WHEN jc.role = 'wrap_up'
                        THEN COALESCE(c.call_date, c.created_at) END ASC,
                   COALESCE(c.call_date, c.created_at) DESC
          LIMIT 1
       ) wu ON true
      WHERE j.id = $1`,
    [journeyId]
  );
  if (!journey) return;

  const rules = (await loadActiveRules(journey.organization_id)).filter(applies);
  if (rules.length === 0) return;

  const itemScores = await query<ItemScoreRow>(
    `SELECT jis.scorecard_item_id, jis.normalized_score, jis.result, si.label
       FROM journey_item_scores jis
       JOIN scorecard_items si ON si.id = jis.scorecard_item_id
      WHERE jis.journey_id = $1`,
    [journeyId]
  );

  for (const rule of rules) {
    const match = evaluateJourneyRule(rule, journey, itemScores);
    if (!match) continue;

    if (
      !(await claimAlert(rule, 'journey', journey.id, journey.organization_id, match.scorecardItemId))
    ) {
      continue;
    }

    // Job id keyed on the sale rather than on a scoring pass: a sale has one
    // identity across re-scores and reviewer rulings, and at most one alert per
    // rule to go with it (an item rule names a single checkpoint).
    await fanOutDeliveries(
      rule,
      { organizationId: journey.organization_id, callId: journey.anchor_call_id },
      match.payload,
      journey.id
    );
  }
}

async function loadActiveRules(organizationId: string): Promise<AlertRule[]> {
  return query<AlertRule>(
    `SELECT * FROM alert_rules
       WHERE organization_id = $1 AND is_active = true`,
    [organizationId]
  );
}

/**
 * Record that this rule has been raised for this checkpoint on this call or
 * sale, and report whether we were the ones who recorded it.
 *
 * `false` means somebody has already been told — by an earlier scoring pass, a
 * re-score, a reviewer's ruling, a correction, or a retry of any of them — and
 * this delivery must not go out. See migration 117 for why the record is
 * durable rather than a queue job id, and why at-most-once is the deliberate
 * choice over at-least-once for an alert channel.
 */
async function claimAlert(
  rule: AlertRule,
  entityType: 'call' | 'journey',
  entityId: string,
  organizationId: string,
  scorecardItemId: string | null
): Promise<boolean> {
  const claimed = await query<{ id: string }>(
    `INSERT INTO alert_events
       (organization_id, rule_id, entity_type, entity_id, scorecard_item_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organization_id, rule_id, entity_type, entity_id,
                  COALESCE(scorecard_item_id, '00000000-0000-0000-0000-000000000000'::uuid))
     DO NOTHING
     RETURNING id`,
    [organizationId, rule.id, entityType, entityId, scorecardItemId]
  );
  return claimed.length > 0;
}

/**
 * Evaluate capture_missed_required rules for a completed capture run. Fires
 * when the run left at least min_missed (default 1) required questions
 * unanswered — the "catch the gap before the application goes off" alert.
 * Called fire-and-forget from the capture processor; never throws into it.
 */
export async function evaluateCaptureRunAlerts(runId: string): Promise<void> {
  const run = await queryOne<{
    id: string;
    organization_id: string;
    journey_id: string | null;
    call_id: string | null;
    form_name: string;
  }>(
    `SELECT r.id, r.organization_id, r.journey_id, r.call_id, cf.name AS form_name
       FROM capture_runs r
       JOIN capture_forms cf ON cf.id = r.form_id
      WHERE r.id = $1 AND r.status = 'completed'`,
    [runId]
  );
  if (!run) return;

  const rules = await query<AlertRule>(
    `SELECT * FROM alert_rules
      WHERE organization_id = $1 AND is_active = true
        AND trigger_type = 'capture_missed_required'`,
    [run.organization_id]
  );
  if (rules.length === 0) return;

  const missed = await query<{ label: string }>(
    `SELECT f.label
       FROM capture_answers ca
       JOIN capture_form_fields f ON f.id = ca.field_id
      WHERE ca.run_id = $1 AND ca.result = 'missed' AND f.required
      ORDER BY f.sort_order`,
    [runId]
  );
  if (missed.length === 0) return;

  // Anchor the delivery on a real call: the run's own call, or the journey's
  // wrap-up call (fall back to any linked call). The user-facing link still
  // points at the sale via action_url.
  const anchor = await queryOne<CallRow>(
    run.call_id
      ? `SELECT id, organization_id, file_name, status, agent_name, error_message
           FROM calls WHERE id = $1`
      : `SELECT c.id, c.organization_id, c.file_name, c.status, c.agent_name, c.error_message
           FROM journey_calls jc
           JOIN calls c ON c.id = jc.call_id
          WHERE jc.journey_id = $1
          ORDER BY (jc.role = 'wrap_up') DESC, c.created_at DESC
          LIMIT 1`,
    [run.call_id ?? run.journey_id]
  );
  if (!anchor) return;

  const customer = run.journey_id
    ? await queryOne<{ name: string | null }>(
        `SELECT cust.name FROM journeys j
           JOIN customers cust ON cust.id = j.customer_id
          WHERE j.id = $1`,
        [run.journey_id]
      )
    : null;

  const subject = customer?.name ?? anchor.file_name;
  const listed = missed.slice(0, 5).map((m) => `"${m.label}"`).join('; ');
  const overflow = missed.length > 5 ? ` (+${missed.length - 5} more)` : '';

  for (const rule of rules) {
    const minMissed = Math.max(1, Number(rule.trigger_config.min_missed) || 1);
    if (missed.length < minMissed) continue;

    const payload: AlertPayload = {
      title: `Missed answers: ${subject}`,
      body: `${missed.length} required question${missed.length === 1 ? '' : 's'} went unanswered (${run.form_name}): ${listed}${overflow}`,
      severity: 'critical',
      call_id: anchor.id,
      call_file_name: anchor.file_name,
      agent_name: anchor.agent_name,
      overall_score: null,
      matched_reason: `${missed.length} required answer${missed.length === 1 ? '' : 's'} missed (threshold ${minMissed})`,
      action_url: run.journey_id ? `/journeys/${run.journey_id}` : `/calls/${anchor.id}`,
      action_label: run.journey_id ? 'View Sale' : 'View Call',
    };
    // Dedup key: the run, not just its anchor call — a call can anchor more
    // than one capture run over time, and each completed run is its own
    // evaluation pass (see fanOutDeliveries).
    //
    // Deliberately NOT claimed in alert_events. That record answers "has this
    // firm been told about this checkpoint on this sale", and a capture run is
    // not a checkpoint: a second run on the same sale — after the form was
    // fixed, or a later application pack — is a new fact about new answers, and
    // keying it on the sale would silence it for good. The run id already
    // identifies it uniquely.
    await fanOutDeliveries(
      rule,
      { organizationId: anchor.organization_id, callId: anchor.id },
      payload,
      run.id
    );
  }
}

// A matched rule: what to deliver, and which checkpoint (if any) it is about.
// The checkpoint is taken from the matched row rather than the rule's JSONB
// config, so the id recorded in alert_events is always a real scorecard item.
interface RuleMatch {
  payload: AlertPayload;
  scorecardItemId: string | null;
}

// Does this checkpoint's row fail the rule's threshold? Shared by the per-call
// and per-sale paths, which store their item scores in different tables but
// judge them by exactly the same standard.
function failsItemThreshold(
  rule: AlertRule,
  itemScores: ItemScoreRow[]
): { item: ItemScoreRow; score: number; threshold: number } | null {
  const itemId = String(rule.trigger_config.scorecard_item_id);
  const threshold = Number(rule.trigger_config.threshold);
  const item = itemScores.find((s) => s.scorecard_item_id === itemId);
  if (!item) return null;
  // Only a verdict can fail. A held checkpoint's provisional score is the
  // AI's suggestion awaiting a reviewer (score.ts keeps it out of the
  // weighted score and the breach register for the same reason), and a
  // manual or na item has a NULL score that Number() would read as 0 —
  // either way "Item failed" would reach the firm before anyone decided it.
  if (item.result !== 'pass' && item.result !== 'fail') return null;
  if (item.normalized_score == null) return null;
  const score = Number(item.normalized_score);
  if (score >= threshold) return null;
  return { item, score, threshold };
}

// Is this overall score below the rule's threshold? NULL is not a low score:
// it is the "nothing was auto-scored, every checkpoint awaits review" state,
// which the scoring jobs write rather than fabricating a 0.
function failsOverallThreshold(
  rule: AlertRule,
  overallScore: string | number | null | undefined
): { score: number; threshold: number } | null {
  if (overallScore == null) return null;
  const threshold = Number(rule.trigger_config.threshold);
  if (Number.isNaN(threshold)) return null;
  const score = Number(overallScore);
  if (score >= threshold) return null;
  return { score, threshold };
}

function evaluateRule(
  rule: AlertRule,
  status: 'scored' | 'failed',
  call: CallRow,
  callScore: CallScoreRow | null,
  itemScores: ItemScoreRow[]
): RuleMatch | null {
  switch (rule.trigger_type) {
    case 'low_overall_score': {
      if (status !== 'scored' || !callScore) return null;
      const match = failsOverallThreshold(rule, callScore.overall_score);
      if (!match) return null;
      return {
        scorecardItemId: null,
        payload: {
          title: `Low score: ${call.file_name}`,
          body: `Call scored ${Math.round(match.score)}% (threshold ${match.threshold}%)${call.agent_name ? ` — agent: ${call.agent_name}` : ''}`,
          severity: 'critical',
          call_id: call.id,
          call_file_name: call.file_name,
          agent_name: call.agent_name,
          overall_score: match.score,
          matched_reason: `overall score ${Math.round(match.score)}% < ${match.threshold}%`,
        },
      };
    }
    case 'item_below_threshold': {
      if (status !== 'scored') return null;
      const match = failsItemThreshold(rule, itemScores);
      if (!match) return null;
      return {
        scorecardItemId: match.item.scorecard_item_id,
        payload: {
          title: `Item failed: ${match.item.label}`,
          body: `"${match.item.label}" scored ${Math.round(match.score)}% on call ${call.file_name}`,
          severity: 'critical',
          call_id: call.id,
          call_file_name: call.file_name,
          agent_name: call.agent_name,
          overall_score: callScore?.overall_score != null ? Number(callScore.overall_score) : null,
          matched_reason: `${match.item.label} scored ${Math.round(match.score)}% < ${match.threshold}%`,
        },
      };
    }
    case 'processing_failed': {
      if (status !== 'failed') return null;
      return {
        scorecardItemId: null,
        payload: {
          title: `Processing failed: ${call.file_name}`,
          body: call.error_message || 'Call failed to process',
          severity: 'warning',
          call_id: call.id,
          call_file_name: call.file_name,
          agent_name: call.agent_name,
          overall_score: null,
          matched_reason: 'call processing failed',
        },
      };
    }
    default:
      return null;
  }
}

// The same two rules, asked of a sale. Identical standards — only the subject
// of the sentence changes, and the link points at the sale rather than at one
// of the calls it is made of.
function evaluateJourneyRule(
  rule: AlertRule,
  journey: JourneyRow,
  itemScores: ItemScoreRow[]
): RuleMatch | null {
  // What to call this sale in an alert. A sale spans several calls, so the
  // customer is what identifies it; the wrap-up recording's name is the
  // fallback for a sale whose customer has no name on record.
  const subject = journey.customer_name ?? journey.anchor_file_name ?? 'this sale';
  const base = {
    // A sale has no call of its own. Delivery hangs off the wrap-up call (so
    // alert_deliveries and the in-app notification point somewhere real) while
    // action_url sends the reader to the sale.
    call_id: journey.anchor_call_id ?? '',
    call_file_name: journey.anchor_file_name ?? subject,
    agent_name: journey.agent_name,
    action_url: `/journeys/${journey.id}`,
    action_label: 'View Sale',
  };

  switch (rule.trigger_type) {
    case 'low_overall_score': {
      const match = failsOverallThreshold(rule, journey.overall_score);
      if (!match) return null;
      return {
        scorecardItemId: null,
        payload: {
          ...base,
          title: `Low score: ${subject}`,
          body: `Sale scored ${Math.round(match.score)}% (threshold ${match.threshold}%)${journey.agent_name ? ` — adviser: ${journey.agent_name}` : ''}`,
          severity: 'critical',
          overall_score: match.score,
          matched_reason: `overall score ${Math.round(match.score)}% < ${match.threshold}%`,
        },
      };
    }
    case 'item_below_threshold': {
      const match = failsItemThreshold(rule, itemScores);
      if (!match) return null;
      return {
        scorecardItemId: match.item.scorecard_item_id,
        payload: {
          ...base,
          title: `Item failed: ${match.item.label}`,
          body: `"${match.item.label}" scored ${Math.round(match.score)}% on the sale for ${subject}`,
          severity: 'critical',
          overall_score: journey.overall_score == null ? null : Number(journey.overall_score),
          matched_reason: `${match.item.label} scored ${Math.round(match.score)}% < ${match.threshold}%`,
        },
      };
    }
    // processing_failed and capture_missed_required are not sale-scoring
    // events — see evaluateAlertsForJourney for why each is left alone.
    default:
      return null;
  }
}

async function fanOutDeliveries(
  rule: AlertRule,
  // Where the delivery hangs off: the org whose users and rule this is, and the
  // call the delivery record points at (a sale uses its wrap-up call; null when
  // there is no call to point at, which alert_deliveries.call_id allows).
  anchor: { organizationId: string; callId: string | null },
  payload: AlertPayload,
  // Identifies the specific evaluation pass this alert came from (a call
  // score id, a sale id, or a capture run id) — NOT just the call. BullMQ
  // dedupes on jobId, so keying purely on call.id (the old behaviour) meant
  // that once a rule had fired for a call, it could never fire again for that
  // call: a rescore that fixes the underlying issue and produces a genuinely
  // new, alert-worthy result would be silently swallowed instead of delivered.
  // Keying on the pass instead means each pass gets its own delivery, while
  // still deduping true repeats (the same rule re-matching within one pass,
  // e.g. two evaluateAlertsForCall calls for the same call_score).
  //
  // Since migration 117 this is the SECOND line of defence, not the only one:
  // whether a firm has already been told is answered by alert_events, which
  // outlives the queue's 500-job memory. This still stops a repeat inside one
  // pass without a database round trip.
  passId: string
): Promise<void> {
  const channels = rule.channels as AlertChannelsConfig;

  if (channels.email?.recipients?.length) {
    for (const recipient of channels.email.recipients) {
      await alertsQueue.add(
        'deliver',
        {
          ruleId: rule.id,
          callId: anchor.callId,
          channel: 'email',
          target: recipient,
          payload,
        },
        { jobId: `alert-${rule.id}-${passId}-email-${recipient}` }
      );
    }
  }

  if (channels.slack?.webhook_url) {
    await alertsQueue.add(
      'deliver',
      {
        ruleId: rule.id,
        callId: anchor.callId,
        channel: 'slack',
        target: channels.slack.webhook_url,
        payload,
      },
      { jobId: `alert-${rule.id}-${passId}-slack` }
    );
  }

  if (channels.in_app) {
    const userIds = await resolveInAppUserIds(anchor.organizationId, channels.in_app.user_ids);
    for (const userId of userIds) {
      await alertsQueue.add(
        'deliver',
        {
          ruleId: rule.id,
          callId: anchor.callId,
          channel: 'in_app',
          target: userId,
          payload,
        },
        { jobId: `alert-${rule.id}-${passId}-inapp-${userId}` }
      );
    }
  }
}

async function resolveInAppUserIds(
  organizationId: string,
  config: string[] | 'all_admins'
): Promise<string[]> {
  if (config === 'all_admins') {
    const admins = await query<{ id: string }>(
      `SELECT id FROM users WHERE organization_id = $1 AND role = 'admin'`,
      [organizationId]
    );
    return admins.map((a) => a.id);
  }
  if (!Array.isArray(config) || config.length === 0) return [];
  // Only deliver to users in the rule's own organisation. An explicit id list
  // is admin-supplied JSONB — without this filter, a rule configured with a
  // foreign user's UUID would push this org's call metadata into another
  // tenant's notifications (deliverInApp resolves the notification's org from
  // the TARGET user, not the rule). Non-UUID entries are dropped up front so
  // a malformed rule can't fail the cast and take down the whole fan-out.
  const candidates = config.filter(isUuid);
  if (candidates.length === 0) return [];
  const users = await query<{ id: string }>(
    `SELECT id FROM users WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
    [organizationId, candidates]
  );
  return users.map((u) => u.id);
}
