// Where a sale sits in the acknowledgement loop (CG-11), derived rather than
// stored so it can never disagree with the journey_feedback rows it describes.
//
// Shared by routes/journeys.ts (the sales list and sale detail) and
// routes/calls.ts (a call's summary of the sale it belongs to) — living here
// rather than in journeys.ts means calls.ts does not have to import a route
// module to get at it.
import { latestConfirmedAskSql, openRemediationExistsSql, OPEN_ASK_PREDICATE } from '../routes/remediations.js';
import { feedbackReachedCloserSql } from '../services/journey-feedback.js';

// The open row wins over history. journey_feedback has a UNIQUE index on
// journey_id WHERE confirmed_at IS NULL (087), so there is at most one
// unconfirmed row but there may be several confirmed ones from earlier rounds.
// A sale fed back, acknowledged, re-scored and fed back again is awaiting
// confirmation — reading it as acknowledged would hide exactly the item a
// supervisor is chasing.
//
// Fixed SQL with no user input, shared by the list, the counts and the filter
// so all three agree on what each state means.
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
// feedback that reached the adviser the sale is credited to
// (feedbackReachedCloserSql). A round sent to someone the sale no longer credits
// stays on the record — and in the remediation backlog, under whoever was asked
// — but it does not make the sale fed back, awaiting or acknowledged.
const REACHED_CLOSER_SQL = feedbackReachedCloserSql('f');
const CLOSER_FEEDBACK_WHERE = `f.journey_id = j.id AND ${REACHED_CLOSER_SQL}`;

export const FEEDBACK_STATUS_SQL = `CASE
        WHEN EXISTS (SELECT 1 FROM journey_feedback f
                      WHERE f.journey_id = j.id AND f.confirmed_at IS NULL
                        AND ${REACHED_CLOSER_SQL}) THEN 'awaiting'
        WHEN ${openRemediationExistsSql('j', REACHED_CLOSER_SQL)} THEN 'awaiting_remediation'
        WHEN EXISTS (SELECT 1 FROM journey_feedback f
                      WHERE ${CLOSER_FEEDBACK_WHERE}) THEN 'acknowledged'
        ELSE 'not_fed_back'
      END`;

// The sent_at that the status above is measured from: the open round while one
// is outstanding, otherwise the most recent confirmed one.
export const FEEDBACK_SENT_AT_SQL = `(
        SELECT f.sent_at FROM journey_feedback f
         WHERE ${CLOSER_FEEDBACK_WHERE}
         ORDER BY (f.confirmed_at IS NULL) DESC, f.sent_at DESC
         LIMIT 1)`;

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

export const OLDEST_REMEDIATION_DAYS_SQL = `(
        SELECT FLOOR(EXTRACT(EPOCH FROM (now() - MIN(latest_ask.confirmed_at))) / 86400)::int
          FROM (${latestConfirmedAskSql(CLOSER_FEEDBACK_WHERE, 'fi.remediation_outcome, fi.remediation_guidance, f.confirmed_at')}) latest_ask
         WHERE ${OPEN_ASK_PREDICATE})`;

export const FEEDBACK_CONFIRMED_AT_SQL = `(
        SELECT f.confirmed_at FROM journey_feedback f
         WHERE ${CLOSER_FEEDBACK_WHERE} AND f.confirmed_at IS NOT NULL
         ORDER BY f.confirmed_at DESC
         LIMIT 1)`;
