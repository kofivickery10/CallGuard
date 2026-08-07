import crypto from 'crypto';
import { query, queryOne } from '../db/client.js';
import { config } from '../config.js';
import { alertsQueue } from '../jobs/queue.js';

// ============================================================
// Feeding a reviewed sale back to the adviser, and recording that they saw it.
//
// One feedback per sale, covering every breach that stood at the moment it was
// sent. The adviser confirms with a single click on a tokenised link, which is
// the only channel that reaches an adviser with no login (061).
//
// Deliberately separate from breaches.confirmed_by/confirmed_at (078), which
// means something else entirely: that a HUMAN REVIEWER ruled the breach genuine.
// Two different confirmations by two different people for two different reasons,
// and conflating them on one column would make both unreadable.
// ============================================================

/** How long an adviser has to click. Long enough for leave, short enough to expire. */
const TOKEN_TTL_DAYS = 30;

export function hashFeedbackToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export interface AdviserTarget {
  userId: string | null;
  name: string;
  email: string | null;
  /** Why no email, when there isn't one — shown to the supervisor verbatim. */
  problem: 'no_adviser' | 'no_email' | null;
}

/**
 * Who gets fed back for this sale.
 *
 * The sale's closing adviser: the earliest call flagged wrap_up, else the latest
 * call in the set. That is not a new rule — it is how journeys are already
 * attributed for adviser scores, journey-level breaches and the Zoho write-back
 * (see JOURNEY_AGENT_JOIN in routes/breaches.ts). A sale touched by three people
 * has one accountable adviser, and it needs to be the same one everywhere.
 */
export async function resolveAdviser(journeyId: string): Promise<AdviserTarget> {
  const row = await queryOne<{
    agent_id: string | null;
    agent_name: string | null;
    user_email: string | null;
    user_name: string | null;
  }>(
    `SELECT c.agent_id, c.agent_name, u.email AS user_email, u.name AS user_name
       FROM journey_calls jc
       JOIN calls c ON c.id = jc.call_id
       LEFT JOIN users u ON u.id = c.agent_id
      WHERE jc.journey_id = $1
      ORDER BY (jc.role = 'wrap_up') DESC,
               CASE WHEN jc.role = 'wrap_up'
                    THEN COALESCE(c.call_date, c.created_at) END ASC,
               COALESCE(c.call_date, c.created_at) DESC
      LIMIT 1`,
    [journeyId]
  );

  if (!row || (!row.agent_id && !row.agent_name)) {
    return { userId: null, name: 'Unknown adviser', email: null, problem: 'no_adviser' };
  }

  const name = row.user_name ?? row.agent_name ?? 'Unknown adviser';
  if (!row.agent_id || !row.user_email) {
    // A no-login adviser (061) can exist with no email at all. Feeding back to
    // them is blocked rather than silently recorded as sent, because a feedback
    // record nobody received is worse than none.
    return { userId: row.agent_id, name, email: null, problem: 'no_email' };
  }
  return { userId: row.agent_id, name, email: row.user_email, problem: null };
}

export interface FeedbackBreach {
  breach_id: string;
  scorecard_item_id: string;
  item_label: string;
  severity: string;
  status: string;
}

/**
 * The breaches that would be fed back for this sale.
 *
 * Excludes 'resolved' and 'noted': a breach a supervisor has already dismissed
 * is not something to tell the adviser off about. Everything else stands,
 * including ones already marked coached, because this is the record that the
 * conversation happened rather than a queue to work through.
 */
export async function breachesForFeedback(
  organizationId: string,
  journeyId: string
): Promise<FeedbackBreach[]> {
  return query<FeedbackBreach>(
    `SELECT b.id AS breach_id, b.scorecard_item_id, si.label AS item_label,
            b.severity, b.status
       FROM breaches b
       JOIN scorecard_items si ON si.id = b.scorecard_item_id
      WHERE b.organization_id = $1
        AND b.journey_id = $2
        AND b.status NOT IN ('resolved', 'noted')
      ORDER BY CASE b.severity
                 WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                 WHEN 'medium' THEN 2 ELSE 3 END,
               si.label`,
    [organizationId, journeyId]
  );
}

/**
 * Checkpoints on this sale still waiting for a human ruling.
 *
 * Reported to the supervisor, never used to block: they may have good reason to
 * feed back now. But telling an adviser about a breach that is overturned an
 * hour later costs more trust than it saves time, so the gap is made visible.
 */
export async function openReviewCount(journeyId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `SELECT count(*) AS n FROM journey_item_scores
      WHERE journey_id = $1 AND result = 'manual_review'`,
    [journeyId]
  );
  return Number(row?.n ?? 0);
}

export interface FeedbackRow {
  id: string;
  journey_id: string;
  adviser_user_id: string | null;
  adviser_name: string;
  adviser_email: string;
  sent_by: string | null;
  sent_at: string;
  message: string | null;
  confirmed_at: string | null;
  token_expires_at: string;
}

export async function latestFeedback(
  organizationId: string,
  journeyId: string
): Promise<FeedbackRow | null> {
  return queryOne<FeedbackRow>(
    `SELECT id, journey_id, adviser_user_id, adviser_name, adviser_email,
            sent_by, sent_at, message, confirmed_at, token_expires_at
       FROM journey_feedback
      WHERE organization_id = $1 AND journey_id = $2
      ORDER BY sent_at DESC LIMIT 1`,
    [organizationId, journeyId]
  );
}

export interface SendResult {
  feedbackId: string;
  itemCount: number;
  adviser: AdviserTarget;
}

/**
 * Record the feedback, snapshot what it covered, and email the adviser a
 * one-click confirmation link.
 *
 * The snapshot is the point. A record saying only "this sale was fed back" is
 * misleading the moment the sale is re-scored and its breach set changes — it
 * would imply the adviser was told about findings that did not exist when the
 * email went out. See migration 087.
 */
export async function sendFeedback(input: {
  organizationId: string;
  journeyId: string;
  sentBy: string;
  message: string | null;
}): Promise<SendResult> {
  const { organizationId, journeyId, sentBy, message } = input;

  const adviser = await resolveAdviser(journeyId);
  if (!adviser.email) {
    throw new Error(
      adviser.problem === 'no_adviser'
        ? 'This sale has no adviser attributed to it, so there is nobody to feed back to.'
        : `${adviser.name} has no email address on their account, so the feedback cannot be delivered. Add one in Settings → Team first.`
    );
  }

  // Checked before anything is written. sendEmail returns ok:false with no API
  // key rather than throwing, so without this the record would say the adviser
  // was told while the job retried and died — the same lie as recording a send
  // to an adviser with no address, which this feature already refuses.
  // requiredInProduction means production cannot boot without the key, so this
  // is really a guard for dev and staging.
  if (!config.resend.apiKey) {
    throw new Error(
      'Email delivery is not configured (RESEND_API_KEY), so feedback cannot be sent or confirmed.'
    );
  }

  const breaches = await breachesForFeedback(organizationId, journeyId);

  const raw = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  // A previous unconfirmed feedback is superseded rather than blocking: the
  // partial unique index allows one open per sale, and re-sending is a normal
  // thing to do when the first was never acknowledged.
  await query(
    `DELETE FROM journey_feedback
      WHERE journey_id = $1 AND confirmed_at IS NULL`,
    [journeyId]
  );

  const feedback = await queryOne<{ id: string }>(
    `INSERT INTO journey_feedback
       (organization_id, journey_id, adviser_user_id, adviser_name, adviser_email,
        sent_by, message, token_hash, token_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      organizationId,
      journeyId,
      adviser.userId,
      adviser.name,
      adviser.email,
      sentBy,
      message,
      hashFeedbackToken(raw),
      expiresAt.toISOString(),
    ]
  );
  const feedbackId = feedback!.id;

  for (const b of breaches) {
    await query(
      `INSERT INTO journey_feedback_items
         (feedback_id, scorecard_item_id, item_label, severity, breach_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (feedback_id, scorecard_item_id) DO NOTHING`,
      [feedbackId, b.scorecard_item_id, b.item_label, b.severity, b.breach_id]
    );
    await query(
      `INSERT INTO breach_events (breach_id, user_id, event_type, to_value)
       VALUES ($1, $2, 'feedback_sent', $3)`,
      [b.breach_id, sentBy, adviser.name]
    );
  }

  await alertsQueue.add('feedback-email', {
    to: adviser.email,
    adviserName: adviser.name,
    confirmUrl: `${config.appUrl}/feedback/${raw}`,
    message,
    items: breaches.map((b) => ({ label: b.item_label, severity: b.severity })),
  });

  return { feedbackId, itemCount: breaches.length, adviser };
}

export interface ConfirmResult {
  status: 'confirmed' | 'already_confirmed' | 'expired' | 'not_found';
  adviserName?: string;
  itemCount?: number;
}

/**
 * The adviser's one click. Unauthenticated by necessity — the recipient may have
 * no login at all — so the token is the credential: single-use, time-bound, and
 * stored only as a hash.
 */
export async function confirmFeedback(
  rawToken: string,
  meta: { ip: string | null; userAgent: string | null }
): Promise<ConfirmResult> {
  const row = await queryOne<{
    id: string;
    organization_id: string;
    journey_id: string;
    adviser_name: string;
    adviser_user_id: string | null;
    confirmed_at: string | null;
    token_expires_at: string;
  }>(
    `SELECT id, organization_id, journey_id, adviser_name, adviser_user_id,
            confirmed_at, token_expires_at
       FROM journey_feedback WHERE token_hash = $1`,
    [hashFeedbackToken(rawToken)]
  );

  if (!row) return { status: 'not_found' };
  // Idempotent: an adviser who clicks the link twice, or whose mail client
  // prefetches it, must see success rather than an error.
  if (row.confirmed_at) {
    const n = await queryOne<{ n: string }>(
      'SELECT count(*) AS n FROM journey_feedback_items WHERE feedback_id = $1',
      [row.id]
    );
    return {
      status: 'already_confirmed',
      adviserName: row.adviser_name,
      itemCount: Number(n?.n ?? 0),
    };
  }
  if (new Date(row.token_expires_at).getTime() < Date.now()) {
    return { status: 'expired', adviserName: row.adviser_name };
  }

  await query(
    `UPDATE journey_feedback
        SET confirmed_at = now(), confirmed_ip = $2, confirmed_user_agent = $3
      WHERE id = $1`,
    [row.id, meta.ip, meta.userAgent?.slice(0, 500) ?? null]
  );

  const items = await query<{ breach_id: string | null }>(
    'SELECT breach_id FROM journey_feedback_items WHERE feedback_id = $1',
    [row.id]
  );
  for (const item of items) {
    if (!item.breach_id) continue;
    await query(
      `INSERT INTO breach_events (breach_id, user_id, event_type, to_value)
       VALUES ($1, $2, 'feedback_confirmed', $3)`,
      [item.breach_id, row.adviser_user_id, row.adviser_name]
    );
  }

  return { status: 'confirmed', adviserName: row.adviser_name, itemCount: items.length };
}
