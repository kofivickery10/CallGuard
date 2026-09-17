// Where a sale sits in the acknowledgement loop (CG-11), derived rather than
// stored so it can never disagree with the journey_feedback rows it describes.
//
// Shared by routes/journeys.ts (the sales list and sale detail),
// routes/calls.ts (a call's summary of the sale it belongs to) and
// routes/customers.ts (a customer's sales, and the calls a firm scores on their
// own) — living here rather than in journeys.ts means the other routes do not
// have to import a route module to get at it.
//
// ONE RULE, TWO SUBJECTS. journey_feedback holds rounds about a sale
// (journey_id set) and rounds about a call scored on its own (call_id set,
// migration 118); exactly one of the two is ever set. Every statement below is
// built by a function that correlates on ONE of those columns — `f.journey_id =
// j.id` for a sale, `f.call_id = c.id` for a call — and a NULL can never satisfy
// either, so a call round cannot leak into a sale's status or the other way
// round. The exported constants are the sale forms, unchanged in meaning; the
// *Sql functions give the same rule for a call. The shared latestConfirmedAskSql
// is keyed on the subject rather than on journey_id for the backlog's sake;
// under these predicates that key is always the one subject being read.
import { latestConfirmedAskSql, OPEN_ASK_PREDICATE } from '../routes/remediations.js';
import { feedbackReachedCloserSql } from '../services/journey-feedback.js';

/** Which journey_feedback column names the subject. Fixed literals, never input. */
export type FeedbackSubjectColumn = 'journey_id' | 'call_id';

// The open row wins over history. journey_feedback has a UNIQUE index on
// journey_id WHERE confirmed_at IS NULL (087), and the same on call_id (118), so
// there is at most one unconfirmed row per subject but there may be several
// confirmed ones from earlier rounds. A subject fed back, acknowledged,
// re-scored and fed back again is awaiting confirmation — reading it as
// acknowledged would hide exactly the item a supervisor is chasing.
//
// The third branch (CG-27) splits what used to be one 'acknowledged' state in
// two, and the order matters: a sale with an unconfirmed round is still
// 'awaiting' even if an earlier round left an ask open, because the thing to
// chase is the acknowledgement and chasing an answer from someone who has not
// confirmed is chasing the wrong thing. 'acknowledged' now means acknowledged
// with nothing outstanding behind it, which is what a reader always took it to
// mean and what it did not previously say.
//
// Every branch, and every figure below read off the same rounds, counts only
// feedback that reached the adviser the subject is credited to
// (feedbackReachedCloserSql — a sale's closing adviser, or a call's own). A
// round sent to someone the sale no longer credits stays on the record — and in
// the remediation backlog, under whoever was asked — but it does not make the
// sale fed back, awaiting or acknowledged.
const REACHED_CLOSER_SQL = feedbackReachedCloserSql('f');

/**
 * @param column the subject's column on journey_feedback.
 * @param ref the subject's id in the caller's query, e.g. `j.id` or `c.id`. A
 *   fixed identifier from code, never input.
 */
function subjectFeedbackWhere(column: FeedbackSubjectColumn, ref: string): string {
  return `f.${column} = ${ref} AND ${REACHED_CLOSER_SQL}`;
}

/** Fixed SQL with no user input, shared by lists, counts and filters so they agree. */
export function feedbackStatusSql(column: FeedbackSubjectColumn, ref: string): string {
  const where = subjectFeedbackWhere(column, ref);
  return `CASE
        WHEN EXISTS (SELECT 1 FROM journey_feedback f
                      WHERE f.${column} = ${ref} AND f.confirmed_at IS NULL
                        AND ${REACHED_CLOSER_SQL}) THEN 'awaiting'
        WHEN EXISTS (
        SELECT 1 FROM (${latestConfirmedAskSql(where)}) latest_ask
         WHERE ${OPEN_ASK_PREDICATE}) THEN 'awaiting_remediation'
        WHEN EXISTS (SELECT 1 FROM journey_feedback f
                      WHERE ${where}) THEN 'acknowledged'
        ELSE 'not_fed_back'
      END`;
}

// The sent_at that the status above is measured from: the open round while one
// is outstanding, otherwise the most recent confirmed one.
export function feedbackSentAtSql(column: FeedbackSubjectColumn, ref: string): string {
  return `(
        SELECT f.sent_at FROM journey_feedback f
         WHERE ${subjectFeedbackWhere(column, ref)}
         ORDER BY (f.confirmed_at IS NULL) DESC, f.sent_at DESC
         LIMIT 1)`;
}

// How long the oldest outstanding ask on this subject has been open, measured
// from acknowledgement (CG-27) — see OPEN_REMEDIATIONS_SQL below for why.
export function oldestRemediationDaysSql(column: FeedbackSubjectColumn, ref: string): string {
  return `(
        SELECT FLOOR(EXTRACT(EPOCH FROM (now() - MIN(latest_ask.confirmed_at))) / 86400)::int
          FROM (${latestConfirmedAskSql(subjectFeedbackWhere(column, ref), 'fi.remediation_outcome, fi.remediation_guidance, f.confirmed_at')}) latest_ask
         WHERE ${OPEN_ASK_PREDICATE})`;
}

const CLOSER_FEEDBACK_WHERE = subjectFeedbackWhere('journey_id', 'j.id');

export const FEEDBACK_STATUS_SQL = feedbackStatusSql('journey_id', 'j.id');

export const FEEDBACK_SENT_AT_SQL = feedbackSentAtSql('journey_id', 'j.id');

// How much is outstanding on this sale, and how long the oldest of it has been
// (CG-27). Off the same rule as the status above, so a sale badged 'awaiting
// outcome' can never show a count of zero beside it.
//
// The age runs from acknowledgement rather than from FEEDBACK_CONFIRMED_AT_SQL
// below, and the two genuinely differ: a checkpoint asked about in July and
// dropped from August's re-scored round is outstanding from July, while the
// sale's most recent confirmation says August.
export const OPEN_REMEDIATIONS_SQL = `(
        SELECT COUNT(*)::int
          FROM (${latestConfirmedAskSql(CLOSER_FEEDBACK_WHERE)}) latest_ask
         WHERE ${OPEN_ASK_PREDICATE})`;

export const OLDEST_REMEDIATION_DAYS_SQL = oldestRemediationDaysSql('journey_id', 'j.id');

export const FEEDBACK_CONFIRMED_AT_SQL = `(
        SELECT f.confirmed_at FROM journey_feedback f
         WHERE ${CLOSER_FEEDBACK_WHERE} AND f.confirmed_at IS NOT NULL
         ORDER BY f.confirmed_at DESC
         LIMIT 1)`;
