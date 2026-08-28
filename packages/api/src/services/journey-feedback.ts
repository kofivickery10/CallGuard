import crypto from 'crypto';
import { query, queryOne, withTransaction } from '../db/client.js';
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
  // Why the checkpoint was not met, as the model put it — the coaching line the
  // adviser needs to act on the email without signing in.
  //
  // `reasoning` and NOT `evidence`, deliberately. Evidence is verbatim customer
  // speech: across the corpus it averages 163 characters and 622 rows of it
  // carry source-redaction tags, because it is transcript. Reasoning is the
  // model's own sentence about the adviser's conduct, averages 92 characters,
  // and carries a tag in 13 rows. Email is an insecure, persistent channel
  // outside the platform, so the quoted call goes behind the link and only the
  // finding travels.
  reasoning: string | null;
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
            b.severity, b.status, jis.reasoning
       FROM breaches b
       JOIN scorecard_items si ON si.id = b.scorecard_item_id
       -- LEFT: a breach raised against a per-call score has no journey item
       -- score, and one missing reason must not drop the whole finding.
       LEFT JOIN journey_item_scores jis ON jis.id = b.journey_item_score_id
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

  // The delete-and-replace and every insert it depends on run as one
  // transaction: if the INSERT (or a breach_events insert) fails partway
  // through, the adviser's previous working link must still be there rather
  // than deleted with nothing to replace it.
  const feedbackId = await withTransaction(async (tx) => {
    // A previous unconfirmed feedback is superseded rather than blocking: the
    // partial unique index allows one open per sale, and re-sending is a normal
    // thing to do when the first was never acknowledged. Scoped by organisation
    // like every other write here — journey_id alone is not tenant-safe.
    await tx.query(
      `DELETE FROM journey_feedback
        WHERE journey_id = $1 AND organization_id = $2 AND confirmed_at IS NULL`,
      [journeyId, organizationId]
    );

    const feedback = await tx.queryOne<{ id: string }>(
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
    const id = feedback!.id;

    for (const b of breaches) {
      await tx.query(
        `INSERT INTO journey_feedback_items
           (feedback_id, scorecard_item_id, item_label, severity, breach_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (feedback_id, scorecard_item_id) DO NOTHING`,
        [id, b.scorecard_item_id, b.item_label, b.severity, b.breach_id]
      );
      await tx.query(
        `INSERT INTO breach_events (breach_id, user_id, event_type, to_value)
         VALUES ($1, $2, 'feedback_sent', $3)`,
        [b.breach_id, sentBy, adviser.name]
      );
    }

    return id;
  });

  // Enqueued only after the transaction has committed, and never inside it: a
  // rollback must never be followed by an email pointing at a row that no
  // longer exists.
  // Read after the commit rather than threaded through it: the score and the
  // client name are the sale's, not the feedback record's, and re-reading them
  // here keeps this out of the transaction that must stay short.
  const sale = await queryOne<{ client_name: string | null; overall_score: number | null }>(
    `SELECT client_name, overall_score FROM journeys WHERE id = $1 AND organization_id = $2`,
    [journeyId, organizationId]
  );

  await alertsQueue.add('feedback-email', {
    to: adviser.email,
    adviserName: adviser.name,
    confirmUrl: `${config.appUrl}/feedback/${raw}`,
    message,
    clientName: sale?.client_name ?? null,
    // Null where the sale carries no score — a sale held at nothingAutoScored
    // has findings worth feeding back but no number, and printing "0%" on one
    // would be a lie about an adviser whose score has not been decided.
    score: sale?.overall_score ?? null,
    items: breaches.map((b) => ({
      label: b.item_label,
      severity: b.severity,
      reasoning: b.reasoning,
    })),
  });

  return { feedbackId, itemCount: breaches.length, adviser };
}

export interface ConfirmResult {
  status: 'confirmed' | 'already_confirmed' | 'expired' | 'not_found';
  adviserName?: string;
  itemCount?: number;
}

export interface LookupResult {
  status: 'pending' | 'already_confirmed' | 'expired' | 'not_found';
  adviserName?: string;
  itemCount?: number;
}

/**
 * What a link opened by a page load learns, and nothing more: it reads the
 * same row `confirmFeedback` reads, and follows the same not_found /
 * already_confirmed / expired checks in the same order, but writes NOTHING —
 * no UPDATE, no breach_events row. `'pending'` is the case where
 * `confirmFeedback` would go on to confirm; here it just means "there is
 * something to confirm", so the page can name the adviser and put a real
 * confirm button in front of them instead of doing it for them.
 */
export async function lookupFeedback(rawToken: string): Promise<LookupResult> {
  const row = await queryOne<{
    id: string;
    adviser_name: string;
    confirmed_at: string | null;
    token_expires_at: string;
  }>(
    `SELECT id, adviser_name, confirmed_at, token_expires_at
       FROM journey_feedback WHERE token_hash = $1`,
    [hashFeedbackToken(rawToken)]
  );

  if (!row) return { status: 'not_found' };
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

  const n = await queryOne<{ n: string }>(
    'SELECT count(*) AS n FROM journey_feedback_items WHERE feedback_id = $1',
    [row.id]
  );
  return { status: 'pending', adviserName: row.adviser_name, itemCount: Number(n?.n ?? 0) };
}

/**
 * The adviser's confirmation, behind a deliberate POST. Unauthenticated by
 * necessity — the recipient may have no login at all — so the token is the
 * credential: single-use, time-bound, and stored only as a hash.
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
  // Idempotent, not a prefetch guard: confirmation only happens on a POST now
  // (the GET is lookupFeedback, above, which writes nothing), so a mail
  // scanner prefetching the emailed link can no longer confirm anything. This
  // branch instead covers an adviser who double-clicks the confirm button, or
  // whose POST is retried after a dropped response — they must see success
  // rather than an error either way.
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
