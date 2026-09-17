import crypto from 'crypto';
import { query, queryOne, withTransaction } from '../db/client.js';
import { config } from '../config.js';
import { alertsQueue } from '../jobs/queue.js';
import type { FeedbackEmailJob } from '../jobs/processors/feedback-email.js';
import { organisationKeepsHealthUnredacted } from './transcript-access.js';
import { orgHasFeature } from './tenant-settings.js';
import { ORG_WIDE_ROLES, REMEDIATION_OUTCOMES, REMEDIATION_NOTE_MAX } from '@callguard/shared';
import type { RemediationOutcome } from '@callguard/shared';

// ============================================================
// Feeding a reviewed sale, or a call scored on its own, back to the adviser,
// and recording that they saw it.
//
// One feedback per subject, covering every breach that stood at the moment it
// was sent. The subject is a sale, or — where the firm's scoring setting is not
// sales_only (scoresCallsIndividually) — a call (migration 118). A call that
// belongs to a sale is never a subject of its own: the sale's feedback already covers it, and
// feeding it back twice would give one conversation two acknowledgement states.
// The file and table keep their journey_ names; call_feedback was already taken
// by 008 for something else.
//
// The adviser confirms with a single click on a tokenised link, which is the
// only channel that reaches an adviser with no login (061). That half — token,
// confirmation, outcomes — never looks at the subject at all. Only the review
// half branches on it: who gets it by default, which findings stand, and what
// the email names.
//
// Deliberately separate from breaches.confirmed_by/confirmed_at (078), which
// means something else entirely: that a HUMAN REVIEWER ruled the breach genuine.
// Two different confirmations by two different people for two different reasons,
// and conflating them on one column would make both unreadable.
// ============================================================

/** How long an adviser has to click. Long enough for leave, short enough to expire. */
const TOKEN_TTL_DAYS = 30;

/** What a round of feedback is about. */
export interface FeedbackSubject {
  kind: 'journey' | 'call';
  id: string;
}

/**
 * The journey_feedback column that names this subject.
 *
 * A fixed mapping to two literals rather than anything built from input, so the
 * only strings that can ever be interpolated into SQL from here are these.
 */
function subjectColumn(subject: FeedbackSubject): 'journey_id' | 'call_id' {
  return subject.kind === 'call' ? 'call_id' : 'journey_id';
}

/** The word a supervisor or adviser reads for this subject. */
export function subjectNoun(kind: FeedbackSubject['kind']): 'sale' | 'call' {
  return kind === 'call' ? 'call' : 'sale';
}

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
 * Who gets fed back for this subject, by default.
 *
 * For a sale, its closing adviser: the earliest call flagged wrap_up, else the
 * latest call in the set. That is not a new rule — it is how journeys are
 * already attributed for adviser scores, journey-level breaches and the Zoho
 * write-back (see JOURNEY_AGENT_JOIN in routes/breaches.ts). A sale touched by
 * three people has one accountable adviser, and it needs to be the same one
 * everywhere.
 *
 * For a call, the adviser on the call. There is one call and so no tie to break,
 * and inventing a rule for one would be how the call page and the feedback came
 * to name different people.
 */
export async function resolveAdviser(subject: FeedbackSubject): Promise<AdviserTarget> {
  type Row = {
    agent_id: string | null;
    agent_name: string | null;
    user_email: string | null;
    user_name: string | null;
  };
  const row =
    subject.kind === 'call'
      ? await queryOne<Row>(
          `SELECT c.agent_id, c.agent_name, u.email AS user_email, u.name AS user_name
             FROM calls c
             LEFT JOIN users u ON u.id = c.agent_id
            WHERE c.id = $1`,
          [subject.id]
        )
      : await queryOne<Row>(
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
          [subject.id]
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

/**
 * SQL: did this feedback round reach the adviser the sale (or call) is credited to now?
 *
 * The credited adviser is resolveAdviser's, read live: the wrap-up call's adviser
 * (services/wrap-up.ts decides which call that is). A round counts when
 *   - a supervisor chose its recipient (recipient_source = 'manual'). That pick
 *     is the firm saying who sold (migration 111); refusing it would leave a
 *     deliberately corrected sale reading "not fed back" with no way to clear it;
 *   - the sale has no attributable adviser, so there is nobody to disagree with;
 *   - it went to that adviser: by user id where both sides have one, otherwise by
 *     name, because advisers often have no account at all (061).
 *
 * WHY: the wrap-up can move after feedback is sent — a re-score, or
 * scripts/rederive-wrap-up.ts — and a round confirmed by whoever it went to then
 * reads as the sale being fed back while the adviser now credited was never told:
 * the "looks complete, proves nothing" record migration 111 exists to prevent.
 * Such a round stays on the record and in the panel; it just does not settle the
 * sale. The remediation backlog does not use this — an ask is owed by whoever
 * was asked (routes/remediations.ts).
 *
 * @param f alias of the journey_feedback row in the enclosing query.
 */
export function feedbackReachedCloserSql(f: string): string {
  // A call round is judged against the call's own adviser — the only adviser a
  // single call has, and the one resolveAdviser defaults to. The same subquery
  // serves both: for a sale it picks the wrap-up from the sale's calls; for a
  // call (journey_id NULL, so the join matches nothing) it is the call itself.
  return `(${f}.recipient_source = 'manual' OR EXISTS (
          SELECT 1 FROM (
            SELECT rc_c.agent_id, COALESCE(rc_u.name, rc_c.agent_name) AS name
              FROM calls rc_c
              LEFT JOIN journey_calls rc_jc
                     ON rc_jc.call_id = rc_c.id AND rc_jc.journey_id = ${f}.journey_id
              LEFT JOIN users rc_u ON rc_u.id = rc_c.agent_id
             WHERE (${f}.journey_id IS NOT NULL AND rc_jc.journey_id IS NOT NULL)
                OR (${f}.journey_id IS NULL AND rc_c.id = ${f}.call_id)
             ORDER BY (rc_jc.role = 'wrap_up') DESC,
                      CASE WHEN rc_jc.role = 'wrap_up'
                           THEN COALESCE(rc_c.call_date, rc_c.created_at) END ASC,
                      COALESCE(rc_c.call_date, rc_c.created_at) DESC
             LIMIT 1
          ) closer
          WHERE (closer.agent_id IS NULL AND closer.name IS NULL)
             OR CASE WHEN closer.agent_id IS NOT NULL AND ${f}.adviser_user_id IS NOT NULL
                     THEN ${f}.adviser_user_id = closer.agent_id
                     ELSE lower(btrim(${f}.adviser_name)) = lower(btrim(closer.name))
                END))`;
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
  // What the firm wants done about it, in the firm's own words (CG-24).
  //
  // Read live from the criterion rather than from the score, because unlike
  // `reasoning` it is not a property of this sale — it is the firm's standing
  // instruction for this checkpoint, and the current wording is the one to act
  // on. It is frozen only at send time, onto journey_feedback_items.
  //
  // Null on most checkpoints: guidance is opt-in per criterion, so a firm turns
  // this on one checkpoint at a time.
  remediation_guidance: string | null;
}

/**
 * The breaches that would be fed back for this subject.
 *
 * Excludes 'resolved' and 'noted': a breach a supervisor has already dismissed
 * is not something to tell the adviser off about. Everything else stands,
 * including ones already marked coached, because this is the record that the
 * conversation happened rather than a queue to work through.
 *
 * The two kinds differ only in where the breach hangs and where its reason
 * lives (042 put journey breaches on journey_item_scores and left call breaches
 * on call_item_scores). The exclusions and the order are one rule, written once.
 */
export async function breachesForFeedback(
  organizationId: string,
  subject: FeedbackSubject
): Promise<FeedbackBreach[]> {
  const source =
    subject.kind === 'call'
      ? `-- LEFT: one missing reason must not drop the whole finding.
       LEFT JOIN call_item_scores src ON src.id = b.call_item_score_id
      WHERE b.organization_id = $1
        AND b.call_id = $2`
      : `-- LEFT: a breach raised against a per-call score has no journey item
       -- score, and one missing reason must not drop the whole finding.
       LEFT JOIN journey_item_scores src ON src.id = b.journey_item_score_id
      WHERE b.organization_id = $1
        AND b.journey_id = $2`;
  return query<FeedbackBreach>(
    `SELECT b.id AS breach_id, b.scorecard_item_id, si.label AS item_label,
            b.severity, b.status, src.reasoning, si.remediation_guidance
       FROM breaches b
       JOIN scorecard_items si ON si.id = b.scorecard_item_id
       ${source}
        AND b.status NOT IN ('resolved', 'noted')
      ORDER BY CASE b.severity
                 WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                 WHEN 'medium' THEN 2 ELSE 3 END,
               si.label`,
    [organizationId, subject.id]
  );
}

/**
 * Checkpoints on this subject still waiting for a human ruling.
 *
 * Reported to the supervisor, never used to block: they may have good reason to
 * feed back now. But telling an adviser about a breach that is overturned an
 * hour later costs more trust than it saves time, so the gap is made visible.
 *
 * For a call, counted the way the review queue counts it (routes/review.ts), so
 * the number here is the number of items a reviewer will find waiting.
 */
export async function openReviewCount(subject: FeedbackSubject): Promise<number> {
  const row =
    subject.kind === 'call'
      ? await queryOne<{ n: string }>(
          `SELECT count(*) AS n
             FROM call_item_scores cis
             JOIN call_scores cs ON cs.id = cis.call_score_id
            WHERE cs.call_id = $1 AND cis.result = 'manual_review'`,
          [subject.id]
        )
      : await queryOne<{ n: string }>(
          `SELECT count(*) AS n FROM journey_item_scores
            WHERE journey_id = $1 AND result = 'manual_review'`,
          [subject.id]
        );
  return Number(row?.n ?? 0);
}

export interface FeedbackRow {
  id: string;
  /** Exactly one of these two is set (migration 118). */
  journey_id: string | null;
  call_id: string | null;
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
  /** False when this round went to someone the sale is no longer credited to. */
  reached_adviser: boolean;
}

export async function latestFeedback(
  organizationId: string,
  subject: FeedbackSubject
): Promise<FeedbackRow | null> {
  return queryOne<FeedbackRow>(
    `SELECT id, journey_id, call_id, adviser_user_id, adviser_name, adviser_email,
            sent_by, sent_at, message, confirmed_at, token_expires_at,
            recipient_source, suggested_adviser_user_id,
            ${feedbackReachedCloserSql('f')} AS reached_adviser
       FROM journey_feedback f
      WHERE organization_id = $1 AND ${subjectColumn(subject)} = $2
      ORDER BY sent_at DESC LIMIT 1`,
    [organizationId, subject.id]
  );
}

export interface SubjectSummary {
  /** Who the conversation was with, as the email names them. Null where unknown. */
  clientName: string | null;
  /** Null where there is no score to state — never 0. */
  score: number | null;
  pass: boolean | null;
}

/**
 * The client, score and verdict the email states for this subject.
 *
 * One reader for both the supervisor's panel and the send, so the name the
 * supervisor is shown before they click is the name that leaves the platform.
 *
 * SALE: customers.name is the fallback because journeys.client_name is null on
 * every sale pushed before the CRM backfill. score-journey and score-writeback
 * both already resolve the name this way; a third reader with its own rule is
 * how a sale ends up named in the CRM and unnamed in the email.
 *
 * CALL: the linked customer's name, or null. Never the phone number, though a
 * call often has no named customer: a sale email only ever names a client, and
 * a customer's number is contact data that has no business leaving the platform
 * in an email beside compliance findings — the same reason the name is kept out
 * of the subject line. An unnamed call is identified as a reviewed call with its
 * score. The score is the call's most recent, chosen the way the calls list
 * chooses it.
 */
export async function subjectSummary(
  organizationId: string,
  subject: FeedbackSubject
): Promise<SubjectSummary> {
  let clientName: string | null;
  let rawScore: string | null | undefined;
  let pass: boolean | null | undefined;

  if (subject.kind === 'call') {
    const call = await queryOne<{
      customer_name: string | null;
      overall_score: string | null;
      pass: boolean | null;
    }>(
      `SELECT cust.name AS customer_name, cs.overall_score, cs.pass
         FROM calls c
         LEFT JOIN customers cust ON cust.id = c.customer_id
         LEFT JOIN LATERAL (
           SELECT overall_score, pass FROM call_scores
            WHERE call_id = c.id
            ORDER BY scored_at DESC NULLS LAST
            LIMIT 1
         ) cs ON TRUE
        WHERE c.id = $1 AND c.organization_id = $2`,
      [subject.id, organizationId]
    );
    clientName = call?.customer_name?.trim() || null;
    rawScore = call?.overall_score;
    pass = call?.pass;
  } else {
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
      [subject.id, organizationId]
    );
    // Trimmed: a whitespace-only CRM field is truthy enough to suppress the
    // "Reviewed sale" fallback while rendering as an empty name.
    clientName = sale?.client_name?.trim() || sale?.customer_name?.trim() || null;
    rawScore = sale?.overall_score;
    pass = sale?.pass;
  }

  return {
    clientName,
    // NUMERIC(5,2) arrives from pg as a string. Coerced once, here, so the
    // template's NaN guard is checking the type it believes it is checking.
    score: rawScore == null ? null : Number(rawScore),
    pass: pass ?? null,
  };
}


/**
 * Where the recipient came from. Widened, not replaced, if a CRM owner lands.
 *
 * 'default_closing_adviser' is what every default send records since migration
 * 117: resolveAdviser picks the wrap-up call's adviser, and the wrap-up is no
 * longer simply the last call. A call round's default is the call's own adviser,
 * who closed that call, so it records the same value. 'default_last_caller' remains only on rows sent
 * before that, where it is what they were.
 */
export type RecipientSource = 'default_closing_adviser' | 'default_last_caller' | 'manual';

export interface SendResult {
  feedbackId: string;
  itemCount: number;
  adviser: AdviserTarget;
  recipientSource: RecipientSource;
  /** Who resolveAdviser would have picked — null when the subject is unattributed. */
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
      /** The firm's instruction as sent. Null where the checkpoint had none. */
      remediationGuidance: string | null;
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
  // Can this recipient actually READ the withheld detail in CallGuard?
  //
  // Only consulted when reasoning is withheld, and then it decides which true
  // sentence the email carries. It is not "can they sign in": it is whether a
  // surface they may open carries every withheld reason. An adviser-role user
  // can hold a working password and still not reach them — on a sale always,
  // and on a call anyone but their own (see sendFeedback, where this is
  // decided). Advisers commonly have no login at all (061), and Trust Point's
  // have none.
  //
  // The tokenised confirm link is not the answer either, though the reason
  // narrowed with CG-25. That page now DOES name the findings and carry the
  // firm's guidance — but it deliberately does not carry the model's reasoning,
  // on this same withholding test, because it is reachable without a login and
  // so is no safer a destination than the email (DPIA 4.11, open action 13).
  // Reasoning is the detail this sentence is about, so for these recipients the
  // honest pointer remains their supervisor, who has just been through it with
  // them. If action 13 lands the other way, this is one of the two places to
  // revisit; the other is `remediationItems`.
  recipientCanSeeDetail: boolean;
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
    recipientCanSeeDetail,
  } = input;

  // "Withheld" is an assertion about something that existed. A sale whose
  // findings carry no reasoning at all has had nothing withheld from it, and
  // saying otherwise would make the record claim a suppression that never
  // happened.
  const reasoningWithheld = !includeReasoning && breaches.some((b) => !!b.reasoning);

  // Guidance travels even where reasoning does not, and that is deliberate.
  //
  // `includeReasoning` is false on a tenant that keeps health unredacted,
  // because the MODEL's sentence is derived from the call and can quote a health
  // disclosure in the clear (DPIA R5). Guidance is not derived from the call at
  // all: the firm wrote it in advance, against the criterion, without seeing any
  // customer. It cannot contain a disclosure it was never exposed to, so the
  // rule that withholds reasoning has nothing to say about it.
  //
  // This matters most for exactly the tenants that trigger the withholding.
  // Trust Point's advisers receive no reasons; guidance is then the only
  // actionable content in the email, and withholding it too would leave them a
  // list of labels and nothing to do about them.
  const items = breaches.map((b) => {
    const sent = includeReasoning ? b.reasoning : null;
    const guidance = b.remediation_guidance?.trim() || null;
    return {
      label: b.item_label,
      severity: b.severity,
      ...(sent ? { reasoning: sent } : {}),
      ...(guidance ? { remediationGuidance: guidance } : {}),
    };
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
    // `recipientCanSeeDetail` rides with it because it changes where the
    // template sends the reader, and only matters when something was withheld.
    ...(reasoningWithheld ? { reasoningWithheld: true, recipientCanSeeDetail } : {}),
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
        // Frozen from what travelled, not re-read from the criterion: guidance
        // is editable, and a live join would make every past acknowledgement
        // assert the adviser was told today's wording.
        remediationGuidance: items[i].remediationGuidance ?? null,
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
 * email went out. See migrations 087 and 110. A call is re-scored the same way,
 * so the same holds for it.
 *
 * Whether this subject MAY be fed back — a call inside a sale may not, and a
 * call may not where the firm's scoring setting is sales_only — is the route's decision,
 * made before this is called. This function sends what it is given.
 */
export async function sendFeedback(input: {
  organizationId: string;
  subject: FeedbackSubject;
  sentBy: string;
  message: string | null;
  /** A recipient the supervisor picked. Omitted means take the subject's own adviser. */
  adviserUserId?: string | null;
}): Promise<SendResult> {
  const { organizationId, subject, sentBy, message, adviserUserId } = input;
  const noun = subjectNoun(subject.kind);

  // Resolved on every send, chosen recipient or not: it is what
  // suggested_adviser_user_id records, and an override is only evidence of
  // anything if what was overridden is stored beside it.
  const suggested = await resolveAdviser(subject);
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
      : 'default_closing_adviser';

  if (!adviser.email) {
    throw new Error(
      adviser.problem === 'no_adviser'
        ? `This ${noun} has no adviser attributed to it. Choose who to send the feedback to.`
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

  const breaches = await breachesForFeedback(organizationId, subject);

  // EVERY read the email needs happens HERE, before the transaction, and never
  // after it. A read that fails after the commit leaves journey_feedback and a
  // breach_events 'feedback_sent' row per breach asserting the adviser was told
  // about findings nobody sent — the exact state the two guards above exist to
  // prevent. Keeping these reads out of the transaction (which must stay short)
  // never required running them after it.
  const { clientName, score, pass } = await subjectSummary(organizationId, subject);

  const [keepsHealthUnredacted, scoreOnly] = await Promise.all([
    organisationKeepsHealthUnredacted(organizationId),
    orgHasFeature(organizationId, 'score_only'),
  ]);

  // Whether this recipient could actually READ the withheld detail in CallGuard
  // if the email told them to. Two conditions, and both are load-bearing.
  //
  // They must be able to sign in. An email address is not a login: a row can
  // carry one and still have no password set, or have had login revoked (061).
  //
  // And they must be able to reach EVERY reason the email withheld, on a surface
  // their role is allowed to open. That differs by subject, because the
  // adviser-scoped surfaces in routes/calls.ts do carry reasoning:
  //
  //  * ORG_WIDE_ROLES (admin, supervisor, viewer) can read it on either subject:
  //    GET /journeys/:id, the breaches router and GET /calls/:id/scores.
  //
  //  * An adviser-role user, on a CALL they took: GET /calls/:id/scores is
  //    scoped to calls.agent_id and returns call_item_scores.* — reasoning
  //    included, with no transcript-access gate. Every finding on this round is
  //    a breach on that call, so every withheld reason is there for them. Only
  //    their own call, though: sent a call someone else took, they get a 404.
  //
  //  * An adviser-role user, on a SALE: GET /calls/:id shows the reasoning only
  //    for checkpoints whose evidence came from a call they took. A sale's
  //    findings usually span calls, so "sign in to read it" would be true of
  //    some reasons and not others — which is not a sentence the email can say.
  //    They get the supervisor pointer, which is true of all of them.
  const recipientCanSeeDetail = adviser.userId
    ? !!(await queryOne<{ id: string }>(
        subject.kind === 'call'
          ? `SELECT u.id FROM users u
              WHERE u.id = $1 AND u.organization_id = $2
                AND u.login_disabled = false AND u.password_hash IS NOT NULL
                AND (u.role = ANY($3::text[])
                     OR (u.role = 'adviser'
                         AND EXISTS (SELECT 1 FROM calls c
                                      WHERE c.id = $4 AND c.organization_id = $2
                                        AND c.agent_id = u.id)))`
          : `SELECT id FROM users
              WHERE id = $1 AND organization_id = $2
                AND login_disabled = false AND password_hash IS NOT NULL
                AND role = ANY($3::text[])`,
        subject.kind === 'call'
          ? [adviser.userId, organizationId, ORG_WIDE_ROLES, subject.id]
          : [adviser.userId, organizationId, ORG_WIDE_ROLES]
      ))
    : false;

  const raw = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const built = buildFeedbackSend({
    adviserEmail: adviser.email,
    adviserName: adviser.name,
    confirmUrl: `${config.appUrl}/feedback/${raw}`,
    message,
    clientName,
    score,
    pass,
    breaches,
    includeReasoning: !keepsHealthUnredacted,
    includeVerdict: !scoreOnly,
    recipientCanSeeDetail,
  });
  const { snapshot } = built;
  // The kind is stamped on here rather than passed through buildFeedbackSend,
  // which decides what may leave the platform and has no business knowing what
  // the email calls it. The subject line differs by kind and is otherwise
  // constant (see renderFeedbackEmail), so this carries no client detail.
  const payload: FeedbackEmailJob = { ...built.payload, subjectKind: subject.kind };

  // The delete-and-replace and every insert it depends on run as one
  // transaction: if the INSERT (or a breach_events insert) fails partway
  // through, the adviser's previous working link must still be there rather
  // than deleted with nothing to replace it.
  const feedbackId = await withTransaction(async (tx) => {
    // A previous unconfirmed feedback is superseded rather than blocking: the
    // partial unique indexes allow one open per sale and one open per call
    // (087, 118), and re-sending is a normal thing to do when the first was
    // never acknowledged. Scoped by organisation like every other write here —
    // the subject id alone is not tenant-safe.
    //
    // Keyed on the subject's own column. A NULL never equals anything, so a
    // sale-keyed DELETE could not reach a call row even by accident — but it
    // would also leave the call's old link live beside the new one, and the
    // INSERT below would then trip idx_journey_feedback_open_call.
    const column = subjectColumn(subject);
    await tx.query(
      `DELETE FROM journey_feedback
        WHERE ${column} = $1 AND organization_id = $2 AND confirmed_at IS NULL`,
      [subject.id, organizationId]
    );

    const feedback = await tx.queryOne<{ id: string }>(
      `INSERT INTO journey_feedback
        (organization_id, ${column}, adviser_user_id, adviser_name, adviser_email,
         sent_by, message, token_hash, token_expires_at,
          recipient_source, suggested_adviser_user_id,
          client_name, score, pass, reasoning_withheld)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
       organizationId,
       subject.id,
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
           (feedback_id, scorecard_item_id, item_label, severity, breach_id, reasoning,
            remediation_guidance)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (feedback_id, scorecard_item_id) DO NOTHING`,
        [
          id,
          item.scorecardItemId,
          item.itemLabel,
          item.severity,
          item.breachId,
          item.reasoning,
          item.remediationGuidance,
        ]
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
    // 'Unknown adviser' for an unattributed subject, and naming that in an audit
    // line would read as a real person who was passed over.
    suggestedAdviserName: suggested.userId ? suggested.name : null,
  };
}

export interface ConfirmResult {
  status: 'confirmed' | 'already_confirmed' | 'expired' | 'not_found';
  adviserName?: string;
  itemCount?: number;
}

/**
 * One finding as the ADVISER sees it on the tokenised page.
 *
 * Everything here either was already in their email or is firm-authored text
 * about their own conduct. Deliberately absent, and it must stay absent: the
 * customer, the client name, the sale, the breach id, the transcript, and the
 * quoted evidence. The page is unauthenticated, so this shape is the whole of
 * the disclosure — see the note on `remediationItems`.
 */
export interface RemediationItemView {
  /** The row's own id, so the page can post an outcome against it. Opaque and
   *  useless on its own: every write is still gated on the token. */
  id: string;
  label: string;
  severity: string;
  /** The model's sentence, ONLY where it travelled in the email. Null here does
   *  not mean there was none — read `reasoningWithheld` on the result. */
  reasoning: string | null;
  /** The firm's instruction, as it was sent. Null where the checkpoint had none. */
  remediationGuidance: string | null;
  outcome: RemediationOutcome | null;
  note: string | null;
  recordedAt: string | null;
}

export interface LookupResult {
  status: 'pending' | 'already_confirmed' | 'expired' | 'not_found';
  adviserName?: string;
  itemCount?: number;
  /** The findings themselves. Present on 'pending' and 'already_confirmed';
   *  omitted for a dead link, which must learn nothing. */
  items?: RemediationItemView[];
  /** The findings had reasons and policy kept them out of the email (DPIA R5).
   *  The page says so rather than showing a list with silent gaps in it. */
  reasoningWithheld?: boolean;
  /** Whether outcomes can be written yet. False before acknowledgement — see
   *  `recordRemediationOutcome` for why that ordering is load-bearing. */
  canRecordOutcome?: boolean;
  /** Whether this was feedback on a sale or on a call, so the page can use the
   *  right word. Names the KIND only — never which sale or call, which the
   *  page must not learn. Absent on a dead link, like everything else here.
   *  snake_case because the route returns this object as its response body,
   *  and this is the name that response has always been specified with. */
  subject_kind?: FeedbackSubject['kind'];
}

/**
 * The findings on one feedback, with whatever outcome has been recorded.
 *
 * `reasoning` is returned only when it actually travelled in the email, which
 * is the same test migration 110 records on the parent row. On a tenant that
 * keeps health unredacted the model's sentence may quote a health disclosure in
 * the clear, and this page is unauthenticated — so the sentence that is not
 * safe to email is not safe to put here either. The email's own pointer (ask
 * your supervisor) remains the honest one for those tenants until the DPIA
 * signs the wider disclosure off; §4.3 of the scope argues it should, and when
 * it does this is the single condition to relax.
 */
async function remediationItems(
  feedbackId: string,
  reasoningWithheld: boolean
): Promise<RemediationItemView[]> {
  const rows = await query<{
    id: string;
    item_label: string;
    severity: string;
    reasoning: string | null;
    remediation_guidance: string | null;
    remediation_outcome: RemediationOutcome | null;
    remediation_note: string | null;
    remediated_at: string | null;
  }>(
    `SELECT id, item_label, severity, reasoning, remediation_guidance,
            remediation_outcome, remediation_note, remediated_at
       FROM journey_feedback_items
      WHERE feedback_id = $1
      ORDER BY CASE severity
                 WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                 WHEN 'medium' THEN 2 ELSE 3 END,
               item_label`,
    [feedbackId]
  );

  return rows.map((r) => ({
    id: r.id,
    label: r.item_label,
    severity: r.severity,
    reasoning: reasoningWithheld ? null : r.reasoning,
    remediationGuidance: r.remediation_guidance,
    outcome: r.remediation_outcome,
    note: r.remediation_note,
    recordedAt: r.remediated_at,
  }));
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
    reasoning_withheld: boolean;
    call_id: string | null;
  }>(
    `SELECT id, adviser_name, confirmed_at, token_expires_at, reasoning_withheld, call_id
       FROM journey_feedback WHERE token_hash = $1`,
    [hashFeedbackToken(rawToken)]
  );

  if (!row) return { status: 'not_found' };

  // An expired link is answered before the findings are read, and returns none
  // of them. The link is the credential and it has stopped being one; a dead
  // token that still discloses the findings would make the expiry cosmetic.
  if (!row.confirmed_at && new Date(row.token_expires_at).getTime() < Date.now()) {
    return { status: 'expired', adviserName: row.adviser_name };
  }

  const items = await remediationItems(row.id, row.reasoning_withheld);

  // The findings are shown BEFORE confirmation as well as after, and that is
  // the point of showing them at all: "confirm you have seen this feedback" is
  // not a thing a person can honestly click on a page that will not tell them
  // what the feedback was. Writing an outcome is what waits for the click.
  //
  // Writing also stops at expiry, even on a confirmed feedback: the link has
  // ceased to be a credential, and an outcome is a new assertion rather than a
  // re-read of an old one. The adviser can still read what they were told.
  const expired = new Date(row.token_expires_at).getTime() < Date.now();

  return {
    status: row.confirmed_at ? 'already_confirmed' : 'pending',
    adviserName: row.adviser_name,
    itemCount: items.length,
    items,
    reasoningWithheld: row.reasoning_withheld,
    canRecordOutcome: !!row.confirmed_at && !expired,
    // Read off which column is set, not selected as an id: the id itself never
    // leaves this function.
    subject_kind: row.call_id ? 'call' : 'journey',
  };
}

export interface RecordOutcomeResult {
  status: 'recorded' | 'not_confirmed' | 'expired' | 'not_found' | 'invalid_outcome';
  item?: RemediationItemView;
}

/**
 * The adviser's answer to "what did you do about this one?".
 *
 * Unauthenticated, like the confirmation beside it, and for the same reason:
 * the people this exists for have no account to sign into. The token is the
 * credential, and it authorises exactly the findings hanging off its own
 * feedback row — `feedback_id` is part of the UPDATE's WHERE clause, so a valid
 * token cannot be pointed at another adviser's item by editing the id in the
 * request.
 *
 * THREE GATES, EACH FOR A DIFFERENT FAILURE
 *
 * `confirmed_at IS NOT NULL` — sendFeedback DELETEs a previous *unconfirmed*
 * feedback when a supervisor re-sends, cascading to its items. An outcome
 * written before acknowledgement could therefore be destroyed by a re-send with
 * nothing said to anyone. A confirmed row is outside that DELETE's reach, so
 * requiring confirmation first removes the failure mode rather than mitigating
 * it. It is also the right order of events: see it, acknowledge it, then act.
 *
 * `token_expires_at` — the credential has a life, and a write is where that has
 * to bite. Reading what you were already told is not the same act.
 *
 * The outcome must be one of the three. Rejected rather than coerced: a
 * malformed value is a client bug, and quietly storing the nearest valid answer
 * would put words in an adviser's mouth about a customer.
 *
 * Re-answerable on purpose. An adviser who records 'customer_unreachable' on
 * Monday and reaches the customer on Thursday must be able to say so, and the
 * revision is not a loss of information: every write appends its own
 * breach_events row, so the trail keeps both answers and their order.
 */
export async function recordRemediationOutcome(
  rawToken: string,
  itemId: string,
  outcome: string,
  note: string | null
): Promise<RecordOutcomeResult> {
  if (!REMEDIATION_OUTCOMES.includes(outcome as RemediationOutcome)) {
    return { status: 'invalid_outcome' };
  }

  const row = await queryOne<{
    id: string;
    organization_id: string;
    adviser_name: string;
    adviser_user_id: string | null;
    confirmed_at: string | null;
    token_expires_at: string;
    reasoning_withheld: boolean;
  }>(
    `SELECT id, organization_id, adviser_name, adviser_user_id,
            confirmed_at, token_expires_at, reasoning_withheld
       FROM journey_feedback WHERE token_hash = $1`,
    [hashFeedbackToken(rawToken)]
  );

  if (!row) return { status: 'not_found' };
  if (new Date(row.token_expires_at).getTime() < Date.now()) return { status: 'expired' };
  if (!row.confirmed_at) return { status: 'not_confirmed' };

  // Trimmed to null rather than kept as an empty string, so "no note" is one
  // fact with one representation. Truncated rather than rejected: an adviser
  // who has typed past the limit should not lose the account they just wrote.
  // The page sets the same value as its textarea's maxLength, so this is
  // unreachable from the UI and exists for a direct POST.
  const trimmed = note?.trim() ? note.trim().slice(0, REMEDIATION_NOTE_MAX) : null;

  const updated = await withTransaction(async (tx) => {
    // feedback_id in the WHERE is the authorisation, not a filter: without it
    // any valid token could write an outcome onto any item id it was handed.
    const item = await tx.queryOne<{ id: string; breach_id: string | null; item_label: string }>(
      `UPDATE journey_feedback_items
          SET remediation_outcome = $3,
              remediation_note    = $4,
              remediated_at       = now(),
              remediated_by       = $5
        WHERE id = $1 AND feedback_id = $2
        RETURNING id, breach_id, item_label`,
      [itemId, row.id, outcome, trimmed, row.adviser_user_id]
    );
    if (!item) return null;

    // Appended, never updated. "Said done, then said unreachable" is a fact a
    // claims file needs, and it is the reason this history is a table of events
    // rather than a column.
    //
    // Skipped where breach_id is null — a re-score can null it (ON DELETE SET
    // NULL, 087) — because there is no longer a breach to hang the event on.
    // The outcome itself is already safe on the snapshot row above, which is
    // exactly what that snapshot exists for.
    if (item.breach_id) {
      await tx.query(
        `INSERT INTO breach_events (breach_id, user_id, event_type, to_value)
         VALUES ($1, $2, 'remediation_recorded', $3)`,
        [item.breach_id, row.adviser_user_id, outcome]
      );
    }
    return item;
  });

  if (!updated) return { status: 'not_found' };

  const items = await remediationItems(row.id, row.reasoning_withheld);
  return {
    status: 'recorded',
    item: items.find((i) => i.id === updated.id),
  };
}

/**
 * The context an audit line needs about a confirmation or an outcome, read back
 * by the route.
 *
 * Separate from the writes so that `confirmFeedback` and
 * `recordRemediationOutcome` return only what the adviser's page is allowed to
 * see: the subject and the organisation are needed to file the audit event
 * against the right sale or call, and must not travel to an unauthenticated
 * client.
 */
export async function feedbackAuditContext(rawToken: string): Promise<{
  organizationId: string;
  subject: FeedbackSubject;
  adviserName: string;
  adviserUserId: string | null;
} | null> {
  const row = await queryOne<{
    organization_id: string;
    journey_id: string | null;
    call_id: string | null;
    adviser_name: string;
    adviser_user_id: string | null;
  }>(
    `SELECT organization_id, journey_id, call_id, adviser_name, adviser_user_id
       FROM journey_feedback WHERE token_hash = $1`,
    [hashFeedbackToken(rawToken)]
  );
  if (!row) return null;
  // Exactly one is set (118's CHECK). A row with neither cannot exist, so there
  // is no third branch to invent a subject for.
  const subject: FeedbackSubject = row.call_id
    ? { kind: 'call', id: row.call_id }
    : { kind: 'journey', id: row.journey_id! };
  return {
    organizationId: row.organization_id,
    subject,
    adviserName: row.adviser_name,
    adviserUserId: row.adviser_user_id,
  };
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
    adviser_name: string;
    adviser_user_id: string | null;
    confirmed_at: string | null;
    token_expires_at: string;
  }>(
    `SELECT id, organization_id, adviser_name, adviser_user_id,
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
