import { Router } from 'express';
import type {
  BreachSeverity,
  RemediationBacklogAdviser,
  RemediationBacklogItem,
  RemediationBacklogResponse,
} from '@callguard/shared';
import { query } from '../db/client.js';
import { authenticate, requireOrgView } from '../middleware/auth.js';

export const remediationsRouter = Router();
remediationsRouter.use(authenticate);

// What has been asked of advisers and not closed (CG-27, Phase 4 of the CG-6
// scope — docs/remediation-guidance-scope.md §4.5).
//
// The evidence chain now runs: found → ruled on → fed back → acknowledged →
// answered → in the pack. This is the sixth step read from the other end. It is
// what turns remediation from a thing that happens into a thing that can be
// managed, which is the difference between management information a firm holds
// and management information a firm can show drove a decision.

/**
 * The one rule for "the ask that is currently outstanding on a checkpoint",
 * shared by every place that counts one.
 *
 * ONE ASK PER CHECKPOINT PER SALE, read off the most recent round the adviser
 * acknowledged. Counting rows instead is wrong in both directions on a sale that
 * was fed back, re-scored and fed back again: the same unanswered ask sent twice
 * is one thing outstanding, not two, and a checkpoint answered in July and asked
 * about again in August is outstanding again rather than closed by the older
 * answer. This is the rule CG-26's board pack figure uses, and it is factored
 * out here rather than copied so the sales list, the board pack and this backlog
 * cannot drift into three different definitions of the same word.
 *
 * ONLY ACKNOWLEDGED ROUNDS. An unacknowledged one is a feedback backlog — a
 * different problem, with a different owner, already reported by CG-11 — and an
 * outcome cannot be written before acknowledgement anyway (migration 116).
 *
 * @param where scoping predicate over `f` (the feedback) — one sale, or one org.
 * @param columns what the caller needs off the winning row.
 */
export function latestConfirmedAskSql(
  where: string,
  columns = 'fi.remediation_outcome, fi.remediation_guidance'
): string {
  return `SELECT DISTINCT ON (f.journey_id, fi.scorecard_item_id) ${columns}
            FROM journey_feedback_items fi
            JOIN journey_feedback f ON f.id = fi.feedback_id
           WHERE ${where}
             AND f.confirmed_at IS NOT NULL
           -- id as a final tiebreak so two rounds sent in the same instant
           -- resolve to the same winner on every read rather than to whichever
           -- the planner happened to reach first.
           ORDER BY f.journey_id, fi.scorecard_item_id, f.sent_at DESC, f.id DESC`;
}

/**
 * Which of those asks is still open.
 *
 * The guidance condition is load-bearing and is argued in full on
 * `RemediationBacklogItem` in @callguard/shared: a checkpoint the firm wrote no
 * guidance for has no remediation step (migration 115), so it cannot have an
 * outstanding one. Without it this backlog would open with every finding fed
 * back before CG-24 existed, none of which anybody could ever close.
 */
export const OPEN_ASK_PREDICATE = `latest_ask.remediation_outcome IS NULL
                                     AND latest_ask.remediation_guidance IS NOT NULL`;

/** "Does this sale have an outstanding ask?", for a query with a journey in scope. */
export function openRemediationExistsSql(journeyAlias = 'j'): string {
  return `EXISTS (
        SELECT 1 FROM (${latestConfirmedAskSql(`f.journey_id = ${journeyAlias}.id`)}) latest_ask
         WHERE ${OPEN_ASK_PREDICATE})`;
}

// Whole days since a timestamp, floored, as SQL. Floored for the reason the
// sales list floors it: an ask acknowledged this morning reads as 0 rather than
// rounding up to a day it has not been outstanding.
const DAYS_OPEN_SQL = `FLOOR(EXTRACT(EPOCH FROM (now() - latest_ask.confirmed_at)) / 86400)::int`;

// A bound on one response, not a page size. The backlog is meant to be worked
// down; a firm with more outstanding asks than this has a management problem
// that a second page would not help with, and the response says plainly that it
// was cut rather than letting a partial total read as the total.
const MAX_ROWS = 500;

const NOTE =
  'An open remediation is a finding where the firm set a step for the checkpoint ' +
  'and the adviser, having acknowledged the feedback, has not yet said what they ' +
  'did about it. Counted once per checkpoint per sale, from the most recent round ' +
  'the adviser acknowledged. Checkpoints the firm has written no guidance for have ' +
  'no remediation step and are not counted here. Ages run from acknowledgement, ' +
  'not from when the feedback was sent — the wait before acknowledgement is the ' +
  'feedback backlog on the sales screen, and counting it twice would overstate this one.';

// GET /api/remediations — the open backlog, grouped by the adviser who owes the
// answer.
//
// requireOrgView, not requireActioner: this is a report, and a viewer (a
// compliance officer, a principal) reads reports. Advisers are excluded from
// ORG_WIDE_ROLES and so cannot reach it, which is right — an adviser's own
// outstanding asks are already in front of them on their tokenised page, and
// nothing here is scoped to one adviser's view of themselves.
remediationsRouter.get('/', requireOrgView, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;

    // ATTRIBUTED TO WHOEVER WAS ACTUALLY TOLD, which is not the same as the
    // sale's closing adviser.
    //
    // §4.5 assumed this would reuse the JOURNEY_AGENT_JOIN attribution that
    // breaches, review and the Zoho write-back share. It should not, and
    // migration 111 is the reason: a supervisor can override the derived
    // recipient before sending, because the last person to call is occasionally
    // not the person who sold. The obligation to answer sits with the person who
    // was asked, and journey_feedback snapshots exactly that — adviser_name and
    // adviser_email are NOT NULL and frozen at send time, so re-attribution or a
    // corrected speaker mapping cannot later move somebody else's backlog onto
    // an adviser who was never told.
    //
    // Grouped on the user id where there is one and the lowercased email
    // otherwise: advisers frequently have no account at all (061) and Trust
    // Point's have none, so keying on adviser_user_id would collapse every one
    // of them into a single null-keyed pile.
    const rows = await query<{
      adviser_key: string;
      adviser_name: string;
      adviser_email: string;
      adviser_user_id: string | null;
      feedback_item_id: string;
      journey_id: string;
      customer_name: string | null;
      item_label: string;
      severity: BreachSeverity;
      remediation_guidance: string;
      told_at: string;
      acknowledged_at: string;
      days_open: number;
      link_expired: boolean;
    }>(
      `SELECT COALESCE(latest_ask.adviser_user_id::text, lower(latest_ask.adviser_email)) AS adviser_key,
              latest_ask.adviser_name,
              latest_ask.adviser_email,
              latest_ask.adviser_user_id::text AS adviser_user_id,
              latest_ask.feedback_item_id,
              latest_ask.journey_id::text AS journey_id,
              cust.name AS customer_name,
              latest_ask.item_label,
              latest_ask.severity,
              latest_ask.remediation_guidance,
              latest_ask.sent_at AS told_at,
              latest_ask.confirmed_at AS acknowledged_at,
              ${DAYS_OPEN_SQL} AS days_open,
              (latest_ask.token_expires_at < now()) AS link_expired
         FROM (${latestConfirmedAskSql(
           'f.organization_id = $1',
           `fi.id::text AS feedback_item_id, fi.item_label, fi.severity,
                  fi.remediation_guidance, fi.remediation_outcome,
                  f.journey_id, f.adviser_user_id, f.adviser_name, f.adviser_email,
                  f.sent_at, f.confirmed_at, f.token_expires_at`
         )}) latest_ask
         JOIN journeys j ON j.id = latest_ask.journey_id
         LEFT JOIN customers cust ON cust.id = j.customer_id
        WHERE ${OPEN_ASK_PREDICATE}
        -- Oldest first, and that ordering is the point of the screen: the ask
        -- nobody has closed for six weeks is the one a principal will be asked
        -- about, not the one raised yesterday.
        ORDER BY latest_ask.confirmed_at ASC
        LIMIT ${MAX_ROWS + 1}`,
      [orgId]
    );

    const truncated = rows.length > MAX_ROWS;
    const kept = truncated ? rows.slice(0, MAX_ROWS) : rows;

    // Grouped here rather than in SQL because the items travel with the group:
    // a supervisor opens an adviser and reads the asks, so the shape the screen
    // needs is the shape the response should be, and a second round trip per
    // adviser to fetch their rows would be the same data fetched twice.
    const byAdviser = new Map<string, RemediationBacklogAdviser>();
    for (const r of kept) {
      const item: RemediationBacklogItem = {
        feedback_item_id: r.feedback_item_id,
        journey_id: r.journey_id,
        customer_name: r.customer_name,
        item_label: r.item_label,
        severity: r.severity,
        remediation_guidance: r.remediation_guidance,
        told_at: r.told_at,
        acknowledged_at: r.acknowledged_at,
        days_open: r.days_open,
        link_expired: r.link_expired,
      };
      const existing = byAdviser.get(r.adviser_key);
      if (existing) {
        existing.items.push(item);
        existing.open_count += 1;
        // Rows arrive oldest first, so the first one seen for an adviser is
        // already their oldest — max() rather than assignment only so this
        // stops depending on that ordering.
        existing.oldest_open_days = Math.max(existing.oldest_open_days, r.days_open);
      } else {
        byAdviser.set(r.adviser_key, {
          adviser_key: r.adviser_key,
          // The name off their oldest open ask. Any of the snapshots would do;
          // this one is deterministic and is the round the age is measured from.
          adviser_name: r.adviser_name,
          adviser_email: r.adviser_email,
          adviser_user_id: r.adviser_user_id,
          open_count: 1,
          oldest_open_days: r.days_open,
          items: [item],
        });
      }
    }

    const advisers = [...byAdviser.values()].sort(
      (a, b) => b.oldest_open_days - a.oldest_open_days || b.open_count - a.open_count
    );

    const response: RemediationBacklogResponse = {
      advisers,
      total_open: kept.length,
      advisers_with_open: advisers.length,
      oldest_open_days: advisers.length ? Math.max(...advisers.map((a) => a.oldest_open_days)) : null,
      truncated,
      note: NOTE,
    };

    res.json(response);
  } catch (err) {
    next(err);
  }
});
