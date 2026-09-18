import { Router } from 'express';
import { authenticate, requireOrgView, requireActioner, requireAdmin } from '../middleware/auth.js';
import { query, queryOne, withTransaction } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { assembleJourney } from '../services/journey.js';
import { recordAuditEvent } from '../services/audit.js';
import { feedbackReachedCloserSql } from '../services/journey-feedback.js';
import { getScoringSettings, orgHasFeature } from '../services/tenant-settings.js';
import {
  FEEDBACK_STATUS_SQL,
  FEEDBACK_SENT_AT_SQL,
  OPEN_REMEDIATIONS_SQL,
  OLDEST_REMEDIATION_DAYS_SQL,
  FEEDBACK_CONFIRMED_AT_SQL,
} from '../db/feedback-status.js';
import { pushJourneyScoreUpdate } from '../services/score-writeback.js';
import { evaluateAlertsForResolvedItem } from '../services/alert-evaluator.js';
import { normalizePhone } from '../services/ingestion.js';
import { resolveTranscriptAccess } from '../services/transcript-access.js';
import { parseTranscriptBlocks } from '../services/evidence-locator.js';
import {
  deriveSeverity,
  isItemPass,
  callPasses,
  JOURNEY_WORK_TABS,
  JOURNEY_LIST_SORTS,
} from '@callguard/shared';
import type {
  Journey,
  JourneyItemScore,
  JourneyWithDetail,
  JourneyListItem,
  JourneyListResponse,
  JourneyListSort,
  JourneyOutstanding,
  JourneyStatus,
  JourneyWorkTab,
  JourneyProduct,
  JourneyScoreRun,
  JourneyNote,
  JourneyNoteRevision,
  FeedbackStatus,
  FeedbackStatusSummary,
  RemediationOutcome,
  BreachSeverity,
  ClaimsDefenceResponse,
  ClaimsDefenceHeader,
  ClaimsDefenceCall,
  ClaimsDefenceCheckpoint,
  ClaimsDefenceFinding,
  ClaimsDefenceReconciliation,
  ClaimsDefenceReconciliationItem,
  ClaimsDefenceCorrection,
  ClaimsDefenceNote,
  SaleSearchResponse,
  SaleSearchCall,
  SaleSearchLine,
} from '@callguard/shared';

export const journeysRouter = Router();
journeysRouter.use(authenticate);

// When the sale actually happened: the last call in the set.
//
// Not created_at, which is when CallGuard assembled the journey — a backfill
// assembling six weeks of history today would stamp all of it with today. Not
// window_end either, which is set to assembly time and so equals created_at on
// every sale. And emphatically not scored_at, which a re-score rewrites, making
// a June sale claim to be from this morning.
//
// The last call is the only one of the four that survives both a backfill and a
// re-score, which is what a date column on a compliance register has to do.
//
// Fixed SQL, no user input — safe to interpolate, and shared by the list, the
// count and the range filter so all three agree on what a sale's date means.
// Exported so other org-wide reports (e.g. routes/board-pack.ts) date a sale
// the same way rather than inventing a second definition.
export const SALE_DATE_SQL = `COALESCE(
        (SELECT max(COALESCE(sc2.call_date, sc2.created_at))
           FROM journey_calls sjc JOIN calls sc2 ON sc2.id = sjc.call_id
          WHERE sjc.journey_id = j.id),
        j.created_at)`;

// Where a sale sits in the acknowledgement loop (CG-11), and how much is
// outstanding on it (CG-27): FEEDBACK_STATUS_SQL and friends now live in
// db/feedback-status.ts, shared with routes/calls.ts, which needs the same
// state for the sale a call belongs to.

// One filter on the sales list: a SQL fragment carrying its own parameters,
// with `?` standing in for each of them rather than a pre-assigned $n.
//
// WHY NOT PRE-NUMBERED: the per-tab counts rebuild the WHERE with one filter
// REMOVED, and a clause numbered at construction time cannot survive that.
// Dropping `j.status = $2` leaves a statement that references only $1 while two
// parameters are still bound, and Postgres rejects the bind outright — "bind
// message supplies 2 parameters, but prepared statement requires 1". That was
// not theoretical: it made every ?status= request on the sales screen 500, and
// the code carried a comment asserting Postgres allowed it. Renumbering at
// render time keeps a statement and its parameters in step no matter which
// fragment is left out.
export interface JourneyFilter {
  // Identifies the filter so a caller can exclude it by name.
  key: string;
  sql: string;
  params: unknown[];
}

export function buildWhere(
  filters: JourneyFilter[],
  excludeKey?: string
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const sql = filters
    .filter((f) => f.key !== excludeKey)
    .map((f) => {
      let i = 0;
      return f.sql.replace(/\?/g, () => {
        params.push(f.params[i++]);
        return `$${params.length}`;
      });
    })
    .join(' AND ');
  return { sql, params };
}

// ── The work-state axis on the sales list ────────────────────────────────────
//
// What a sale is WAITING FOR, phrased as the person who has to act. It replaced
// the job-status tabs (pending / scoring / scored / failed / skipped), which
// described the pipeline rather than the work: under them a row could not say
// whether it needed attention, and a sale reading 100% could hold four
// checkpoints nobody had ruled on — 130 such checkpoints at the main client,
// invisible on this screen, because a held checkpoint is left out of the score
// entirely.

// A sale still holding a checkpoint for a person to decide. Retired checkpoints
// are excluded exactly as the review queue excludes them (routes/review.ts):
// a strip offering "130 checkpoints to review" must not send a reviewer to a
// queue holding 128.
const UNREVIEWED_CHECKPOINT_SQL = `EXISTS (
        SELECT 1 FROM journey_item_scores ris
          JOIN scorecard_items rsi ON rsi.id = ris.scorecard_item_id
         WHERE ris.journey_id = j.id AND ris.result = 'manual_review'
           AND rsi.archived_at IS NULL)`;

// A sale with something the AI marked as failed. "Findings" rather than
// breaches: the breaches table is written per scoring run and cleared on a
// re-score, while this is the sale's own current checkpoint set — what the row
// shows, and what an adviser would be fed back.
const FAILED_CHECKPOINT_SQL = `EXISTS (
        SELECT 1 FROM journey_item_scores fis
          JOIN scorecard_items fsi ON fsi.id = fis.scorecard_item_id
         WHERE fis.journey_id = j.id AND fis.result = 'fail'
           AND fsi.archived_at IS NULL)`;

// The four facts a work state is read off.
//
// Named rather than inlined because the same definition has to be evaluated in
// two different contexts: per row in the list's WHERE (where they are
// correlated subqueries on `j`) and once per row in the grouped count (where
// they arrive as columns of a subselect). One definition, two renderings — the
// same reason buildWhere renumbers instead of pre-numbering, and the reason a
// tab and its own count can never come to mean different things.
export interface WorkStateFacts {
  status: string;
  feedbackStatus: string;
  unreviewed: string;
  findings: string;
}

// Rendered against the journeys table itself.
export const WORK_STATE_ON_JOURNEY: WorkStateFacts = {
  status: 'j.status',
  feedbackStatus: FEEDBACK_STATUS_SQL,
  unreviewed: UNREVIEWED_CHECKPOINT_SQL,
  findings: FAILED_CHECKPOINT_SQL,
};

// Rendered against the count query's subselect, which computes each fact once
// per row instead of once per predicate.
const WORK_STATE_ON_FACTS: WorkStateFacts = {
  status: 'j.status',
  feedbackStatus: 'j.feedback_status',
  unreviewed: 'j.has_unreviewed',
  findings: 'j.has_findings',
};

// The predicate behind one tab. Overlapping by design: a held checkpoint on a
// sale already fed back is both 'needs_me' and 'awaiting_adviser', so the tabs
// carry a count each rather than shares of one total — and "Show the 6" in the
// strip above lands on a tab showing exactly those 6.
export function workStateSql(tab: JourneyWorkTab, f: WorkStateFacts): string {
  switch (tab) {
    // Scored, and the next move is the compliance manager's.
    case 'needs_me':
      return `(${f.status} = 'scored' AND (${f.unreviewed}
                OR (${f.findings} AND ${f.feedbackStatus} = 'not_fed_back')))`;
    case 'awaiting_adviser':
      return `${f.feedbackStatus} = 'awaiting'`;
    case 'awaiting_outcome':
      return `${f.feedbackStatus} = 'awaiting_remediation'`;
    // 'acknowledged' already means nothing is owed (CG-27 split that out), so
    // the only thing left to exclude is a checkpoint still held for a person.
    case 'done':
      return `(${f.status} = 'scored' AND ${f.feedbackStatus} = 'acknowledged'
                AND NOT ${f.unreviewed})`;
    // NTU: the CRM stage marks the sale as not taken up, so it is deliberately
    // never scored (migration 071) — the same meaning the old "Not taken up"
    // tab carried.
    case 'not_taken_up':
      return `${f.status} = 'skipped'`;
    // Not a compliance outcome, which is why the three share one tab. 'failed'
    // belongs here rather than in a red tab of its own: scoring broke, the sale
    // did not fail compliance.
    case 'processing':
      return `${f.status} IN ('pending', 'scoring', 'failed')`;
    case 'all':
      return 'TRUE';
  }
}

// How long the sale's next step has been waiting, in whole days.
//
// Computed server-side because the list sorts on it: the number a row shows has
// to be the number it was ordered by. Which clock it is depends on the step —
// waiting to be acknowledged runs from the send, waiting for the work runs from
// the acknowledgement (CG-27), and waiting on the firm itself (a held
// checkpoint, or findings nobody has sent) runs from when the sale was scored.
// Null where nothing is waiting, so those rows sort last either way.
const WAITING_DAYS_SQL = `CASE
        WHEN ${FEEDBACK_STATUS_SQL} = 'awaiting'
          THEN FLOOR(EXTRACT(EPOCH FROM (now() - (${FEEDBACK_SENT_AT_SQL}))) / 86400)::int
        WHEN ${FEEDBACK_STATUS_SQL} = 'awaiting_remediation'
          THEN ${OLDEST_REMEDIATION_DAYS_SQL}
        WHEN ${workStateSql('needs_me', WORK_STATE_ON_JOURNEY)}
          THEN FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(j.scored_at, ${SALE_DATE_SQL}))) / 86400)::int
        ELSE NULL
      END`;

// What each sort orders by, as OUTPUT COLUMNS of the list query rather than
// repeated expressions — waiting_days alone is several correlated subqueries,
// and sorting on a second copy of it could order the list by something other
// than the number on screen.
const SORT_COLUMNS: Record<JourneyListSort, string> = {
  sale_date: 'sale_date',
  score: 'overall_score',
  waiting: 'waiting_days',
};

// Worst-first, for picking the severity a row leads with.
const SEVERITY_ORDER: BreachSeverity[] = ['critical', 'high', 'medium', 'low'];

// GET /api/journeys — the sales register: one page of sales for the org, the
// count behind every work-state tab, and what is outstanding across the firm.
// This is the primary discovery surface for journey-mode tenants (the default
// scoring_mode).
journeysRouter.get('/', requireOrgView, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = (page - 1) * limit;

    // score_only gates the VALUE, not just its display (services/
    // tenant-settings.ts): the verdict must not ship in the payload to a tenant
    // that is never shown one, and a filter on the verdict must not let them
    // infer it either.
    const scoreOnly = await orgHasFeature(orgId, 'score_only');

    const filters: JourneyFilter[] = [
      { key: 'org', sql: 'j.organization_id = ?', params: [orgId] },
    ];

    // The work-state tab (see workStateSql). Keyed, so the per-tab counts below
    // can rebuild the same WHERE without it — each tab should say how many
    // sales you would get by clicking it, which means every OTHER filter
    // applies but the tab itself does not.
    const tabParam = typeof req.query.tab === 'string' && req.query.tab ? req.query.tab : 'all';
    if (!(JOURNEY_WORK_TABS as string[]).includes(tabParam)) {
      throw new AppError(
        400,
        `Unknown tab "${tabParam}" — expected one of ${JOURNEY_WORK_TABS.join(', ')}`
      );
    }
    const tab = tabParam as JourneyWorkTab;
    if (tab !== 'all') {
      filters.push({ key: 'tab', sql: workStateSql(tab, WORK_STATE_ON_JOURNEY), params: [] });
    }

    // Customer name or phone. Phone-ish input is normalised to the stored
    // E.164 form first, exactly as the customer search does (routes/
    // customers.ts) — a raw match on "07700" would never find "+447700…".
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      const digits = q.replace(/[\s()-]/g, '');
      const phone = /^\+?\d[\d\s()-]*$/.test(q) ? (normalizePhone(digits) ?? digits) : q;
      filters.push({
        key: 'q',
        sql: `EXISTS (SELECT 1 FROM customers qc
                       WHERE qc.id = j.customer_id
                         AND (qc.name ILIKE ? OR qc.phone_normalized ILIKE ?))`,
        params: [`%${q}%`, `%${phone}%`],
      });
    }

    // The job status. No longer a tab (see the work states above), kept as a
    // filter for anything already linking here by it — including
    // ?status=skipped, which returned everything for as long as it was omitted.
    const status = req.query.status as string | undefined;
    if (status && ['pending', 'scoring', 'scored', 'failed', 'skipped'].includes(status)) {
      filters.push({ key: 'status', sql: 'j.status = ?', params: [status as JourneyStatus] });
    }
    if (typeof req.query.customer_id === 'string') {
      filters.push({ key: 'customer', sql: 'j.customer_id = ?', params: [req.query.customer_id] });
    }
    // Branch, so a compliance manager can look at (say) every referred sale.
    // Validated against what is actually in use rather than a fixed list —
    // branches are per-tenant scorecard configuration, not a system enum. The
    // stored value is what the filter sends; rendering "on_risk" as "On risk"
    // is the UI's business.
    if (typeof req.query.branch === 'string' && req.query.branch.trim()) {
      filters.push({ key: 'branch', sql: 'j.branch = ?', params: [req.query.branch.trim()] });
    }
    // Pass/fail. Only meaningful on a scored sale — pass is NULL until then, so
    // this implicitly narrows to scored without needing both filters set. Not
    // honoured at all under score_only, where the verdict is withheld.
    const result = typeof req.query.result === 'string' ? req.query.result : '';
    if (!scoreOnly && (result === 'pass' || result === 'fail')) {
      filters.push({
        key: 'result',
        sql: `j.pass IS ${result === 'pass' ? 'TRUE' : 'FALSE'}`,
        params: [],
      });
    }
    // Date range on when the SALE happened, not when it was scored. Filtering on
    // scored_at meant "sales in the first week of July" silently included an
    // April sale re-scored in July and excluded a July sale scored late, which
    // is the opposite of what the filter appears to promise.
    if (typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)) {
      filters.push({ key: 'from', sql: `${SALE_DATE_SQL} >= ?::date`, params: [req.query.from] });
    }
    if (typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
      filters.push({
        key: 'to',
        sql: `${SALE_DATE_SQL} < (?::date + INTERVAL '1 day')`,
        params: [req.query.to],
      });
    }
    // Filter by the sale's closing adviser. Matched on the RESOLVED name (the
    // linked user's name where the call is linked, else the raw dialler string)
    // rather than on agent_id: a large share of calls arrive unlinked because
    // the dialler sends a short display name, and an id filter would silently
    // drop every one of those sales. Matching what the column actually shows
    // keeps the filter and the list consistent with each other.
    const agent = typeof req.query.agent === 'string' ? req.query.agent.trim() : '';
    if (agent) {
      filters.push({
        key: 'agent',
        sql: `(
        SELECT COALESCE(fu.name, fc.agent_name)
          FROM journey_calls fjc
          JOIN calls fc ON fc.id = fjc.call_id
          LEFT JOIN users fu ON fu.id = fc.agent_id
         WHERE fjc.journey_id = j.id
         ORDER BY (fjc.role = 'wrap_up') DESC,
                  CASE WHEN fjc.role = 'wrap_up'
                       THEN COALESCE(fc.call_date, fc.created_at) END ASC,
                  COALESCE(fc.call_date, fc.created_at) DESC
         LIMIT 1
      ) = ?`,
        params: [agent],
      });
    }
    // Where the sale sits in the acknowledgement loop (CG-11). Superseded on
    // screen by the work-state tabs, kept so existing links keep working.
    const feedback = typeof req.query.feedback === 'string' ? req.query.feedback : '';
    if (['not_fed_back', 'awaiting', 'awaiting_remediation', 'acknowledged'].includes(feedback)) {
      filters.push({ key: 'feedback', sql: `${FEEDBACK_STATUS_SQL} = ?`, params: [feedback] });
    }

    // Sorting. Rejected rather than quietly ignored: a list ordered by
    // something other than what its URL asks for is a list you cannot trust or
    // send to anybody. (The legacy status/feedback params above stay lenient,
    // so nothing already linking here breaks.)
    const sortParam =
      typeof req.query.sort === 'string' && req.query.sort ? req.query.sort : 'sale_date';
    if (!(JOURNEY_LIST_SORTS as string[]).includes(sortParam)) {
      throw new AppError(
        400,
        `Unknown sort "${sortParam}" — expected one of ${JOURNEY_LIST_SORTS.join(', ')}`
      );
    }
    const sort = sortParam as JourneyListSort;
    const dirParam = typeof req.query.dir === 'string' && req.query.dir ? req.query.dir : 'desc';
    if (dirParam !== 'asc' && dirParam !== 'desc') {
      throw new AppError(400, `Unknown sort direction "${dirParam}" — expected asc or desc`);
    }
    const direction = dirParam === 'asc' ? 'ASC' : 'DESC';

    const all = buildWhere(filters);
    const withoutTab = buildWhere(filters, 'tab');

    const countRow = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM journeys j WHERE ${all.sql}`,
      all.params
    );

    // The tab counts and the outstanding figures are the REGISTER's summary,
    // and a request for one customer's sales is not the register: the customer
    // profile reads this endpoint for one person, and both figures are org-wide
    // scans it would pay for and never show.
    const summarise = !req.query.customer_id;

    // One count per tab, in one pass. The facts each predicate is written over
    // are computed once per row in the subselect and filtered over, rather than
    // re-evaluated per tab: FEEDBACK_STATUS_SQL alone is three correlated
    // EXISTS, and four tabs asking it separately would be four times the work
    // for the same answer.
    const tabCountRow = summarise
      ? await queryOne<Record<string, string | null>>(
          `SELECT ${JOURNEY_WORK_TABS.map(
            (t) => `COUNT(*) FILTER (WHERE ${workStateSql(t, WORK_STATE_ON_FACTS)})::text AS tab_${t}`
          ).join(',\n              ')}
         FROM (SELECT j.status,
                      ${FEEDBACK_STATUS_SQL} AS feedback_status,
                      ${UNREVIEWED_CHECKPOINT_SQL} AS has_unreviewed,
                      ${FAILED_CHECKPOINT_SQL} AS has_findings
                 FROM journeys j
                WHERE ${withoutTab.sql}) j`,
          withoutTab.params
        )
      : null;
    const tabCounts = summarise
      ? (Object.fromEntries(
          JOURNEY_WORK_TABS.map((t) => [t, parseInt(tabCountRow?.[`tab_${t}`] ?? '0', 10) || 0])
        ) as Record<JourneyWorkTab, number>)
      : undefined;

    const rows = await query<JourneyListItem>(
      `SELECT j.*,
              ${SALE_DATE_SQL} AS sale_date,
              -- How many times this sale has been scored. >1 tells a reviewer
              -- the score they are looking at replaced an earlier one, which
              -- matters when the earlier one was already fed back to an adviser.
              (SELECT COUNT(*)::int FROM journey_score_runs jsr
                WHERE jsr.journey_id = j.id) AS score_runs,
              -- Where the sale sits in the acknowledgement loop (CG-11).
              ${FEEDBACK_STATUS_SQL} AS feedback_status,
              ${FEEDBACK_SENT_AT_SQL} AS feedback_sent_at,
              ${FEEDBACK_CONFIRMED_AT_SQL} AS feedback_confirmed_at,
              -- What is still owed on this sale, and since when (CG-27).
              ${OPEN_REMEDIATIONS_SQL} AS open_remediations,
              ${OLDEST_REMEDIATION_DAYS_SQL} AS oldest_remediation_days,
              -- How long the next step has been waiting, and what the list can
              -- be ordered by (see WAITING_DAYS_SQL).
              ${WAITING_DAYS_SQL} AS waiting_days,
              cust.name AS customer_name,
              cust.phone_normalized AS customer_phone,
              sc.name AS scorecard_name,
              ja.agent_name,
              (SELECT COUNT(*)::int FROM journey_calls jc WHERE jc.journey_id = j.id) AS call_count,
              -- How many distinct advisers worked the sale. A quarter of sales
              -- span two, so the single agent_name above would misrepresent
              -- them; the UI shows a "+N" against the closer rather than
              -- implying sole ownership.
              (SELECT COUNT(DISTINCT COALESCE(au.name, ac.agent_name))::int
                 FROM journey_calls ajc
                 JOIN calls ac ON ac.id = ajc.call_id
                 LEFT JOIN users au ON au.id = ac.agent_id
                WHERE ajc.journey_id = j.id
                  AND COALESCE(au.name, ac.agent_name) IS NOT NULL) AS agent_count
         FROM journeys j
         LEFT JOIN customers cust ON cust.id = j.customer_id
         LEFT JOIN scorecards sc ON sc.id = j.scorecard_id
         -- The sale's closing adviser, resolved exactly as breaches, review,
         -- the dashboard and the Zoho write-back do (JOURNEY_AGENT_JOIN in
         -- routes/breaches.ts): earliest call flagged wrap_up, else the latest
         -- call in the set. Prefers the linked user's name over the raw dialler
         -- string, so a call the dialler labelled "Lewis" shows as the adviser
         -- record it resolves to.
         LEFT JOIN LATERAL (
           SELECT COALESCE(wu.name, wc.agent_name) AS agent_name
             FROM journey_calls wjc
             JOIN calls wc ON wc.id = wjc.call_id
             LEFT JOIN users wu ON wu.id = wc.agent_id
            WHERE wjc.journey_id = j.id
            ORDER BY (wjc.role = 'wrap_up') DESC,
                     CASE WHEN wjc.role = 'wrap_up'
                          THEN COALESCE(wc.call_date, wc.created_at) END ASC,
                     COALESCE(wc.call_date, wc.created_at) DESC
            LIMIT 1
         ) ja ON TRUE
        WHERE ${all.sql}
        -- The chosen sort, then by when the sale happened, so a re-score never
        -- moves a row and a backfill lands in its own history rather than on
        -- top of today's. created_at breaks the tie for two sales closed on the
        -- same call. NULLS LAST on the sort key: a sale with no score, or with
        -- nothing waiting, has no place at the top of either ordering.
        ORDER BY ${SORT_COLUMNS[sort]} ${direction} NULLS LAST,
                 sale_date DESC, j.created_at DESC
        LIMIT $${all.params.length + 1} OFFSET $${all.params.length + 2}`,
      [...all.params, limit, offset]
    );

    // What this page's sales actually found, read LIVE off their checkpoints.
    //
    // Not from journey_score_runs.items_failed / items_manual_review: those are
    // a frozen record of one run, and resolving a held checkpoint rewrites the
    // item score and the sale's total while leaving the run untouched. Reading
    // the run would keep offering checkpoints that had already been reviewed —
    // and "4 to review" that is really 0 teaches a reviewer to ignore the
    // column, which is how 130 real ones went unnoticed in the first place.
    //
    // Keyed on this page's ids rather than joined into the query above, so it
    // touches 50 sales' worth of checkpoints and not the whole firm's.
    const ids = rows.map((r) => r.id);
    const checkpointRows = ids.length
      ? await query<{ journey_id: string; result: string; severity: string | null; weight: string }>(
          `SELECT jis.journey_id, jis.result, si.severity, si.weight::text AS weight
             FROM journey_item_scores jis
             JOIN scorecard_items si ON si.id = jis.scorecard_item_id
            WHERE jis.journey_id = ANY($1::uuid[])
              AND jis.result IN ('fail', 'manual_review')
              -- Retired checkpoints drop out, as they do in the review queue.
              AND si.archived_at IS NULL`,
          [ids]
        )
      : [];
    const findings = new Map<
      string,
      { items_failed: number; items_to_review: number; worst_failed_severity: BreachSeverity | null }
    >();
    for (const row of checkpointRows) {
      const f = findings.get(row.journey_id) ?? {
        items_failed: 0,
        items_to_review: 0,
        worst_failed_severity: null as BreachSeverity | null,
      };
      if (row.result === 'manual_review') {
        f.items_to_review++;
      } else {
        f.items_failed++;
        // The severity the sale was actually judged by: a scorecard need not
        // set one per checkpoint, and scoring, the pass gate and the breach
        // register all fall back to the item's weight (deriveSeverity), exactly
        // as the sale page does.
        const severity = deriveSeverity(Number(row.weight), row.severity);
        if (
          f.worst_failed_severity == null ||
          SEVERITY_ORDER.indexOf(severity) < SEVERITY_ORDER.indexOf(f.worst_failed_severity)
        ) {
          f.worst_failed_severity = severity;
        }
      }
      findings.set(row.journey_id, f);
    }

    // SELECT j.* pulls the server-only trigger_context (raw Zoho payload, can
    // carry PII) — strip it from every row before responding.
    const data = (rows as Array<JourneyListItem & { trigger_context?: unknown }>).map(
      ({ trigger_context: _t, ...r }) => ({
        ...(r as JourneyListItem),
        // Withheld under score_only, not merely hidden by the client.
        pass: scoreOnly ? null : r.pass,
        items_failed: findings.get(r.id)?.items_failed ?? 0,
        items_to_review: findings.get(r.id)?.items_to_review ?? 0,
        worst_failed_severity: findings.get(r.id)?.worst_failed_severity ?? null,
      })
    );

    // The acknowledgement backlog (CG-11) and the remediation backlog behind it
    // (CG-27), ACROSS THE FIRM — deliberately not under the list's filters.
    // This is the standing figure a principal asks for, and the two banners it
    // replaced vanished on the very click that filtered to them.
    //
    // One scan, grouped, rather than three counts and a fourth query for the
    // age. max(now() - sent_at) is taken over the OPEN rows only — a confirmed
    // round is not waiting for anything, and including it would report a
    // backlog age for a tenant with nothing outstanding.
    const feedbackRows = !summarise
      ? []
      : await query<{
      feedback_status: FeedbackStatus;
      count: string;
      oldest_awaiting_days: string | null;
      oldest_remediation_days: string | null;
    }>(
      `SELECT ${FEEDBACK_STATUS_SQL} AS feedback_status,
              COUNT(*)::text AS count,
              MAX(CASE WHEN NOT EXISTS (
                    SELECT 1 FROM journey_feedback f2
                     WHERE f2.journey_id = j.id AND f2.confirmed_at IS NULL
                       AND ${feedbackReachedCloserSql('f2')})
                  THEN NULL
                  ELSE FLOOR(EXTRACT(EPOCH FROM (now() - (${FEEDBACK_SENT_AT_SQL}))) / 86400)
              END)::text AS oldest_awaiting_days,
              -- The same figure for the other backlog (CG-27). Taken over every
              -- row in the group rather than only the 'awaiting_remediation'
              -- ones for the same reason as above: NULL everywhere else, so the
              -- max is the group's answer where the group has one.
              MAX(${OLDEST_REMEDIATION_DAYS_SQL})::text AS oldest_remediation_days
         FROM journeys j
        WHERE j.organization_id = $1
        GROUP BY 1`,
      [orgId]
    );
    const feedbackCounts: FeedbackStatusSummary = {
      not_fed_back: 0,
      awaiting: 0,
      awaiting_remediation: 0,
      acknowledged: 0,
      oldest_awaiting_days: null,
      oldest_remediation_days: null,
    };
    for (const row of feedbackRows) {
      feedbackCounts[row.feedback_status] = parseInt(row.count, 10);
      if (row.feedback_status === 'awaiting' && row.oldest_awaiting_days != null) {
        feedbackCounts.oldest_awaiting_days = parseInt(row.oldest_awaiting_days, 10);
      }
      if (row.feedback_status === 'awaiting_remediation' && row.oldest_remediation_days != null) {
        feedbackCounts.oldest_remediation_days = parseInt(row.oldest_remediation_days, 10);
      }
    }

    // The review backlog, across the firm: the figure this screen never showed.
    // Sale checkpoints only — the review queue also holds per-call ones, so its
    // own total can be larger, which is why the strip links to it rather than
    // claiming to be it.
    const reviewRow = !summarise
      ? null
      : await queryOne<{ checkpoints: string | null; sales: string | null }>(
      `SELECT COUNT(*)::text AS checkpoints,
              COUNT(DISTINCT jis.journey_id)::text AS sales
         FROM journey_item_scores jis
         JOIN journeys j ON j.id = jis.journey_id
         JOIN scorecard_items si ON si.id = jis.scorecard_item_id
        WHERE j.organization_id = $1
          AND jis.result = 'manual_review'
          AND si.archived_at IS NULL`,
      [orgId]
    );

    const outstanding: JourneyOutstanding | undefined = summarise
      ? {
          awaiting_confirmation: feedbackCounts.awaiting,
          oldest_awaiting_days: feedbackCounts.oldest_awaiting_days,
          awaiting_outcome: feedbackCounts.awaiting_remediation,
          oldest_outcome_days: feedbackCounts.oldest_remediation_days,
          review_checkpoints: parseInt(reviewRow?.checkpoints ?? '0', 10) || 0,
          review_sales: parseInt(reviewRow?.sales ?? '0', 10) || 0,
        }
      : undefined;

    const body: JourneyListResponse = {
      data,
      total: parseInt(countRow?.count || '0'),
      page,
      limit,
      tab_counts: tabCounts,
      outstanding,
      feedback_counts: summarise ? feedbackCounts : undefined,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /api/journeys/:id — full journey detail: which calls composed it, and
// the per-checkpoint result across the whole set (spec §9).
// GET /api/journeys/advisers — distinct closing advisers across the org's
// sales, for the sales-list filter dropdown.
//
// Registered BEFORE '/:id' or Express matches "advisers" as a journey id.
//
// Deliberately not reusing GET /agents: that endpoint is requireAdmin and
// returns per-adviser performance stats, so a supervisor could not populate
// this filter without being handed data they are not otherwise shown. This
// returns only names that already appear in the sales list the caller can see,
// so it adds no new exposure.
journeysRouter.get('/advisers', requireOrgView, async (req, res, next) => {
  try {
    const rows = await query<{ agent_name: string }>(
      `SELECT DISTINCT ja.agent_name
         FROM journeys j
         JOIN LATERAL (
           SELECT COALESCE(wu.name, wc.agent_name) AS agent_name
             FROM journey_calls wjc
             JOIN calls wc ON wc.id = wjc.call_id
             LEFT JOIN users wu ON wu.id = wc.agent_id
            WHERE wjc.journey_id = j.id
            ORDER BY (wjc.role = 'wrap_up') DESC,
                     CASE WHEN wjc.role = 'wrap_up'
                          THEN COALESCE(wc.call_date, wc.created_at) END ASC,
                     COALESCE(wc.call_date, wc.created_at) DESC
            LIMIT 1
         ) ja ON TRUE
        WHERE j.organization_id = $1
          AND ja.agent_name IS NOT NULL
        ORDER BY ja.agent_name`,
      [req.user!.organizationId]
    );
    res.json({ data: rows.map((r) => r.agent_name) });
  } catch (err) {
    next(err);
  }
});

// GET /api/journeys/branches — the branches actually in use across the org's
// sales, for the list filter.
//
// Read from the sales rather than from scorecard.branch_config: a branch that
// is configured but has never been resolved would offer a filter that always
// returns nothing, and a sale scored under an older scorecard version may sit
// on a branch the current config no longer lists. What is in the data is what
// the filter should offer.
//
// Registered BEFORE '/:id' — Express would otherwise match "branches" as an id.
journeysRouter.get('/branches', requireOrgView, async (req, res, next) => {
  try {
    const rows = await query<{ branch: string }>(
      `SELECT DISTINCT branch FROM journeys
        WHERE organization_id = $1 AND branch IS NOT NULL
        ORDER BY branch`,
      [req.user!.organizationId]
    );
    res.json({ data: rows.map((r) => r.branch) });
  } catch (err) {
    next(err);
  }
});

journeysRouter.get('/:id', requireOrgView, async (req, res, next) => {
  try {
    const journey = await queryOne<Journey>(
      'SELECT * FROM journeys WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!journey) throw new AppError(404, 'Journey not found');

    // The calls that composed this sale. call_date is only populated when the
    // ingestion source carried one (dialler payload / parsed filename), so fall
    // back to created_at the way every other call view does — a linked call
    // must never render as "Undated". agent_name likewise falls back to the
    // linked user record when the source payload had no name.
    const calls = await query<JourneyWithDetail['calls'][number]>(
      `SELECT c.id, jc.role,
              COALESCE(c.call_date::timestamptz, c.created_at) AS call_date,
              COALESCE(u.name, c.agent_name) AS agent_name,
              c.direction, c.duration_seconds, c.status,
              c.speaker_integrity_flag,
              (COALESCE(c.transcript_text, '') <> '') AS has_transcript,
              cs.overall_score, cs.pass
         FROM journey_calls jc
         JOIN calls c ON c.id = jc.call_id
         LEFT JOIN users u ON u.id = c.agent_id
         LEFT JOIN LATERAL (
           SELECT overall_score, pass
             FROM call_scores
            WHERE call_id = c.id
            ORDER BY created_at DESC
            LIMIT 1
         ) cs ON TRUE
        WHERE jc.journey_id = $1
        ORDER BY COALESCE(c.call_date::timestamptz, c.created_at) ASC`,
      [journey.id]
    );

    const itemRows = await query<JourneyItemScore & { label: string; section: string | null; severity: string | null; weight: string; applies_to_products: string[] | null }>(
      `SELECT jis.*, si.label, si.section, si.severity, si.weight::text AS weight, si.applies_to_products
         FROM journey_item_scores jis
         JOIN scorecard_items si ON si.id = jis.scorecard_item_id
        WHERE jis.journey_id = $1
        ORDER BY si.sort_order`,
      [journey.id]
    );
    // The severity the sale was actually judged by. A scorecard need not set one
    // per checkpoint — scoring falls back to the item's weight (deriveSeverity),
    // and so do the breach register and the pass gate. Returning the raw column
    // instead left the page showing no severity at all on such a scorecard, for
    // failures the rest of the system treats as critical.
    const itemScores = itemRows.map(({ weight, severity, ...row }) => ({
      ...row,
      severity: deriveSeverity(Number(weight), severity),
    }));

    // Whose journey this is — the detail page titles itself with the customer
    // and links back to the profile.
    const customer = await queryOne<{ name: string | null; phone_normalized: string }>(
      'SELECT name, phone_normalized FROM customers WHERE id = $1',
      [journey.customer_id]
    );

    // The products this sale covered (empty for orgs not using product scoping)
    // — shown on the detail page and used to explain why product-scoped items
    // resolved to N/A.
    const products = await query<JourneyProduct>(
      `SELECT id, journey_id, product_id, product_name, source, created_at
         FROM journey_products WHERE journey_id = $1
        ORDER BY product_name`,
      [journey.id]
    );

    // Scoring history (migration 074). Returned on every sale so the UI can
    // show that a score has been re-run and what it was before, rather than
    // presenting the latest number as though it were the only one there has
    // ever been. Ordered newest-first; run 1 is the original.
    const scoreRuns = await query<JourneyScoreRun>(
      `SELECT r.id, r.run_number, r.overall_score, r.pass, r.branch, r.branch_source,
              r.model_id, r.items_passed, r.items_failed, r.items_na, r.items_manual_review,
              r.calls_scored, r.trigger_source, r.created_at, u.name AS triggered_by_name
         FROM journey_score_runs r
         LEFT JOIN users u ON u.id = r.triggered_by
        WHERE r.journey_id = $1
        ORDER BY r.run_number DESC`,
      [journey.id]
    );

    // trigger_context is a server-only routing field: a raw snapshot of the
    // Zoho sale-trigger payload (used to resolve capture forms), which can
    // carry customer PII. It's kept off the shared Journey type, but SELECT *
    // returns it at runtime — strip it before responding.
    const { trigger_context: _triggerContext, ...journeyPublic } =
      journey as Journey & { trigger_context?: unknown };

    res.json({
      ...journeyPublic,
      calls,
      item_scores: itemScores,
      products,
      score_runs: scoreRuns,
      customer_name: customer?.name ?? null,
      customer_phone: customer?.phone_normalized ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// ── Searching a sale's transcripts ───────────────────────────────────────────

// Two characters, the same floor the call page's find-in-transcript uses.
const SALE_SEARCH_MIN_TERM = 2;
// Lines either side of a hit, so it reads as conversation. One, not the two the
// evidence excerpt returns: this endpoint can return many hits at once, and the
// excerpt's two-line context was justified for a single checkpoint under
// review, not multiplied across a whole sale.
const SALE_SEARCH_CONTEXT_LINES = 1;
// A ceiling on the response, not on the search. A single-word term on a long
// sale can match hundreds of lines, and a stepper is useless past a point; the
// page says the list was cut rather than presenting it as the whole answer.
const SALE_SEARCH_MAX_MATCHES = 200;

// GET /api/journeys/:id/transcript-search?q= — "was this said anywhere in the
// sale?", answered across every call at once.
//
// A sale is several calls scored as one compliance unit, and the sale page
// shows no transcript: opening a checkpoint fetches the quoted line and two
// either side, and nothing else. To ask whether a word was ever used a
// compliance officer had to open each call in turn, search it, come back, and
// hold the answers in their head.
//
// SEARCHED ON THE SERVER, NOT IN THE BROWSER. Two reasons, and the first is the
// one that decides it:
//
//  1. A user who may not read this firm's transcripts must not be sent them.
//     Searching in the browser means shipping every transcript in the sale to
//     it; no client-side gate can un-send that. Here the gate runs before a
//     transcript is read out of the database at all.
//  2. A sale can be ten calls and a transcript is tens of thousands of words.
//     This returns the matching lines and their neighbours — a few kilobytes —
//     rather than the whole set, on a page that already loads a great deal.
//
// Nothing is fetched until someone searches: this is a separate request the
// sale page only makes once a term has been typed, so a reviewer who never
// searches pays nothing.
journeysRouter.get('/:id/transcript-search', requireOrgView, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const raw = typeof req.query.q === 'string' ? req.query.q : '';
    const term = raw.trim();

    // Same floor as the call page's find-in-transcript (CallTranscript.tsx):
    // one character matches most lines of most calls, which is not a search.
    if (term.length < SALE_SEARCH_MIN_TERM) {
      throw new AppError(400, 'Type at least two characters to search this sale.');
    }

    // Org-scoped exactly as GET /:id is — another firm's sale 404s rather than
    // 403s, so a probe cannot tell "not yours" from "does not exist".
    const journey = await queryOne<{ id: string }>(
      'SELECT id FROM journeys WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    );
    if (!journey) throw new AppError(404, 'Journey not found');

    // A search result IS transcript, so the transcript gate applies unchanged
    // (services/transcript-access.ts). No excerpt exception here: the one in
    // mayShowEvidenceExcerpt exists for a checkpoint the user has been asked to
    // rule on, and a free-text search over a whole sale is the opposite case —
    // it is exactly the "open checkpoint after checkpoint until you have most
    // of the transcript" the restriction exists to prevent. Withheld before any
    // transcript is read, and with no counts: "warranty — 4 matches" tells the
    // reader the word was used, which is the content itself.
    const access = await resolveTranscriptAccess(orgId, req.user!.role);
    if (!access.readable) {
      const withheld: SaleSearchResponse = {
        query: term,
        restricted: true,
        total_matches: 0,
        searched_calls: 0,
        unsearchable_calls: 0,
        truncated: false,
        calls: [],
      };
      res.json(withheld);
      return;
    }

    // Ordered as GET /:id orders the sale's calls, so "Call 2" here is the same
    // call as "Call 2" on the page — and, because only transcribed calls are
    // numbered, the same call the scorer meant by it too.
    const calls = await query<{
      id: string;
      call_date: string;
      agent_name: string | null;
      transcript_text: string | null;
    }>(
      `SELECT c.id,
              COALESCE(c.call_date::timestamptz, c.created_at) AS call_date,
              COALESCE(u.name, c.agent_name) AS agent_name,
              c.transcript_text
         FROM journey_calls jc
         JOIN calls c ON c.id = jc.call_id
         LEFT JOIN users u ON u.id = c.agent_id
        WHERE jc.journey_id = $1 AND c.organization_id = $2
        ORDER BY COALESCE(c.call_date::timestamptz, c.created_at) ASC`,
      [journey.id, orgId]
    );

    const needle = term.toLowerCase();
    const results: SaleSearchCall[] = [];
    let searched = 0;
    let unsearchable = 0;
    let total = 0;
    let truncated = false;

    for (const call of calls) {
      if (!call.transcript_text) {
        // Still transcribing, or never transcribed. It has no words to search,
        // which is not the same as having no matches — the page says so.
        unsearchable++;
        continue;
      }
      searched++;
      const callNumber = searched;
      if (truncated) continue;

      const blocks = parseTranscriptBlocks(call.transcript_text);
      const matches: SaleSearchCall['matches'] = [];
      for (const block of blocks) {
        if (!block.text.toLowerCase().includes(needle)) continue;
        if (total >= SALE_SEARCH_MAX_MATCHES) {
          truncated = true;
          break;
        }
        total++;
        const from = Math.max(0, block.index - SALE_SEARCH_CONTEXT_LINES);
        const to = Math.min(blocks.length - 1, block.index + SALE_SEARCH_CONTEXT_LINES);
        const lines: SaleSearchLine[] = [];
        for (let i = from; i <= to; i++) {
          lines.push({ ...blocks[i], is_match: i === block.index });
        }
        matches.push({ line_index: block.index, lines });
      }

      if (matches.length > 0) {
        results.push({
          call_id: call.id,
          call_number: callNumber,
          call_date: call.call_date,
          agent_name: call.agent_name,
          match_count: matches.length,
          matches,
        });
      }
    }

    const response: SaleSearchResponse = {
      query: term,
      restricted: false,
      total_matches: total,
      searched_calls: searched,
      unsearchable_calls: unsearchable,
      truncated,
      calls: results,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

// GET /api/journeys/:id/claims-defence — a per-sale evidence pack for when an
// insurer declines a claim or a customer complains: what was said on the
// call, what was submitted to the insurer, the AI's checkpoint verdicts, the
// findings against them, and every human ruling on top. Audience is a
// compliance officer, an insurer, or the Financial Ombudsman — this document
// leaves the building, so every field on it is chosen for that.
//
// Same guard as every other report route (requireOrgView: admin/supervisor/
// viewer — advisers must not reach it) and the same org.
// scope as GET /:id: a journey belonging to another org 404s rather than
// 403s, so a probing request cannot tell the difference between "not yours"
// and "does not exist".
//
// PRIVACY: capture_reconciliation_items.call_answer is the field this route
// exports for "what the customer said" — not because it was picked over some
// redacted alternative, but because there is no such alternative to pick.
// call_answer_redacted is a boolean, not a second text column: when the
// customer's answer was itself redacted before storage, comparePair (jobs/
// processors/reconcile.ts) forces call_answer to null and sets that flag
// instead, so a non-null call_answer never carries a redaction placeholder —
// and because it is read from the call's own transcript, which had personal
// data (PII/PCI/PHI) redacted at source by Deepgram before the transcript was
// ever written to storage, it never carried the customer's personal data to
// begin with. Both fields travel together so a reader can tell "the customer
// answered, here it is" from "the customer answered, the value was redacted"
// rather than reading a bare null as silence.
//
// PRIVACY, second field: journey_feedback_items.remediation_note (CG-26) is
// free text an adviser typed about what they did for this customer, and it is
// exported unredacted. It is here on the same footing as the case notes (CG-9)
// already in the pack — staff-written prose about this case, for a reader of
// this case — and the pack already names the customer and their number in its
// header, so it is not a new category of disclosure about the data subject.
// What it can carry that the machine-derived fields cannot is a third party the
// adviser mentions in passing ("spoke to his wife"), which is a reason for the
// limitations bullet below to say plainly whose words these are, not a reason to
// withhold the answer to the question the pack exists to answer. The adviser's
// note reaches this route via the tokenised page, which is unauthenticated —
// this route is not: requireOrgView still applies, and nothing on the adviser's
// side can read the pack.
//
// Deliberately does not surface journeys.coverage — same Phase 2 gate as the
// board pack (routes/board-pack.ts) — see the TODO in the limitations block
// below.
journeysRouter.get('/:id/claims-defence', requireOrgView, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;

    const journey = await queryOne<{
      id: string;
      status: JourneyStatus;
      overall_score: string | null;
      pass: boolean | null;
      scorecard_version: number;
      customer_id: string;
      scorecard_name: string | null;
      sale_date: string;
    }>(
      `SELECT j.id, j.status, j.overall_score, j.pass, j.scorecard_version, j.customer_id,
              sc.name AS scorecard_name, ${SALE_DATE_SQL} AS sale_date
         FROM journeys j
         LEFT JOIN scorecards sc ON sc.id = j.scorecard_id
        WHERE j.id = $1 AND j.organization_id = $2`,
      [req.params.id, orgId]
    );
    if (!journey) throw new AppError(404, 'Sale not found');

    const customer = await queryOne<{ name: string | null; phone_normalized: string }>(
      'SELECT name, phone_normalized FROM customers WHERE id = $1',
      [journey.customer_id]
    );

    // The closing adviser, resolved exactly as the sales list and the
    // breaches report attribute a sale (JOURNEY_AGENT_JOIN in routes/
    // breaches.ts): earliest call flagged wrap_up, else the latest call in
    // the set. Written out here rather than reused because that join is keyed
    // to a breach's journey_id, not a journeys row.
    const adviser = await queryOne<{ agent_name: string | null }>(
      `SELECT COALESCE(u.name, c.agent_name) AS agent_name
         FROM journey_calls jc
         JOIN calls c ON c.id = jc.call_id
         LEFT JOIN users u ON u.id = c.agent_id
        WHERE jc.journey_id = $1
        ORDER BY (jc.role = 'wrap_up') DESC,
                 CASE WHEN jc.role = 'wrap_up'
                      THEN COALESCE(c.call_date, c.created_at) END ASC,
                 COALESCE(c.call_date, c.created_at) DESC
        LIMIT 1`,
      [journey.id]
    );

    const header: ClaimsDefenceHeader = {
      journey_id: journey.id,
      customer_name: customer?.name ?? null,
      customer_phone: customer?.phone_normalized ?? null,
      sale_date: journey.sale_date,
      adviser_name: adviser?.agent_name ?? null,
      scorecard_name: journey.scorecard_name,
      scorecard_version: journey.scorecard_version,
      status: journey.status,
      overall_score: journey.overall_score != null ? Number(journey.overall_score) : null,
      pass: journey.pass,
    };

    // 2. Evidence basis — the calls the verdict rests on.
    const evidenceBasis = await query<ClaimsDefenceCall>(
      `SELECT c.id, jc.role,
              COALESCE(c.call_date::timestamptz, c.created_at) AS call_date,
              c.duration_seconds,
              COALESCE(u.name, c.agent_name) AS agent_name
         FROM journey_calls jc
         JOIN calls c ON c.id = jc.call_id
         LEFT JOIN users u ON u.id = c.agent_id
        WHERE jc.journey_id = $1
        ORDER BY COALESCE(c.call_date::timestamptz, c.created_at) ASC`,
      [journey.id]
    );

    // 3. Checkpoint results — every item, including na / manual_review. An
    // omitted checkpoint looks like something hidden.
    const checkpoints = await query<ClaimsDefenceCheckpoint>(
      `SELECT jis.id, si.label, si.section, jis.result, jis.evidence, jis.reasoning,
              jis.confidence, jis.source_call_id, jis.source_timestamp
         FROM journey_item_scores jis
         JOIN scorecard_items si ON si.id = jis.scorecard_item_id
        WHERE jis.journey_id = $1
        ORDER BY si.sort_order`,
      [journey.id]
    );

    // 4. Findings — breaches for this sale, with the caveat and confirmation
    // fields the breaches report template omits today. Ordered severity then
    // recency, matching GET /breaches/report's own (alphabetical-on-severity)
    // ordering, for consistency across the app's reports.
    //
    // Each finding also carries what was asked of the adviser and what they
    // said they did about it (CG-26) — the sixth step of the evidence chain,
    // and the one that answers "what was done about it?" rather than only "were
    // you told?".
    //
    // The lateral joins on scorecard_item_id, NOT on
    // journey_feedback_items.breach_id, and that is the whole reason this
    // survives contact with production. breach_id is ON DELETE SET NULL (087)
    // and a re-score deletes and recreates this sale's breaches, so joining on
    // it would drop the adviser's answer from the pack the first time anybody
    // re-scored the sale — silently, and with the answer still sitting in the
    // database. (feedback_id, scorecard_item_id) is the durable identity 087
    // built for exactly this, and it is keyed to the same checkpoint the breach
    // in front of it is.
    //
    // Which row wins, when a sale has been fed back more than once: the most
    // recent answer the adviser actually gave, and only failing that the most
    // recent time they were asked. A sale fed back, answered, re-scored and fed
    // back again must keep showing the answer rather than reverting to silence.
    const findingRows = await query<
      Omit<ClaimsDefenceFinding, 'remediation'> & {
        remediation_guidance: string | null;
        adviser_name: string | null;
        told_at: string | null;
        acknowledged_at: string | null;
        remediation_outcome: RemediationOutcome | null;
        remediation_note: string | null;
        remediated_at: string | null;
      }
    >(
      `SELECT b.id, si.label AS scorecard_item_label, b.severity, b.status,
              b.evidence_caveats, b.confirmed_at, b.detected_at,
              u.name AS confirmed_by_name,
              rem.remediation_guidance, rem.remediation_outcome,
              rem.remediation_note, rem.remediated_at,
              rem.adviser_name, rem.told_at, rem.acknowledged_at
         FROM breaches b
         JOIN scorecard_items si ON si.id = b.scorecard_item_id
         LEFT JOIN users u ON u.id = b.confirmed_by
         LEFT JOIN LATERAL (
           SELECT fi.remediation_guidance, fi.remediation_outcome,
                  fi.remediation_note, fi.remediated_at,
                  jf.adviser_name, jf.sent_at AS told_at,
                  jf.confirmed_at AS acknowledged_at
             FROM journey_feedback_items fi
             JOIN journey_feedback jf ON jf.id = fi.feedback_id
            WHERE jf.journey_id = $1
              AND fi.scorecard_item_id = b.scorecard_item_id
            ORDER BY (fi.remediation_outcome IS NOT NULL) DESC,
                     fi.remediated_at DESC NULLS LAST,
                     jf.sent_at DESC
            LIMIT 1
         ) rem ON TRUE
        WHERE b.journey_id = $1
        ORDER BY b.severity, b.detected_at DESC`,
      [journey.id]
    );

    // Answers given before the current one, read from the finding's own event
    // history. Every write appends a row rather than replacing one (116), so
    // "said unreachable, then said put right" is recoverable — and it is a fact
    // a claims file needs, because it shows persistence that the final answer
    // alone hides.
    //
    // Only the answer and its date survive here; breach_events does not carry
    // the note, and the column holds only the latest one. Disclosed below
    // rather than papered over.
    const answerHistory = findingRows.length
      ? await query<{ breach_id: string; outcome: RemediationOutcome; created_at: string }>(
          `SELECT breach_id, to_value AS outcome, created_at
             FROM breach_events
            WHERE breach_id = ANY($1::uuid[]) AND event_type = 'remediation_recorded'
            ORDER BY created_at ASC`,
          [findingRows.map((f) => f.id)]
        )
      : [];

    const findings: ClaimsDefenceFinding[] = findingRows.map((row) => {
      const {
        remediation_guidance: guidance,
        adviser_name: adviserName,
        told_at: toldAt,
        acknowledged_at: acknowledgedAt,
        remediation_outcome: outcome,
        remediation_note: note,
        remediated_at: recordedAt,
        ...finding
      } = row;

      // No feedback item for this checkpoint on this sale: it was never fed
      // back. adviser_name and sent_at are NOT NULL on the parent row, so
      // either both arrived or neither did.
      if (!adviserName || !toldAt) return { ...finding, remediation: null };

      // The last event restates the answer already shown above it, so it is
      // dropped rather than repeated. Nothing is dropped where the events are
      // gone entirely — a re-score cascades them away (006) while the answer
      // itself survives on the snapshot row.
      const events = answerHistory.filter((e) => e.breach_id === finding.id);
      return {
        ...finding,
        remediation: {
          guidance,
          adviser_name: adviserName,
          told_at: toldAt,
          acknowledged_at: acknowledgedAt,
          outcome,
          note,
          recorded_at: recordedAt,
          earlier_answers: events
            .slice(0, -1)
            .map((e) => ({ outcome: e.outcome, recorded_at: e.created_at })),
        },
      };
    });

    // 5. Said versus submitted — the latest reconciliation run for this sale,
    // if one exists. No run is a normal case (module not in use, or no
    // application document has arrived yet), not an error.
    const run = await queryOne<{
      id: string;
      status: string;
      extraction_method: 'profile' | 'model';
      completed_at: string | null;
    }>(
      `SELECT id, status, extraction_method, completed_at
         FROM capture_reconciliation_runs
        WHERE journey_id = $1 AND organization_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [journey.id, orgId]
    );
    let reconciliation: ClaimsDefenceReconciliation | null = null;
    if (run) {
      const items = await query<ClaimsDefenceReconciliationItem>(
        `SELECT id, question, application_answer, call_answer, call_answer_redacted,
                outcome, evidence, source_call_id, source_timestamp,
                answer_amended, amendment_type, revisions
           FROM capture_reconciliation_items
          WHERE run_id = $1
          ORDER BY sort_order ASC`,
        [run.id]
      );
      reconciliation = {
        status: run.status,
        extraction_method: run.extraction_method,
        completed_at: run.completed_at,
        items,
      };
    }

    // 6. Human review trail — score_corrections for this sale, oldest first
    // (a trail reads chronologically). original_pass IS NULL distinguishes
    // "the AI could not decide and a human ruled" from "a human overturned a
    // confident AI verdict" (migration 077).
    const humanReview = await query<ClaimsDefenceCorrection>(
      `SELECT sc.id, si.label AS scorecard_item_label, u.name AS corrected_by_name,
              sc.created_at, sc.original_pass, sc.corrected_pass, sc.reason
         FROM score_corrections sc
         JOIN scorecard_items si ON si.id = sc.scorecard_item_id
         LEFT JOIN users u ON u.id = sc.corrected_by
        WHERE sc.journey_id = $1
        ORDER BY sc.created_at ASC`,
      [journey.id]
    );

    // 7. Case-level notes (CG-9), oldest first, each with the versions it
    // replaced. Two queries rather than a join: a note with several revisions
    // would otherwise repeat its own body once per revision row, and the pack
    // must not be able to show the same note twice.
    const noteRows = await query<{
      id: string;
      body: string;
      author_name: string;
      created_at: string;
      edited_by_name: string | null;
      edited_at: string | null;
    }>(
      `SELECT id, body, author_name, created_at, edited_by_name, edited_at
         FROM journey_notes
        WHERE journey_id = $1
        ORDER BY created_at ASC`,
      [journey.id]
    );
    const revisionRows = noteRows.length
      ? await query<{
          note_id: string;
          body: string;
          author_name: string;
          written_at: string;
          superseded_at: string;
          superseded_by_name: string;
        }>(
          `SELECT note_id, body, author_name, written_at, superseded_at, superseded_by_name
             FROM journey_note_revisions
            WHERE note_id = ANY($1::uuid[])
            ORDER BY superseded_at ASC`,
          [noteRows.map((n) => n.id)]
        )
      : [];
    const notes: ClaimsDefenceNote[] = noteRows.map((n) => ({
      ...n,
      previous_versions: revisionRows
        .filter((r) => r.note_id === n.id)
        .map(({ note_id: _noteId, ...version }) => version),
    }));

    // 8. Limitations — read alongside the sections above, not as small print.
    const limitations: string[] = [
      "Reconciliation outcomes recorded as 'undetermined' mean the system could not establish an answer (most often health redaction removing the words needed to identify the question). This is deliberately never read as a failure, and never as a pass either.",
      "Questions checked for presence only ('recorded' / 'missing_from_application') are never compared against the call — they are excluded from any match-rate figure by design, because nothing about them was verified against the recording.",
      "An outcome of 'over_declaration' means the application recorded MORE than the customer said on a field where more means more risk (alcohol units, tobacco, time off work). It needs correcting, but it is not a possible non-disclosure and must never be described as one: declaring more cannot void a policy, it only makes the cover dearer than it needed to be.",
    ];
    if (reconciliation) {
      limitations.push(
        reconciliation.extraction_method === 'profile'
          ? "This sale's application was parsed deterministically, against a stored profile of this insurer's document — the same document parses the same way every time, which is what lets the \"said versus submitted\" findings below stand as evidence."
          : "This sale's application was read directly by a model rather than a stored profile, because no profile for this document format existed yet. That reading is a best effort and is not reproducible, and is replaced automatically once a profile for the format goes live — treat the \"said versus submitted\" findings below as provisional until then."
      );
    } else {
      limitations.push(
        'This sale has no reconciliation run: no application document has been matched to it, or the reconciliation module is not in use for this organisation. The findings above rest on the calls alone, with nothing to compare against a submitted application.'
      );
    }
    if (notes.length > 0) {
      // Said plainly because the notes sit next to machine-derived findings and
      // could otherwise be read with the same weight. They are one person's
      // account, not something CallGuard checked.
      limitations.push(
        'The case notes in this pack are written by staff at the firm, not produced or verified by CallGuard. They are recorded as stated, cannot be deleted, and any note that was amended shows every version it replaced.'
      );
    }
    if (findings.some((f) => f.remediation)) {
      // The remediation record is the one part of this pack a person asserted
      // about their own conduct. It has to be read that way, and the pack has to
      // say so before an insurer or the Ombudsman reads a tidy "Put right" as
      // something CallGuard established.
      limitations.push(
        "Where a finding shows what the adviser did about it, that is the adviser's own account, recorded by them on the link in their feedback email and stored as stated. CallGuard has not verified it against a recording, a document or anything else, and nobody at the firm signs these answers off — an outcome is an assertion by the person who was fed back, not a finding.",
        "A finding with no answer recorded means the adviser has not answered, never that no action was needed: \"no action needed\" is one of the three answers they can give and appears as such. The date shown against an answer is when it was recorded, not when the work was done — an adviser may be describing a call they made the previous week, and the note is where a date for the work itself can be stated."
      );
      if (findings.some((f) => f.remediation?.earlier_answers.length)) {
        limitations.push(
          "Where an adviser revised an answer, the earlier answers are shown with the dates they were given. Only the answer and its date are kept for a revised answer — the note that accompanied it is not retained, and any answer given against a finding that a later re-score replaced is no longer recoverable, though the most recent answer survives a re-score."
        );
      }
    }
    // TODO(partial-journey-coverage): once Phase 2 ships (false-positive
    // measurement approved per docs/partial-journey-detection.md §6), add a
    // limitations bullet here disclosing this sale's own coverage verdict
    // (journeys.coverage: complete / partial / unknown) and, when partial,
    // which stages the model judged missing (coverage_missing_stages) — the
    // strongest "an earlier call may be missing from this evidence" signal
    // this pack could carry. Not surfaced anywhere user-facing yet; see
    // migration 100_journey_coverage.sql.

    const response: ClaimsDefenceResponse = {
      header,
      evidence_basis: evidenceBasis,
      checkpoints,
      findings,
      reconciliation,
      human_review: humanReview,
      notes,
      limitations,
      generated_at: new Date().toISOString(),
    };

    res.json(response);
  } catch (err) {
    next(err);
  }
});

// POST /api/journeys/trigger — manually assemble + score a journey for a
// customer (fallback path when there's no Zoho sale trigger, or for
// re-scoring). Body: { customer_id, scorecard_id? }.
journeysRouter.post('/trigger', requireActioner, async (req, res, next) => {
  try {
    const { customer_id, scorecard_id } = req.body as { customer_id?: string; scorecard_id?: string };
    if (!customer_id) throw new AppError(400, 'customer_id is required');

    const customer = await queryOne<{ id: string }>(
      'SELECT id FROM customers WHERE id = $1 AND organization_id = $2',
      [customer_id, req.user!.organizationId]
    );
    if (!customer) throw new AppError(404, 'Customer not found');

    const journeyId = await assembleJourney({
      organizationId: req.user!.organizationId,
      customerId: customer_id,
      scorecardId: scorecard_id ?? null,
      triggerSource: 'manual',
    });

    if (!journeyId) {
      res.status(202).json({ message: 'No transcribed calls in the journey window — nothing to score' });
      return;
    }

    // assembleJourney is idempotent: for an already-scored sale over the same
    // calls it returns the existing journey without re-scoring. Tell the user
    // which happened so the button never looks like it did nothing.
    const j = await queryOne<{ status: JourneyStatus }>(
      'SELECT status FROM journeys WHERE id = $1',
      [journeyId]
    );
    const message =
      j?.status === 'scored'
        ? 'This sale is already scored. An admin can re-score it from the sale page.'
        : 'Scoring started — the result will appear below shortly.';

    res.status(202).json({ journey_id: journeyId, message });
  } catch (err) {
    next(err);
  }
});

// POST /api/journeys/:id/rescore — admin-only forced re-score of an existing
// sale (e.g. after a transcript correction). Re-runs the scorecard on the same
// calls: score-journey clears the sale's prior breaches and upserts its item
// scores, so this replaces the result in place rather than duplicating it, and
// re-pushes to the CRM. Deliberately admin-only and not a general button —
// each run spends scoring tokens, so it must be a considered action.
journeysRouter.post('/:id/rescore', requireAdmin, async (req, res, next) => {
  try {
    const journey = await queryOne<{ id: string; status: JourneyStatus; overall_score: string | null }>(
      'SELECT id, status, overall_score FROM journeys WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!journey) throw new AppError(404, 'Sale not found');
    if (journey.status === 'pending' || journey.status === 'scoring') {
      throw new AppError(409, 'This sale is already being scored');
    }

    // Refuse a re-score that cannot tell us anything new, unless explicitly
    // forced.
    //
    // Scoring is not free (roughly $0.34 a run on a scorecard this size) and it
    // is not perfectly repeatable, so re-running it on unchanged evidence bills
    // the tenant to draw another sample from the same distribution. A Trust
    // Point admin pressed it three times on one sale out of curiosity and
    // watched the number move each time — that cost real money and cost more
    // trust than it cost money.
    //
    // "Nothing new" means: same calls, same scorecard version, and the previous
    // run completed. Anything else (a backfilled call, an edited scorecard, a
    // failed run) legitimately warrants another go.
    // Deliberately NOT overridable by the tenant. An "are you sure?" that can be
    // clicked through is clicked through every time, and the whole problem here
    // is a button being pressed repeatedly on unchanged evidence. Platform
    // superadmins keep an override for support work.
    const isSuperadmin = req.user!.role === 'superadmin';

    // Refuse once the sale has been fed back to its adviser.
    //
    // A re-score replaces the sale's breaches. If the adviser has already been
    // sent the findings — and possibly confirmed receipt — re-scoring rewrites
    // what they were told about, after they were told. The feedback record keeps
    // its own snapshot so it stays honest, but the register would then hold a
    // confirmed conversation about findings the sale no longer has.
    //
    // Blocked from the moment it is SENT, not from confirmation: the email is
    // already in the adviser's inbox listing the findings by name.
    //
    // Same shape as the unchanged-evidence guard below and for the same reason —
    // not overridable by the tenant, because a confirm dialog on a button like
    // this gets clicked through. Superadmins keep the override for support.
    if (!isSuperadmin) {
      const fedBack = await queryOne<{ adviser_name: string; confirmed_at: string | null }>(
        `SELECT adviser_name, confirmed_at FROM journey_feedback
          WHERE journey_id = $1 ORDER BY sent_at DESC LIMIT 1`,
        [journey.id]
      );
      if (fedBack) {
        throw new AppError(
          409,
          `This sale has been fed back to ${fedBack.adviser_name}` +
            (fedBack.confirmed_at ? ', and they confirmed receipt' : '') +
            '. Re-scoring would change the findings they were told about, after they were told. ' +
            'Ask CallGuard support if this sale genuinely needs re-scoring.'
        );
      }
    }

    if (!isSuperadmin && journey.status === 'scored') {
      const unchanged = await queryOne<{ unchanged: boolean }>(
        `SELECT
           (SELECT count(*) FROM journey_calls jc WHERE jc.journey_id = j.id) = r.calls_scored
           AND j.scorecard_version = s.version
           -- Re-transcribing a call changes the evidence without changing the
           -- call count or the scorecard, so compare against when each linked
           -- call was last touched. Without this the guard would block the one
           -- re-score that is always justified: the transcript was corrected.
           AND NOT EXISTS (
             SELECT 1 FROM journey_calls jc2
               JOIN calls c ON c.id = jc2.call_id
              WHERE jc2.journey_id = j.id AND c.updated_at > r.created_at
           ) AS unchanged
         FROM journeys j
         JOIN scorecards s ON s.id = j.scorecard_id
         JOIN journey_score_runs r ON r.journey_id = j.id
        WHERE j.id = $1
        ORDER BY r.run_number DESC
        LIMIT 1`,
        [journey.id]
      );
      if (unchanged?.unchanged) {
        throw new AppError(
          409,
          'This sale is already scored on the evidence available. Nothing has changed since the last ' +
            'run — no new calls, no corrected transcripts and no scorecard edits — so re-scoring would ' +
            'only re-run the AI on identical input. Add a call, correct a transcript or amend the ' +
            'scorecard if the result needs to change.'
        );
      }
    }

    await query(
      "UPDATE journeys SET status = 'scoring', updated_at = now() WHERE id = $1",
      [journey.id]
    );

    // Audit the request, not the result. Scoring is async and can still fail,
    // so this records that a named admin asked for the sale to be re-scored and
    // what the score was at that moment. The resulting number lands in
    // journey_score_runs (migration 074) when the job completes.
    //
    // This exists because a compliance score changing with no attributable
    // cause is indefensible to a regulated firm — the score itself moving is
    // expected (LLM scoring is not deterministic), being unable to say who
    // caused it is not.
    await recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'journey.rescore',
      entityType: 'journey',
      entityId: journey.id,
      summary:
        journey.overall_score == null
          ? 'Re-score requested (sale had no score)'
          : `Re-score requested (score at request: ${Number(journey.overall_score).toFixed(2)}%)`,
      metadata: {
        previous_score: journey.overall_score == null ? null : Number(journey.overall_score),
        previous_status: journey.status,
      },
      req,
    });

    const { scoringQueue } = await import('../jobs/queue.js');
    await scoringQueue.add(
      'score-journey',
      { journeyId: journey.id, rescoredBy: req.user!.userId },
      { jobId: `rescore-journey-${journey.id}-${Date.now()}` }
    );

    res.json({ message: 'Re-scoring initiated' });
  } catch (err) {
    next(err);
  }
});

// POST /api/journeys/:id/exemplar — mark/unmark a sale as a firm exemplar
// ("what good looks like"). The sales_only counterpart to POST /calls/:id/
// exemplar: getLearningContext feeds a marked sale's combined transcript into
// the scoring prompt. Takes effect on the next scoring run, not retroactively.
journeysRouter.post('/:id/exemplar', requireActioner, async (req, res, next) => {
  try {
    const { is_exemplar, reason } = req.body as { is_exemplar?: unknown; reason?: string };
    if (typeof is_exemplar !== 'boolean') {
      throw new AppError(400, 'is_exemplar must be boolean');
    }

    const result = await queryOne<{ id: string }>(
      `UPDATE journeys SET
         is_exemplar = $1,
         exemplar_reason = CASE WHEN $1 THEN $2 ELSE NULL END,
         updated_at = now()
       WHERE id = $3 AND organization_id = $4
       RETURNING id`,
      [is_exemplar, reason || 'Manually marked by admin', req.params.id, req.user!.organizationId]
    );
    if (!result) throw new AppError(404, 'Sale not found');

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'exemplar.toggle',
      entityType: 'journey',
      entityId: req.params.id,
      summary: is_exemplar
        ? `Marked sale ${req.params.id} as exemplar`
        : `Removed exemplar flag from sale ${req.params.id}`,
      metadata: { is_exemplar, reason: reason || null },
      req,
    });

    res.json({ message: 'Exemplar flag updated' });
  } catch (err) {
    next(err);
  }
});

// POST /api/journeys/:id/scores/items/:itemScoreId/correct — override a scored
// checkpoint's pass/fail on a SALE. The sales_only counterpart to the per-call
// correct endpoint: it records a calibration row (score_corrections), flips the
// item, recomputes the sale's overall + breach, and re-pushes the corrected
// score to the CRM. This is what gives sales the same human-control + AI
// learning loop calls have.
journeysRouter.post('/:id/scores/items/:itemScoreId/correct', requireActioner, async (req, res, next) => {
  try {
    const { corrected_pass, reason } = req.body as { corrected_pass?: unknown; reason?: string };
    if (typeof corrected_pass !== 'boolean') {
      throw new AppError(400, 'corrected_pass must be boolean');
    }

    const orgId = req.user!.organizationId;
    const journey = await queryOne<{ id: string }>(
      'SELECT id FROM journeys WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    );
    if (!journey) throw new AppError(404, 'Sale not found');

    const itemScore = await queryOne<{
      id: string;
      scorecard_item_id: string;
      normalized_score: number | null;
      evidence: string | null;
      weight: string;
      severity: string | null;
    }>(
      `SELECT jis.id, jis.scorecard_item_id, jis.normalized_score, jis.evidence,
              si.weight::text AS weight, si.severity
         FROM journey_item_scores jis
         JOIN scorecard_items si ON si.id = jis.scorecard_item_id
        WHERE jis.id = $1 AND jis.journey_id = $2`,
      [req.params.itemScoreId, journey.id]
    );
    if (!itemScore) throw new AppError(404, 'Checkpoint not found on this sale');

    const settings = await getScoringSettings(orgId);
    const correctedNormalized = corrected_pass ? 100 : 0;
    const correctedRawScore = corrected_pass ? 1 : 0;
    const originalPass =
      itemScore.normalized_score != null ? isItemPass(Number(itemScore.normalized_score), settings.passThreshold) : null;
    const severity = deriveSeverity(Number(itemScore.weight), itemScore.severity);

    // Record the calibration example (upsert, one per journey item) and apply
    // the correction to the item, then recompute + reconcile the breach.
    await query(
      `INSERT INTO score_corrections
         (organization_id, journey_id, journey_item_score_id, scorecard_item_id, corrected_by,
          original_score, corrected_score, original_pass, corrected_pass, reason, transcript_excerpt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       -- Keyed on (journey, checkpoint), not the item-score row: that row is
       -- dropped and recreated on every scoring run, so keying the ruling to it
       -- is what let a re-score cascade-delete it (migration 077).
       ON CONFLICT (journey_id, scorecard_item_id) WHERE journey_id IS NOT NULL
       DO UPDATE SET
         journey_item_score_id = EXCLUDED.journey_item_score_id,
         corrected_score = EXCLUDED.corrected_score,
         corrected_pass = EXCLUDED.corrected_pass,
         reason = EXCLUDED.reason,
         corrected_by = EXCLUDED.corrected_by,
         created_at = now()`,
      [
        orgId,
        journey.id,
        itemScore.id,
        itemScore.scorecard_item_id,
        req.user!.userId,
        itemScore.normalized_score ?? 0,
        correctedNormalized,
        originalPass,
        corrected_pass,
        reason || null,
        itemScore.evidence,
      ]
    );

    await query(
      "UPDATE journey_item_scores SET result = $2, score = $3, normalized_score = $4 WHERE id = $1",
      [itemScore.id, corrected_pass ? 'pass' : 'fail', correctedRawScore, correctedNormalized]
    );

    // Recompute the sale's overall over pass/fail items only (na / manual_review
    // carry no numeric score), mirroring the per-call correction path.
    const items = await query<{ normalized_score: string; weight: string; severity: string | null }>(
      `SELECT jis.normalized_score::text, si.weight::text, si.severity
         FROM journey_item_scores jis
         JOIN scorecard_items si ON si.id = jis.scorecard_item_id
        WHERE jis.journey_id = $1 AND jis.result IN ('pass', 'fail')`,
      [journey.id]
    );
    let totalWeighted = 0;
    let totalWeight = 0;
    const failing: BreachSeverity[] = [];
    for (const it of items) {
      const w = Number(it.weight);
      const n = Number(it.normalized_score);
      totalWeighted += n * w;
      totalWeight += w;
      if (!isItemPass(n, settings.passThreshold)) failing.push(deriveSeverity(w, it.severity));
    }
    const newOverall = totalWeight > 0 ? totalWeighted / totalWeight : 0;
    const newPass = callPasses(newOverall, failing, settings.passThreshold);

    await query('UPDATE journeys SET overall_score = $1, pass = $2, updated_at = now() WHERE id = $3', [
      newOverall,
      newPass,
      journey.id,
    ]);

    if (corrected_pass) {
      await query('DELETE FROM breaches WHERE journey_item_score_id = $1', [itemScore.id]);
    } else {
      await query(
        `INSERT INTO breaches (organization_id, journey_id, journey_item_score_id, scorecard_item_id, severity, detected_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (journey_item_score_id) DO NOTHING`,
        [orgId, journey.id, itemScore.id, itemScore.scorecard_item_id, severity]
      );
    }

    void recordAuditEvent({
      organizationId: orgId,
      userId: req.user!.userId,
      actionType: 'score.correct',
      entityType: 'score',
      entityId: req.params.itemScoreId,
      summary: `Corrected checkpoint ${req.params.itemScoreId} on sale ${journey.id} to ${corrected_pass ? 'pass' : 'fail'}`,
      metadata: { journey_id: journey.id, corrected_pass, reason: reason || null, new_overall: newOverall, new_pass: newPass },
      req,
    });

    // Push the corrected score downstream (webhook + Zoho), after the writes.
    void pushJourneyScoreUpdate(orgId, journey.id);

    // A verdict corrected to a fail is a failure the firm may never have been
    // told about — the AI passed it, so no rule ever matched. Evaluate the
    // rules for this checkpoint now. A correction back to pass matches nothing,
    // and a checkpoint already alerted on is not announced twice (migration
    // 117). Fire-and-forget, after the writes.
    void evaluateAlertsForResolvedItem({
      kind: 'journey',
      entityId: journey.id,
      scorecardItemId: itemScore.scorecard_item_id,
    });

    res.json({ message: 'Correction saved', overall_score: newOverall, pass: newPass });
  } catch (err) {
    next(err);
  }
});

// ── Case-level notes (CG-9) ───────────────────────────────────────────────────
//
// A free-text note about the sale as a whole, rather than a ruling on any one
// checkpoint. See migration 112 for why this is evidence and not a UI comfort,
// and for the two rules the endpoints below enforce: every superseded version
// is kept, and there is no delete.

const NOTE_MAX_LENGTH = 5000;

// Load one note with its full history. Shared by the write endpoints so a
// caller always gets the same shape back that GET returns, rather than having
// to re-fetch to see what it just wrote.
// Who wrote the version an edit is about to supersede, and when they wrote it.
//
// Not the note's original author, except on the first edit. Once a second
// person has amended a note, the text now being replaced is THEIRS — attributing
// it to whoever opened the note would put words in the original author's mouth,
// which is precisely the misattribution the retained history exists to prevent.
// Exported for its own test: the two-editor case is the one that goes wrong,
// and it is invisible until a second person edits a note in production.
export function supersededVersionAuthor(note: {
  author_name: string;
  created_at: string;
  edited_by_name: string | null;
  edited_at: string | null;
}): { author_name: string; written_at: string } {
  return {
    author_name: note.edited_by_name || note.author_name,
    written_at: note.edited_at || note.created_at,
  };
}

async function loadNote(noteId: string): Promise<JourneyNote> {
  const note = await queryOne<{
    id: string;
    body: string;
    author_name: string;
    created_at: string;
    edited_by_name: string | null;
    edited_at: string | null;
  }>(
    `SELECT id, body, author_name, created_at, edited_by_name, edited_at
       FROM journey_notes WHERE id = $1`,
    [noteId]
  );
  if (!note) throw new AppError(404, 'Note not found');

  const revisions = await query<JourneyNoteRevision>(
    `SELECT id, body, author_name, written_at, superseded_at, superseded_by_name
       FROM journey_note_revisions
      WHERE note_id = $1
      ORDER BY superseded_at ASC`,
    [noteId]
  );
  return { ...note, revisions };
}

// Resolve the sale and confirm it belongs to the caller's org. 404 rather than
// 403 on someone else's sale, matching GET /:id — a probing request must not be
// able to tell "not yours" from "does not exist".
async function requireOwnJourney(journeyId: string, organizationId: string): Promise<string> {
  const journey = await queryOne<{ id: string }>(
    'SELECT id FROM journeys WHERE id = $1 AND organization_id = $2',
    [journeyId, organizationId]
  );
  if (!journey) throw new AppError(404, 'Sale not found');
  return journey.id;
}

// GET /api/journeys/:id/notes — every note on the sale, oldest first, each with
// its full edit history.
journeysRouter.get('/:id/notes', requireOrgView, async (req, res, next) => {
  try {
    await requireOwnJourney(String(req.params.id), req.user!.organizationId);

    const notes = await query<{ id: string }>(
      'SELECT id FROM journey_notes WHERE journey_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ notes: await Promise.all(notes.map((n) => loadNote(n.id))) });
  } catch (err) {
    next(err);
  }
});

// POST /api/journeys/:id/notes — add a note. Body: { body }.
journeysRouter.post('/:id/notes', requireActioner, async (req, res, next) => {
  try {
    // Validated before the sale is looked up: a malformed request does not
    // deserve a database round trip, and answering it costs nothing away —
    // probing whether a sale exists needs a well-formed body, which still 404s.
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) throw new AppError(400, 'body is required');
    if (body.length > NOTE_MAX_LENGTH) {
      throw new AppError(400, `body must be ${NOTE_MAX_LENGTH} characters or fewer`);
    }

    const journeyId = await requireOwnJourney(String(req.params.id), req.user!.organizationId);

    // Attribution is snapshotted at write time, not joined on read — see
    // migration 112. Falling back to the email keeps author_name honest if a
    // user somehow has no name set, since the column cannot be null.
    const author = await queryOne<{ name: string | null; email: string | null }>(
      'SELECT name, email FROM users WHERE id = $1',
      [req.user!.userId]
    );
    const authorName = author?.name || author?.email || 'Unknown user';

    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO journey_notes (organization_id, journey_id, body, author_user_id, author_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [req.user!.organizationId, journeyId, body, req.user!.userId, authorName]
    );

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'journey.note.add',
      entityType: 'journey',
      entityId: journeyId,
      summary: `Added a note to sale ${journeyId}`,
      // The note text is deliberately not copied into the audit metadata: it
      // lives in journey_notes with its own retained history, and duplicating
      // free text a user may later correct would leave an uncorrectable second
      // copy behind.
      metadata: { note_id: inserted!.id },
      req,
    });

    res.status(201).json({ note: await loadNote(inserted!.id) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/journeys/:id/notes/:noteId — amend a note. Body: { body }.
//
// The previous text is copied into journey_note_revisions in the same
// transaction as the update, so there is no window in which a note has been
// rewritten but its earlier version was never recorded.
//
// There is no DELETE counterpart, deliberately — see migration 112.
journeysRouter.patch('/:id/notes/:noteId', requireActioner, async (req, res, next) => {
  try {
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) throw new AppError(400, 'body is required');
    if (body.length > NOTE_MAX_LENGTH) {
      throw new AppError(400, `body must be ${NOTE_MAX_LENGTH} characters or fewer`);
    }

    const journeyId = await requireOwnJourney(String(req.params.id), req.user!.organizationId);
    const noteId = String(req.params.noteId);

    const editor = await queryOne<{ name: string | null; email: string | null }>(
      'SELECT name, email FROM users WHERE id = $1',
      [req.user!.userId]
    );
    const editorName = editor?.name || editor?.email || 'Unknown user';

    const unchanged = await withTransaction(async (tx) => {
      // Locked for the duration: two supervisors amending the same note at once
      // would otherwise both read the same "previous" text, and the second
      // commit would file a revision that had already been superseded.
      const [existing] = await tx.query<{
        id: string;
        body: string;
        author_name: string;
        created_at: string;
        edited_by_name: string | null;
        edited_at: string | null;
      }>(
        `SELECT id, body, author_name, created_at, edited_by_name, edited_at
           FROM journey_notes
          WHERE id = $1 AND journey_id = $2
          FOR UPDATE`,
        [noteId, journeyId]
      );
      if (!existing) throw new AppError(404, 'Note not found');

      // A no-op save must not manufacture a revision: an edit history full of
      // entries where nothing changed makes the real amendments harder to find,
      // and misrepresents how often the note was actually reworded.
      if (existing.body === body) return true;

      const superseded = supersededVersionAuthor(existing);
      await tx.query(
        `INSERT INTO journey_note_revisions
           (note_id, body, author_name, written_at, superseded_by_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [existing.id, existing.body, superseded.author_name, superseded.written_at, editorName]
      );

      await tx.query(
        `UPDATE journey_notes
            SET body = $1, edited_by_user_id = $2, edited_by_name = $3, edited_at = now()
          WHERE id = $4`,
        [body, req.user!.userId, editorName, existing.id]
      );
      return false;
    });

    if (!unchanged) {
      void recordAuditEvent({
        organizationId: req.user!.organizationId,
        userId: req.user!.userId,
        actionType: 'journey.note.edit',
        entityType: 'journey',
        entityId: journeyId,
        summary: `Edited a note on sale ${journeyId}`,
        metadata: { note_id: noteId },
        req,
      });
    }

    res.json({ note: await loadNote(noteId) });
  } catch (err) {
    next(err);
  }
});
