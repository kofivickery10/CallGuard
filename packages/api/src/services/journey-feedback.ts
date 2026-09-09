import crypto from 'crypto';
import { query, queryOne, withTransaction } from '../db/client.js';
import { config } from '../config.js';
import { alertsQueue } from '../jobs/queue.js';
import type { FeedbackEmailJob } from '../jobs/processors/feedback-email.js';
import { organisationKeepsHealthUnredacted } from './transcript-access.js';
import { orgHasFeature } from './tenant-settings.js';

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

export interface FeedbackRecipient {
  id: string;
  name: string;
  email: string | null;
  role: string;
  /** False only when there is no address to deliver to. */
  eligible: boolean;
}

/**
 * Everyone in the organisation who could be fed back to.
 *
 * Deliberately not GET /api/agents, for two reasons. That router is
 * requireAdmin (routes/agents.ts) while feeding back is requireActioner, so a
 * supervisor — the person who actually sends feedback — cannot call it. And it
 * returns per-adviser scores, pass rates and invite state, none of which a
 * recipient picker has any business exposing.
 *
 * Advisers first, then by name: the answer is almost always an adviser, and the
 * list should not make the supervisor hunt past three admins to find them.
 *
 * login_disabled is NOT filtered out. No-login advisers (061) are precisely who
 * the tokenised confirmation link was built for — excluding them here would
 * remove the people this feature exists to reach.
 *
 * Users with no address are returned rather than hidden, marked ineligible. A
 * supervisor who cannot find someone in the list needs to be told why they are
 * undeliverable, not left to conclude the person is gone.
 */
export async function resolveRecipients(organizationId: string): Promise<FeedbackRecipient[]> {
  const rows = await query<{
    id: string;
    name: string;
    email: string | null;
    role: string;
  }>(
    `SELECT id, name, email, role
       FROM users
      WHERE organization_id = $1
      ORDER BY (role = 'adviser') DESC, name`,
    [organizationId]
  );
  return rows.map((r) => ({ ...r, eligible: r.email !== null && r.email !== '' }));
}

/**
 * The recipient a supervisor explicitly chose.
 *
 * Scoped by organisation, not looked up by id alone: a user id from another
 * tenant must not be feedable, and the check belongs here rather than trusting
 * the route to have done it.
 */
export async function resolveChosenRecipient(
  organizationId: string,
  userId: string
): Promise<AdviserTarget> {
  const row = await queryOne<{ id: string; name: string; email: string | null }>(
    'SELECT id, name, email FROM users WHERE id = $1 AND organization_id = $2',
    [userId, organizationId]
  );
  if (!row) {
    throw new Error('That person is no longer on this team, so the feedback was not sent.');
  }
  if (!row.email) {
    return { userId: row.id, name: row.name, email: null, problem: 'no_email' };
  }
  return { userId: row.id, name: row.name, email: row.email, problem: null };
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
  recipient_source: RecipientSource;
  suggested_adviser_user_id: string | null;
}

export async function latestFeedback(
  organizationId: string,
  journeyId: string
): Promise<FeedbackRow | null> {
  return queryOne<FeedbackRow>(
    `SELECT id, journey_id, adviser_user_id, adviser_name, adviser_email,
            sent_by, sent_at, message, confirmed_at, token_expires_at,
            recipient_source, suggested_adviser_user_id
       FROM journey_feedback
      WHERE organization_id = $1 AND journey_id = $2
      ORDER BY sent_at DESC LIMIT 1`,
    [organizationId, journeyId]
  );
}

/** Where the recipient came from. Widened, not replaced, if a CRM owner lands. */
export type RecipientSource = 'default_last_caller' | 'manual';

export interface SendResult {
  feedbackId: string;
  itemCount: number;
  adviser: AdviserTarget;
  recipientSource: RecipientSource;
  /** Who resolveAdviser would have picked — null when the sale is unattributed. */
  suggestedAdviserUserId: string | null;
  /** Their name, for the audit line. Null when there was no attributed adviser. */
  suggestedAdviserName: string | null;
}

/**
 * Everything one send produces: the email payload, and the audit rows that have
 * to agree with it.
 *
 * Returned together, from one computation, deliberately. The snapshot's whole
 * value is that it records what the adviser was actually told — so it must be
 * written FROM the payload that was built, never recomputed alongside it. Two
 * derivations of the same policy can drift, and the moment they do the record
 * stops being evidence of anything.
 */
export interface FeedbackSend {
  payload: FeedbackEmailJob;
  snapshot: {
    clientName: string | null;
    score: number | null;
    pass: boolean | null;
    reasoningWithheld: boolean;
    items: Array<{
      scorecardItemId: string;
      itemLabel: string;
      severity: string;
      breachId: string;
      /** Exactly what travelled. Null where nothing did — see migration 110. */
      reasoning: string | null;
    }>;
  };
}

/**
 * Decide what leaves the platform, and record the same decision.
 *
 * Pure, so both policy gates can be tested without a database or a queue.
 *
 * `includeReasoning` false means the tenant keeps health unredacted, so the
 * model's sentence may quote a health disclosure in the clear (DPIA R5). The key
 * is OMITTED rather than nulled: the payload persists in Redis, and a field that
 * is not there cannot be read out of a completed job.
 *
 * `includeVerdict` false is score_only, given the same treatment for the reason
 * routes/share.ts states — withholding a value from the display while shipping
 * it in the payload withholds nothing.
 */
export function buildFeedbackSend(input: {
  adviserEmail: string;
  adviserName: string;
  confirmUrl: string;
  message: string | null;
  clientName: string | null;
  score: number | null;
  pass: boolean | null;
  breaches: FeedbackBreach[];
  includeReasoning: boolean;
  includeVerdict: boolean;
  // Can this adviser actually sign in to CallGuard?
  //
  // Only consulted when reasoning is withheld, and then it decides which true
  // sentence the email carries. Advisers commonly have no login at all (061),
  // and Trust Point's have none: telling them the detail "is in CallGuard" sends
  // them somewhere they cannot reach. The tokenised confirm link is not an
  // answer either — lookupFeedback returns a name and a status, never the
  // findings — so for those advisers the honest pointer is their supervisor,
  // who has just been through it with them.
  recipientCanSignIn: boolean;
}): FeedbackSend {
  const {
    adviserEmail,
    adviserName,
    confirmUrl,
    message,
    clientName,
    score,
    pass,
    breaches,
    includeReasoning,
    includeVerdict,
    recipientCanSignIn,
  } = input;

  // "Withheld" is an assertion about something that existed. A sale whose
  // findings carry no reasoning at all has had nothing withheld from it, and
  // saying otherwise would make the record claim a suppression that never
  // happened.
  const reasoningWithheld = !includeReasoning && breaches.some((b) => !!b.reasoning);

  const items = breaches.map((b) => {
    const sent = includeReasoning ? b.reasoning : null;
    return sent
      ? { label: b.item_label, severity: b.severity, reasoning: sent }
      : { label: b.item_label, severity: b.severity };
  });

  const payload: FeedbackEmailJob = {
    to: adviserEmail,
    adviserName,
    confirmUrl,
    message,
    clientName,
    score,
    items,
    // Tells the template that reasoning existed and policy kept it out, rather
    // than silently dropping it and leaving a shorter email that still looked
    // complete. Carries no content of its own.
    //
    // `recipientCanSignIn` rides with it because it changes where the template
    // sends the reader, and only matters when something was withheld.
    ...(reasoningWithheld ? { reasoningWithheld: true, recipientCanSignIn } : {}),
    ...(includeVerdict ? { pass } : {}),
  };

  return {
    payload,
    snapshot: {
      clientName,
      score,
      // Not asserted under score_only, so the record says nothing rather than
      // holding a verdict the adviser was never shown.
      pass: includeVerdict ? pass : null,
      reasoningWithheld,
      items: breaches.map((b, i) => ({
        scorecardItemId: b.scorecard_item_id,
        itemLabel: b.item_label,
        severity: b.severity,
        breachId: b.breach_id,
        reasoning: items[i].reasoning ?? null,
      })),
    },
  };
}

/**
 * Record the feedback, snapshot what it covered, and email the adviser a
 * one-click confirmation link.
 *
 * The snapshot is the point. A record saying only "this sale was fed back" is
 * misleading the moment the sale is re-scored and its breach set changes — it
 * would imply the adviser was told about findings that did not exist when the
 * email went out. See migrations 087 and 110.
 */
export async function sendFeedback(input: {
  organizationId: string;
  journeyId: string;
  sentBy: string;
  message: string | null;
  /** A recipient the supervisor picked. Omitted means take the sale's own adviser. */
  adviserUserId?: string | null;
}): Promise<SendResult> {
  const { organizationId, journeyId, sentBy, message, adviserUserId } = input;

  // Resolved on every send, chosen recipient or not: it is what
  // suggested_adviser_user_id records, and an override is only evidence of
  // anything if what was overridden is stored beside it.
  const suggested = await resolveAdviser(journeyId);
  const adviser = adviserUserId
    ? await resolveChosenRecipient(organizationId, adviserUserId)
    : suggested;

  // An override is a DIFFERENT recipient, not merely a named one. The panel
  // always posts adviser_user_id — it pre-fills the picker with the suggestion —
  // so keying off its presence would mark every ordinary send as manual and
  // leave the flag distinguishing nothing, which is worse than not recording it:
  // a column that reads as evidence and is not. A supervisor who opens the
  // picker, sees the right person already there and sends is accepting the
  // default, and that is what gets recorded.
  const recipientSource: RecipientSource =
    adviserUserId !== null && adviserUserId !== undefined && adviserUserId !== suggested.userId
      ? 'manual'
      : 'default_last_caller';

  if (!adviser.email) {
    throw new Error(
      adviser.problem === 'no_adviser'
        ? 'This sale has no adviser attributed to it. Choose who to send the feedback to.'
        : `${adviser.name} has no email address on their account, so the feedback cannot be delivered. Add one in Settings → Team first, or choose someone else.`
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

  // EVERY read the email needs happens HERE, before the transaction, and never
  // after it. A read that fails after the commit leaves journey_feedback and a
  // breach_events 'feedback_sent' row per breach asserting the adviser was told
  // about findings nobody sent — the exact state the two guards above exist to
  // prevent. Keeping these reads out of the transaction (which must stay short)
  // never required running them after it.
  //
  // customers.name is the fallback because journeys.client_name is null on every
  // sale pushed before the CRM backfill. score-journey and score-writeback both
  // already resolve the name this way; a third reader with its own rule is how a
  // sale ends up named in the CRM and unnamed in the email.
  const sale = await queryOne<{
    client_name: string | null;
    customer_name: string | null;
    overall_score: string | null;
    pass: boolean | null;
  }>(
    `SELECT j.client_name, j.overall_score, j.pass, cust.name AS customer_name
       FROM journeys j
       LEFT JOIN customers cust ON cust.id = j.customer_id
      WHERE j.id = $1 AND j.organization_id = $2`,
    [journeyId, organizationId]
  );

  // Trimmed: a whitespace-only CRM field is truthy enough to suppress the
  // "Reviewed sale" fallback while rendering as an empty name.
  const clientName = sale?.client_name?.trim() || sale?.customer_name?.trim() || null;

  // NUMERIC(5,2) arrives from pg as a string. Coerced once, here, so the
  // template's NaN guard is checking the type it believes it is checking.
  const score = sale?.overall_score == null ? null : Number(sale.overall_score);

  const [keepsHealthUnredacted, scoreOnly] = await Promise.all([
    organisationKeepsHealthUnredacted(organizationId),
    orgHasFeature(organizationId, 'score_only'),
  ]);

  // Whether this adviser could open CallGuard if the email told them to.
  //
  // An email address is not a login: an adviser row can carry one and still have
  // no password set, or have had login revoked (061). Both are the same thing to
  // a reader standing in front of a sign-in page they cannot get past.
  const recipientCanSignIn = adviser.userId
    ? !!(await queryOne<{ id: string }>(
        `SELECT id FROM users
          WHERE id = $1 AND organization_id = $2
            AND login_disabled = false AND password_hash IS NOT NULL`,
        [adviser.userId, organizationId]
      ))
    : false;

  const raw = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const { payload, snapshot } = buildFeedbackSend({
    adviserEmail: adviser.email,
    adviserName: adviser.name,
    confirmUrl: `${config.appUrl}/feedback/${raw}`,
    message,
    clientName,
    score,
    pass: sale?.pass ?? null,
    breaches,
    includeReasoning: !keepsHealthUnredacted,
    includeVerdict: !scoreOnly,
    recipientCanSignIn,
  });

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
         sent_by, message, token_hash, token_expires_at,
          recipient_source, suggested_adviser_user_id,
          client_name, score, pass, reasoning_withheld)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
        recipientSource,
        suggested.userId,
        // From the snapshot, never recomputed: these are the claims the email
        // makes, and the record has to be of those exact claims.
        snapshot.clientName,
        snapshot.score,
        snapshot.pass,
        snapshot.reasoningWithheld,
      ]
    );
    const id = feedback!.id;

    for (const item of snapshot.items) {
      await tx.query(
        `INSERT INTO journey_feedback_items
           (feedback_id, scorecard_item_id, item_label, severity, breach_id, reasoning)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (feedback_id, scorecard_item_id) DO NOTHING`,
        [id, item.scorecardItemId, item.itemLabel, item.severity, item.breachId, item.reasoning]
      );
      await tx.query(
        `INSERT INTO breach_events (breach_id, user_id, event_type, to_value)
         VALUES ($1, $2, 'feedback_sent', $3)`,
        [item.breachId, sentBy, adviser.name]
      );
    }

    return id;
  });

  // Enqueued only after the transaction has committed, and never inside it: a
  // rollback must never be followed by an email pointing at a row that no
  // longer exists.
  //
  // removeOnComplete overrides the queue default of keeping the last 500. This
  // payload carries a named client next to compliance findings, a materially
  // different thing to leave sitting in Redis than a zoho-retry, and there is no
  // operational reason to keep it once it has been sent.
  await alertsQueue.add('feedback-email', payload, { removeOnComplete: true });

  return {
    feedbackId,
    itemCount: breaches.length,
    adviser,
    recipientSource,
    suggestedAdviserUserId: suggested.userId,
    // Gated on the id, not the name: resolveAdviser returns the placeholder
    // 'Unknown adviser' for an unattributed sale, and naming that in an audit
    // line would read as a real person who was passed over.
    suggestedAdviserName: suggested.userId ? suggested.name : null,
  };
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
