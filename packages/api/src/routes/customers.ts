import { Router } from 'express';
import { authenticate, requireOrgView, requireAdmin, requireActioner } from '../middleware/auth.js';
import { query, queryOne, withTransaction } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { normalizePhone } from '../services/ingestion.js';
import { recordAuditEvent } from '../services/audit.js';
import { getScoringSettings, scoresCallsIndividually, orgHasFeature } from '../services/tenant-settings.js';
import { isReconciliationEnabled } from '../services/reconciliation-runs.js';
import {
  identityCustomerIds,
  resolveJourneyWindow,
  gatherJourneyCalls,
  findInFlightJourney,
  scoredJourneyCoveringCalls,
} from '../services/journey.js';
import { isUuid } from '../services/uuid.js';
import {
  FEEDBACK_STATUS_SQL,
  FEEDBACK_SENT_AT_SQL,
  OLDEST_REMEDIATION_DAYS_SQL,
  feedbackStatusSql,
  feedbackSentAtSql,
} from '../db/feedback-status.js';
import { SALE_DATE_SQL } from './journeys.js';
import {
  hasFeature,
  effectivePlan,
  CUSTOMER_SALES_TABS,
  CUSTOMER_CALLS_TABS,
  CUSTOMER_LIST_SORTS,
} from '@callguard/shared';
import type {
  Plan,
  CallStatus,
  FeedbackStatus,
  JourneyStatus,
  ReconciliationRunStatus,
  SeverityCounts,
  CustomerCall,
  CustomerCallStats,
  CustomerCompliance,
  CustomerListResponse,
  CustomerListRow,
  CustomerListSort,
  CustomerListTab,
  CustomerProfileResponse,
  CustomerRecord,
  CustomerSale,
  CustomerSaleCall,
  CustomerSalePreview,
  CustomerSalePreviewCall,
  CustomerScoringMode,
} from '@callguard/shared';

export const customersRouter = Router();

customersRouter.use(authenticate);

// Guard: verify the user's effective plan (org plan, bumped by any per-user
// override) has the customer_journey feature enabled.
customersRouter.use(async (req, _res, next) => {
  try {
    const row = await queryOne<{ org_plan: string; plan_override: string | null }>(
      `SELECT o.plan AS org_plan, u.plan_override
         FROM organizations o
         JOIN users u ON u.id = $2
        WHERE o.id = $1`,
      [req.user!.organizationId, req.user!.userId]
    );
    const plan = row ? effectivePlan(row.org_plan as Plan, row.plan_override as Plan | null) : null;
    if (!hasFeature(plan, 'customer_journey')) {
      throw new AppError(403, 'Customer journey is not available on your current plan');
    }
    next();
  } catch (err) {
    next(err);
  }
});

// A breach still being worked: any status but resolved or noted, the definition
// routes/breaches.ts uses. Fixed SQL over the alias `b`.
const OPEN_BREACH = `b.status NOT IN ('resolved', 'noted')`;
const CLOSED_BREACH = `b.status IN ('resolved', 'noted')`;

/** COUNT(*) FILTER per severity for a breach predicate, as `<prefix>_<severity>` columns. */
function severityCountColumns(predicate: string, prefix: string): string {
  return (['critical', 'high', 'medium', 'low'] as const)
    .map((s) => `COUNT(b.id) FILTER (WHERE ${predicate} AND b.severity = '${s}')::int AS ${prefix}_${s}`)
    .join(',\n       ');
}

function severityCounts(row: Record<string, unknown>, prefix: string): SeverityCounts {
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return {
    critical: n(row[`${prefix}_critical`]),
    high: n(row[`${prefix}_high`]),
    medium: n(row[`${prefix}_medium`]),
    low: n(row[`${prefix}_low`]),
  };
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// ── List customers ────────────────────────────────────────────────────────────
//
// GET /api/customers?tab=&q=&sort=&page=&limit=
//
// Who each person is and what came of their calls, shaped by the firm's scoring
// setting (scoresCallsIndividually) rather than by any CRM integration. Two data
// queries whatever the page size: the tab counts (one COUNT … FILTER per tab)
// and the page itself. Everything a row shows is joined from per-customer
// aggregates computed once in the same statement — never a query per row, and
// never a transcript column.
//
// Advisers see only customers from their own calls, with their own call counts,
// and no results, findings or feedback: those are the firm's assessment across
// every adviser's calls. Their only tab is 'all'.

// Per-customer facts, as CTEs. `$1` is always the organisation. Each is fixed
// SQL; `adviserParam` is a placeholder index from code, never input.
function callStatsCte(adviserParam: number | null): string {
  return `call_stats AS (
    SELECT ca.customer_id,
           COUNT(*)::int AS call_count,
           MAX(COALESCE(ca.call_date, ca.created_at)) AS last_call_at
      FROM calls ca
     WHERE ca.organization_id = $1
       AND ca.customer_id IS NOT NULL
       AND ca.status <> 'failed'
       ${adviserParam ? `AND ca.agent_id = $${adviserParam}` : ''}
     GROUP BY ca.customer_id
  )`;
}

// Open breaches by customer, over both kinds: exactly one of call_id and
// journey_id is set on a breach, so COALESCE names the customer either way.
const OPEN_FINDINGS_CTE = `open_findings AS (
    SELECT COALESCE(bj.customer_id, bc.customer_id) AS customer_id,
           ${severityCountColumns('TRUE', 'open')}
      FROM breaches b
      LEFT JOIN journeys bj ON bj.id = b.journey_id
      LEFT JOIN calls bc ON bc.id = b.call_id
     WHERE b.organization_id = $1 AND ${OPEN_BREACH}
     GROUP BY 1
  )`;

// A firm that scores sales: each customer's latest sale in any status, and
// their latest scored sale with its feedback state. "Latest" is by when the sale
// happened (SALE_DATE_SQL), the order the sales list uses. The feedback state is
// computed only for the winning sale per customer, not every sale.
const LATEST_SALE_CTES = `latest_sale AS (
    SELECT DISTINCT ON (j.customer_id)
           j.customer_id, j.id, j.status, j.overall_score, j.pass, ${SALE_DATE_SQL} AS result_date
      FROM journeys j
     WHERE j.organization_id = $1
     ORDER BY j.customer_id, ${SALE_DATE_SQL} DESC, j.created_at DESC
  ),
  latest_scored_sale AS (
    SELECT w.customer_id, w.id, ${FEEDBACK_STATUS_SQL} AS feedback_status
      FROM (
        SELECT DISTINCT ON (j.customer_id) j.customer_id, j.id
          FROM journeys j
         WHERE j.organization_id = $1 AND j.status = 'scored'
         ORDER BY j.customer_id, ${SALE_DATE_SQL} DESC, j.created_at DESC
      ) w
      JOIN journeys j ON j.id = w.id
  )`;

// A firm that scores calls: each customer's latest scored call, its latest score,
// and — only where the call is not part of a sale, the only calls fed back on
// their own (routes/journey-feedback.ts) — its feedback state.
const LATEST_CALL_CTE = `latest_call AS (
    SELECT w.customer_id, w.id, w.result_date, sc.overall_score, sc.pass,
           CASE WHEN w.in_sale THEN NULL ELSE ${feedbackStatusSql('call_id', 'w.id')} END AS feedback_status
      FROM (
        SELECT DISTINCT ON (c.customer_id)
               c.customer_id, c.id, COALESCE(c.call_date, c.created_at) AS result_date,
               (c.journey_id IS NOT NULL
                OR EXISTS (SELECT 1 FROM journey_calls ljc WHERE ljc.call_id = c.id)) AS in_sale
          FROM calls c
         WHERE c.organization_id = $1
           AND c.customer_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM call_scores lcs WHERE lcs.call_id = c.id)
         ORDER BY c.customer_id, COALESCE(c.call_date, c.created_at) DESC, c.id DESC
      ) w
      LEFT JOIN LATERAL (
        SELECT cs.overall_score, cs.pass FROM call_scores cs
         WHERE cs.call_id = w.id
         ORDER BY cs.scored_at DESC
         LIMIT 1
      ) sc ON true
  )`;

/** The tab predicates, over the joined facts. Fixed SQL, safe to interpolate. */
export function customerTabSql(mode: CustomerScoringMode, tab: CustomerListTab): string {
  if (mode === 'sales') {
    switch (tab) {
      case 'scored':
        return 'lss.id IS NOT NULL';
      case 'open_findings':
        return 'ofd.customer_id IS NOT NULL';
      case 'not_fed_back':
        return `lss.feedback_status = 'not_fed_back'`;
      case 'no_sale':
        return 'ls.id IS NULL';
      default:
        return 'TRUE';
    }
  }
  switch (tab) {
    case 'assessed':
      return 'lc.id IS NOT NULL';
    case 'open_findings':
      return 'ofd.customer_id IS NOT NULL';
    case 'not_fed_back':
      return `lc.feedback_status = 'not_fed_back'`;
    case 'not_assessed':
      return 'lc.id IS NULL';
    default:
      return 'TRUE';
  }
}

function sortSql(sort: CustomerListSort): string {
  switch (sort) {
    case 'most_calls':
      return 'call_count DESC, last_call_at DESC NULLS LAST, id';
    case 'lowest_score':
      // Customers with no score yet go last: "lowest" means lowest of the
      // scored, not "unscored first".
      return 'sort_score ASC NULLS LAST, last_call_at DESC NULLS LAST, id';
    default:
      return 'last_call_at DESC NULLS LAST, last_seen_at DESC, id';
  }
}

interface ListQueryRow {
  id: string;
  name: string | null;
  phone_normalized: string;
  external_crm_id: string | null;
  call_count: number;
  last_call_at: string | null;
  last_adviser_name: string | null;
  latest_id: string | null;
  latest_status: JourneyStatus | null;
  latest_score: string | null;
  latest_pass: boolean | null;
  latest_date: string | null;
  feedback_status: FeedbackStatus | null;
  has_open: boolean | null;
  open_critical: number | null;
  open_high: number | null;
  open_medium: number | null;
  open_low: number | null;
}

customersRouter.get('/', async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const isAdviser = req.user!.role === 'adviser';

    const settings = await getScoringSettings(orgId);
    const mode: CustomerScoringMode = scoresCallsIndividually(settings) ? 'calls' : 'sales';

    let page = parseInt(String(req.query.page ?? ''), 10) || 1;
    if (page < 1) page = 1;
    let limit = parseInt(String(req.query.limit ?? ''), 10) || 50;
    limit = Math.min(Math.max(limit, 1), 100);
    const offset = (page - 1) * limit;

    const sortParam = typeof req.query.sort === 'string' && req.query.sort ? req.query.sort : 'last_contact';
    if (!(CUSTOMER_LIST_SORTS as readonly string[]).includes(sortParam)) {
      throw new AppError(400, `sort must be one of ${CUSTOMER_LIST_SORTS.join(', ')}.`);
    }
    const sort = sortParam as CustomerListSort;

    const tabs: CustomerListTab[] = isAdviser
      ? ['all']
      : [...(mode === 'sales' ? CUSTOMER_SALES_TABS : CUSTOMER_CALLS_TABS)];
    const tabParam = typeof req.query.tab === 'string' && req.query.tab ? req.query.tab : 'all';
    if (!(tabs as string[]).includes(tabParam)) {
      throw new AppError(400, `tab must be one of ${tabs.join(', ')}.`);
    }
    const tab = tabParam as CustomerListTab;

    const params: unknown[] = [orgId];
    const conditions: string[] = ['cust.organization_id = $1'];

    let adviserParam: number | null = null;
    if (isAdviser) {
      adviserParam = params.push(req.user!.userId);
      conditions.push(`EXISTS (
        SELECT 1 FROM calls ac
         WHERE ac.customer_id = cust.id AND ac.organization_id = $1 AND ac.agent_id = $${adviserParam}
      )`);
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length > 100) throw new AppError(400, 'q must be at most 100 characters.');
    if (q) {
      // Escaped for ILIKE's own wildcards: a search for "50%" or a stray "_"
      // must match itself rather than act as a wildcard.
      const likeSafe = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);
      // Phone-ish input ("07700 900123", "+44 7700…") is normalised to match
      // the stored E.164 form — a raw ILIKE on "07700" would never match
      // "+447700…". A bare run of digits also matches anywhere in the number,
      // so the middle of a number finds it too.
      const phoneish = /^\+?\d[\d\s()-]*$/.test(q);
      const digits = q.replace(/\D/g, '');
      const phoneSearch = phoneish ? (normalizePhone(q.replace(/[\s()-]/g, '')) ?? digits) : q;
      const text = params.push(`%${likeSafe(q)}%`);
      const phone = params.push(`%${likeSafe(phoneSearch)}%`);
      const parts = [
        `cust.name ILIKE $${text} ESCAPE '\\'`,
        `cust.external_crm_id ILIKE $${text} ESCAPE '\\'`,
        `cust.phone_normalized ILIKE $${phone} ESCAPE '\\'`,
      ];
      if (phoneish && digits.length >= 3) {
        const bare = params.push(`%${digits}%`);
        parts.push(`REGEXP_REPLACE(cust.phone_normalized, '\\D', '', 'g') LIKE $${bare}`);
      }
      conditions.push(`(${parts.join(' OR ')})`);
    }
    const where = conditions.join(' AND ');

    const ctes = isAdviser
      ? callStatsCte(adviserParam)
      : [callStatsCte(null), OPEN_FINDINGS_CTE, mode === 'sales' ? LATEST_SALE_CTES : LATEST_CALL_CTE].join(',\n  ');
    const joins = isAdviser
      ? 'LEFT JOIN call_stats cst ON cst.customer_id = cust.id'
      : `LEFT JOIN call_stats cst ON cst.customer_id = cust.id
         LEFT JOIN open_findings ofd ON ofd.customer_id = cust.id
         ${
           mode === 'sales'
             ? `LEFT JOIN latest_sale ls ON ls.customer_id = cust.id
                LEFT JOIN latest_scored_sale lss ON lss.customer_id = cust.id`
             : 'LEFT JOIN latest_call lc ON lc.customer_id = cust.id'
         }`;

    const countRow = await queryOne<Record<string, number>>(
      `WITH ${ctes}
       SELECT ${tabs.map((t) => `COUNT(*) FILTER (WHERE ${customerTabSql(mode, t)})::int AS ${t}`).join(', ')}
         FROM customers cust
         ${joins}
        WHERE ${where}`,
      params
    );
    const counts: Partial<Record<CustomerListTab, number>> = {};
    for (const t of tabs) counts[t] = Number(countRow?.[t] ?? 0);

    const latestAlias = mode === 'sales' ? 'ls' : 'lc';
    const resultColumns = isAdviser
      ? `NULL::uuid AS latest_id, NULL::text AS latest_status, NULL::numeric AS latest_score,
         NULL::boolean AS latest_pass, NULL::timestamptz AS latest_date, NULL::text AS feedback_status,
         NULL::boolean AS has_open, NULL::int AS open_critical, NULL::int AS open_high,
         NULL::int AS open_medium, NULL::int AS open_low`
      : `${latestAlias}.id AS latest_id,
         ${mode === 'sales' ? 'ls.status' : `CASE WHEN lc.id IS NOT NULL THEN 'scored' END`} AS latest_status,
         ${latestAlias}.overall_score AS latest_score,
         ${latestAlias}.pass AS latest_pass,
         ${latestAlias}.result_date AS latest_date,
         ${mode === 'sales' ? 'lss' : 'lc'}.feedback_status AS feedback_status,
         (ofd.customer_id IS NOT NULL) AS has_open,
         ofd.open_critical, ofd.open_high, ofd.open_medium, ofd.open_low`;

    // The page: filtered, sorted and cut to size first, and only then the last
    // adviser looked up — for these rows alone.
    const rows = await query<ListQueryRow>(
      `WITH ${ctes},
       page AS (
         SELECT cust.id, cust.name, cust.phone_normalized, cust.external_crm_id, cust.last_seen_at,
                COALESCE(cst.call_count, 0) AS call_count,
                cst.last_call_at,
                ${isAdviser ? 'NULL::numeric' : `${latestAlias}.overall_score`} AS sort_score,
                ${resultColumns}
           FROM customers cust
           ${joins}
          WHERE ${where} AND (${customerTabSql(mode, tab)})
          ORDER BY ${sortSql(sort)}
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
       )
       SELECT page.*, la.adviser_name AS last_adviser_name
         FROM page
         LEFT JOIN LATERAL (
           SELECT COALESCE(lu.name, lac.agent_name) AS adviser_name
             FROM calls lac
             LEFT JOIN users lu ON lu.id = lac.agent_id
            WHERE lac.customer_id = page.id
              AND lac.organization_id = $1
              AND lac.status <> 'failed'
              ${adviserParam ? `AND lac.agent_id = $${adviserParam}` : ''}
            ORDER BY COALESCE(lac.call_date, lac.created_at) DESC
            LIMIT 1
         ) la ON true
        ORDER BY ${sortSql(sort)}`,
      [...params, limit, offset]
    );

    const scoreOnly = !isAdviser && (await orgHasFeature(orgId, 'score_only'));

    const data: CustomerListRow[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      phone_normalized: r.phone_normalized,
      external_crm_id: r.external_crm_id,
      call_count: Number(r.call_count) || 0,
      last_call_at: r.last_call_at,
      last_adviser_name: r.last_adviser_name,
      latest:
        !isAdviser && r.latest_id && r.latest_date
          ? {
              kind: mode === 'sales' ? 'sale' : 'call',
              id: r.latest_id,
              status: (r.latest_status ?? 'scored') as JourneyStatus,
              overall_score: numOrNull(r.latest_score),
              // score_only never ships the verdict, only the number.
              pass: scoreOnly ? null : r.latest_pass,
              date: r.latest_date,
            }
          : null,
      open_findings: isAdviser
        ? null
        : severityCounts(r as unknown as Record<string, unknown>, 'open'),
      feedback_status: isAdviser ? null : r.feedback_status,
    }));

    const response: CustomerListResponse = {
      data,
      total: counts[tab] ?? 0,
      page,
      limit,
      mode,
      sort,
      tabs,
      counts,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

// ── Customer profile ──────────────────────────────────────────────────────────

interface ComplianceRow {
  scored_sales: number;
  scored_calls: number;
  [column: string]: unknown;
}

/**
 * Where one customer stands: how much about them has been scored, and their
 * breaches split into open and closed by severity. The page turns this into one
 * of three honest states (summariseCustomerCompliance in @callguard/shared) —
 * it used to read "Clean" for every customer with no breaches, which on a firm
 * where nine customers in ten have never had a sale scored was a claim about
 * people nobody had assessed.
 *
 * "Open" is any status but resolved or noted, the definition routes/breaches.ts
 * already uses. Per-call and sale breaches both count: exactly one of call_id
 * and journey_id is set on a breach.
 */
export async function loadCustomerCompliance(
  organizationId: string,
  customerId: string
): Promise<CustomerCompliance> {
  const row = await queryOne<ComplianceRow>(
    `SELECT
       (SELECT COUNT(*) FROM journeys sj
         WHERE sj.customer_id = $1 AND sj.organization_id = $2 AND sj.status = 'scored')::int AS scored_sales,
       (SELECT COUNT(*) FROM calls sc
         WHERE sc.customer_id = $1 AND sc.organization_id = $2
           AND EXISTS (SELECT 1 FROM call_scores cs WHERE cs.call_id = sc.id))::int AS scored_calls,
       ${severityCountColumns(OPEN_BREACH, 'open')},
       ${severityCountColumns(CLOSED_BREACH, 'closed')},
       COUNT(b.id) FILTER (WHERE b.status = 'resolved')::int AS resolved,
       COUNT(b.id) FILTER (WHERE b.status = 'noted')::int AS noted
     FROM breaches b
     LEFT JOIN calls c ON c.id = b.call_id
     LEFT JOIN journeys j ON j.id = b.journey_id
     WHERE b.organization_id = $2
       AND (c.customer_id = $1 OR j.customer_id = $1)`,
    [customerId, organizationId]
  );
  const r = (row ?? {}) as Record<string, unknown>;
  return {
    scored_sales: Number(r.scored_sales ?? 0) || 0,
    scored_calls: Number(r.scored_calls ?? 0) || 0,
    open: severityCounts(r, 'open'),
    closed: severityCounts(r, 'closed'),
    resolved: Number(r.resolved ?? 0) || 0,
    noted: Number(r.noted ?? 0) || 0,
  };
}

interface CallQueryRow {
  id: string;
  called_at: string;
  adviser_name: string | null;
  duration_seconds: string | number | null;
  status: CallStatus;
  in_sale: boolean;
  latest_score_id?: string | null;
  overall_score?: string | null;
  pass?: boolean | null;
  feedback_status?: FeedbackStatus | null;
  feedback_sent_at?: string | null;
  [column: string]: unknown;
}

interface SaleQueryRow {
  id: string;
  status: JourneyStatus;
  sale_date: string;
  scored_at: string | null;
  overall_score: string | null;
  pass: boolean | null;
  feedback_status: FeedbackStatus | null;
  feedback_sent_at: string | null;
  oldest_remediation_days: number | null;
  closing_adviser_name: string | null;
  adviser_count: number;
  reconciliation_status: ReconciliationRunStatus | null;
  [column: string]: unknown;
}

/** The header's figures, from the calls already loaded for the timeline. */
export function callStatsFrom(calls: Array<Pick<CustomerCall, 'called_at' | 'adviser_name'>>): CustomerCallStats {
  const times = calls.map((c) => new Date(c.called_at).getTime()).filter((t) => !Number.isNaN(t));
  const advisers = new Set(
    calls.map((c) => c.adviser_name?.trim().toLowerCase()).filter((n): n is string => Boolean(n))
  );
  return {
    call_count: calls.length,
    first_call_at: times.length ? new Date(Math.min(...times)).toISOString() : null,
    last_call_at: times.length ? new Date(Math.max(...times)).toISOString() : null,
    adviser_count: advisers.size,
  };
}

/**
 * What "Score calls as a sale" would do right now, asked the same way the
 * trigger itself asks it (services/journey.ts): the identity group, the window,
 * the call selection, the in-flight sale and the already-scored call set. A
 * manual trigger carries no CRM sale id, so the selection is every non-failed
 * call in the window — including calls already credited to an earlier sale,
 * which the preview marks so the confirmation can say so.
 */
async function loadSalePreview(organizationId: string, customerId: string): Promise<CustomerSalePreview> {
  const [customerIds, window, inFlight] = await Promise.all([
    identityCustomerIds(organizationId, customerId),
    resolveJourneyWindow(organizationId),
    findInFlightJourney(organizationId, customerId),
  ]);
  const rows = await gatherJourneyCalls<{
    id: string;
    called_at: string;
    adviser_name: string | null;
    duration_seconds: string | number | null;
    status: CallStatus;
    journey_id: string | null;
    customer_id: string;
  }>(
    organizationId,
    customerIds,
    window.windowStart,
    null,
    `id, COALESCE(call_date, created_at) AS called_at,
     COALESCE((SELECT pu.name FROM users pu WHERE pu.id = calls.agent_id), agent_name) AS adviser_name,
     duration_seconds, status, journey_id, customer_id`
  );
  const calls: CustomerSalePreviewCall[] = rows.map((r) => ({
    id: r.id,
    called_at: r.called_at,
    adviser_name: r.adviser_name,
    duration_seconds: numOrNull(r.duration_seconds),
    status: r.status,
    sale_id: r.journey_id,
    from_linked_number: r.customer_id !== customerId,
  }));
  const coveredBy = calls.length
    ? await scoredJourneyCoveringCalls(organizationId, customerId, calls.map((c) => c.id))
    : null;
  return {
    window_days: window.windowDays,
    calls,
    in_flight_sale_id: inFlight?.id ?? null,
    covered_by_sale_id: coveredBy,
  };
}

customersRouter.get('/:id', async (req, res, next) => {
  try {
    const orgId  = req.user!.organizationId;
    const role   = req.user!.role;
    const userId = req.user!.userId;
    const isAdviser = role === 'adviser';
    const canAction = role === 'admin' || role === 'supervisor';
    const customerId = String(req.params.id);
    if (!isUuid(customerId)) throw new AppError(404, 'Customer not found');

    const customer = await queryOne<CustomerRecord>(
      `SELECT c.id, c.phone_normalized, c.name, c.external_crm_id, c.first_seen_at, c.last_seen_at
         FROM customers c
        WHERE c.id = $1 AND c.organization_id = $2`,
      [customerId, orgId]
    );
    if (!customer) throw new AppError(404, 'Customer not found');

    // Advisers are restricted to customers from their own calls.
    if (isAdviser) {
      const linked = await queryOne<{ id: string }>(
        `SELECT id FROM calls
         WHERE customer_id = $1 AND organization_id = $2 AND agent_id = $3 LIMIT 1`,
        [customer.id, orgId, userId]
      );
      if (!linked) throw new AppError(403, 'Access denied');
    }

    const [settings, scoreOnly, reconciliationEnabled] = await Promise.all([
      getScoringSettings(orgId),
      orgHasFeature(orgId, 'score_only'),
      isReconciliationEnabled(orgId),
    ]);
    const mode: CustomerScoringMode = scoresCallsIndividually(settings) ? 'calls' : 'sales';
    // A call's own result, findings and feedback: only at a firm that scores
    // calls, and never for an adviser (see the note on the response below).
    const withCallResults = mode === 'calls' && !isAdviser;

    // Every non-failed call, newest first — failed calls are left out, as they
    // are from the call count and from a sale's call selection.
    const callRows = await query<CallQueryRow>(
      `SELECT ca.id,
              COALESCE(ca.call_date, ca.created_at) AS called_at,
              COALESCE(u.name, ca.agent_name) AS adviser_name,
              ca.duration_seconds,
              ca.status,
              (ca.journey_id IS NOT NULL
               OR EXISTS (SELECT 1 FROM journey_calls ijc WHERE ijc.call_id = ca.id)) AS in_sale
              ${
                withCallResults
                  ? `, sc.latest_score_id, sc.overall_score, sc.pass,
                     cb.open_critical, cb.open_high, cb.open_medium, cb.open_low,
                     cb.closed_critical, cb.closed_high, cb.closed_medium, cb.closed_low,
                     ${feedbackStatusSql('call_id', 'ca.id')} AS feedback_status,
                     ${feedbackSentAtSql('call_id', 'ca.id')} AS feedback_sent_at`
                  : ''
              }
         FROM calls ca
         LEFT JOIN users u ON u.id = ca.agent_id
         ${
           withCallResults
             ? `LEFT JOIN LATERAL (
                  SELECT cs.id AS latest_score_id, cs.overall_score, cs.pass
                    FROM call_scores cs
                   WHERE cs.call_id = ca.id
                   ORDER BY cs.scored_at DESC
                   LIMIT 1
                ) sc ON true
                LEFT JOIN LATERAL (
                  SELECT ${severityCountColumns(OPEN_BREACH, 'open')},
                         ${severityCountColumns(CLOSED_BREACH, 'closed')}
                    FROM breaches b
                   WHERE b.call_id = ca.id
                ) cb ON true`
             : ''
         }
        WHERE ca.customer_id = $1
          AND ca.organization_id = $2
          AND ca.status <> 'failed'
          ${isAdviser ? 'AND ca.agent_id = $3' : ''}
        ORDER BY COALESCE(ca.call_date, ca.created_at) DESC, ca.id DESC`,
      isAdviser ? [customer.id, orgId, userId] : [customer.id, orgId]
    );

    const calls: CustomerCall[] = callRows.map((r) => {
      const scored = withCallResults && Boolean(r.latest_score_id);
      // Fed back on its own only when scored and not part of a sale — a sale's
      // calls are fed back from the sale (routes/journey-feedback.ts).
      const ownFeedback = scored && !r.in_sale;
      return {
        id: r.id,
        called_at: r.called_at,
        adviser_name: r.adviser_name,
        duration_seconds: numOrNull(r.duration_seconds),
        status: r.status,
        in_sale: r.in_sale,
        score: scored
          ? { overall_score: numOrNull(r.overall_score), pass: scoreOnly ? null : (r.pass ?? null) }
          : null,
        open: withCallResults ? severityCounts(r, 'open') : null,
        closed: withCallResults ? severityCounts(r, 'closed') : null,
        feedback_status: ownFeedback ? (r.feedback_status ?? null) : null,
        feedback_sent_at: ownFeedback ? (r.feedback_sent_at ?? null) : null,
      };
    });

    let sales: CustomerSale[] | null = null;
    if (!isAdviser) {
      const saleRows = await query<SaleQueryRow>(
        `WITH sale_breaches AS (
           SELECT b.journey_id,
                  ${severityCountColumns(OPEN_BREACH, 'open')},
                  ${severityCountColumns(CLOSED_BREACH, 'closed')}
             FROM breaches b
             JOIN journeys bj ON bj.id = b.journey_id
            WHERE bj.customer_id = $1 AND b.organization_id = $2
            GROUP BY b.journey_id
         )
         SELECT j.id, j.status, ${SALE_DATE_SQL} AS sale_date, j.scored_at, j.overall_score, j.pass,
                CASE WHEN j.status = 'scored' THEN ${FEEDBACK_STATUS_SQL} END AS feedback_status,
                CASE WHEN j.status = 'scored' THEN ${FEEDBACK_SENT_AT_SQL} END AS feedback_sent_at,
                CASE WHEN j.status = 'scored' THEN ${OLDEST_REMEDIATION_DAYS_SQL} END AS oldest_remediation_days,
                ja.agent_name AS closing_adviser_name,
                (SELECT COUNT(DISTINCT lower(btrim(COALESCE(au.name, ac.agent_name))))::int
                   FROM journey_calls ajc
                   JOIN calls ac ON ac.id = ajc.call_id
                   LEFT JOIN users au ON au.id = ac.agent_id
                  WHERE ajc.journey_id = j.id
                    AND COALESCE(au.name, ac.agent_name) IS NOT NULL) AS adviser_count,
                sbr.open_critical, sbr.open_high, sbr.open_medium, sbr.open_low,
                sbr.closed_critical, sbr.closed_high, sbr.closed_medium, sbr.closed_low,
                ${
                  reconciliationEnabled
                    ? `(SELECT r.status FROM capture_reconciliation_runs r
                         WHERE r.journey_id = j.id AND r.organization_id = $2
                         ORDER BY r.created_at DESC LIMIT 1)`
                    : 'NULL::text'
                } AS reconciliation_status
           FROM journeys j
           LEFT JOIN sale_breaches sbr ON sbr.journey_id = j.id
           -- The sale's closing adviser, resolved as the sales list does
           -- (JOURNEY_AGENT_JOIN in routes/breaches.ts): earliest call flagged
           -- wrap_up, else the latest call in the set.
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
          WHERE j.customer_id = $1 AND j.organization_id = $2
          ORDER BY ${SALE_DATE_SQL} DESC, j.created_at DESC`,
        [customer.id, orgId]
      );

      // Every sale's calls in one query, not one per sale. A sale's calls can
      // include a linked number's calls (CG-8), which is why this reads
      // journey_calls rather than filtering the timeline above.
      const saleCallRows = saleRows.length
        ? await query<{
            journey_id: string;
            role: 'wrap_up' | 'context';
            id: string;
            called_at: string;
            adviser_name: string | null;
            duration_seconds: string | number | null;
            status: CallStatus;
          }>(
            `SELECT jc.journey_id, jc.role, sc.id,
                    COALESCE(sc.call_date, sc.created_at) AS called_at,
                    COALESCE(su.name, sc.agent_name) AS adviser_name,
                    sc.duration_seconds, sc.status
               FROM journey_calls jc
               JOIN calls sc ON sc.id = jc.call_id
               LEFT JOIN users su ON su.id = sc.agent_id
              WHERE jc.journey_id = ANY($1::uuid[]) AND sc.organization_id = $2
              ORDER BY COALESCE(sc.call_date, sc.created_at) ASC, sc.id ASC`,
            [saleRows.map((s) => s.id), orgId]
          )
        : [];
      const callsBySale = new Map<string, CustomerSaleCall[]>();
      for (const r of saleCallRows) {
        const list = callsBySale.get(r.journey_id) ?? [];
        list.push({
          id: r.id,
          called_at: r.called_at,
          adviser_name: r.adviser_name,
          duration_seconds: numOrNull(r.duration_seconds),
          status: r.status,
          role: r.role,
        });
        callsBySale.set(r.journey_id, list);
      }

      sales = saleRows.map((s) => ({
        id: s.id,
        status: s.status,
        sale_date: s.sale_date,
        scored_at: s.scored_at,
        overall_score: numOrNull(s.overall_score),
        pass: scoreOnly ? null : s.pass,
        feedback_status: s.feedback_status,
        feedback_sent_at: s.feedback_sent_at,
        oldest_remediation_days: numOrNull(s.oldest_remediation_days),
        closing_adviser_name: s.closing_adviser_name,
        adviser_count: Number(s.adviser_count) || 0,
        open: severityCounts(s, 'open'),
        closed: severityCounts(s, 'closed'),
        reconciliation_status: reconciliationEnabled ? s.reconciliation_status : null,
        calls: callsBySale.get(s.id) ?? [],
      }));
    }

    // An adviser gets no findings, no sales and no call results. All three
    // describe the firm's assessment of this customer across every adviser's
    // calls — a sale is credited to whoever closed it, and its breaches with it
    // — and an adviser is scoped to their own calls everywhere else (the sales
    // list and the sale page are closed to them). Withheld from the payload,
    // not just hidden on the page.
    const response: CustomerProfileResponse = {
      customer,
      mode,
      score_only: scoreOnly,
      reconciliation_enabled: reconciliationEnabled,
      stats: callStatsFrom(calls),
      compliance: isAdviser ? null : await loadCustomerCompliance(orgId, customer.id),
      sales,
      calls,
      sale_preview: canAction && mode === 'sales' ? await loadSalePreview(orgId, customer.id) : null,
    };

    res.json(response);
  } catch (err) {
    next(err);
  }
});

// ── Update customer (name / CRM id) ──────────────────────────────────────────
//
// Admin and supervisor only. It was open to viewers, a read-only role, and it
// left no record: a customer's CRM id goes out with every score (the
// call.scored and journey.scored webhooks), so an unrecorded edit could change
// where a result is filed with nobody able to say who did it.

customersRouter.put('/:id', requireActioner, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const { name, external_crm_id } = req.body as { name?: string; external_crm_id?: string };

    const rows = await query<{
      id: string;
      name: string | null;
      external_crm_id: string | null;
      before_name: string | null;
      before_external_crm_id: string | null;
    }>(
      // Distinguish "field not sent" (undefined → keep current) from an
      // explicit empty string (→ clear to NULL). Without this a wrongly
      // backfilled name could never be removed from the UI.
      //
      // `prev` is the row as this statement found it (locked), so the audit
      // record's "before" is the value this update replaced rather than a
      // separate read another request could have changed in between.
      `WITH prev AS (
         SELECT id, name, external_crm_id FROM customers
          WHERE id = $1 AND organization_id = $2
          FOR UPDATE
       )
       UPDATE customers c
          SET name            = CASE WHEN $3::boolean THEN NULLIF($4, '') ELSE c.name END,
              external_crm_id = CASE WHEN $5::boolean THEN NULLIF($6, '') ELSE c.external_crm_id END
         FROM prev
        WHERE c.id = prev.id
       RETURNING c.id, c.name, c.external_crm_id,
                 prev.name AS before_name, prev.external_crm_id AS before_external_crm_id`,
      [req.params.id, orgId, name !== undefined, name ?? '', external_crm_id !== undefined, external_crm_id ?? '']
    );

    const row = rows[0];
    if (!row) throw new AppError(404, 'Customer not found');

    const nameChanged = row.name !== row.before_name;
    const crmChanged = row.external_crm_id !== row.before_external_crm_id;
    if (nameChanged || crmChanged) {
      const changes: Record<string, unknown> = {};
      if (crmChanged) {
        changes.external_crm_id = { before: row.before_external_crm_id, after: row.external_crm_id };
      }
      if (nameChanged) {
        // Whether there was a name before and after, not the names themselves.
        // audit_log is append-only and outlives an erasure request, and a
        // person's name left in it is exactly the personal data
        // scripts/delete-customer-data.ts exists to remove — the reason that
        // script records ids only.
        changes.name = { before_present: row.before_name !== null, after_present: row.name !== null };
      }
      void recordAuditEvent({
        organizationId: orgId,
        userId: req.user!.userId,
        actionType: 'customer.update',
        entityType: 'customer',
        entityId: row.id,
        summary: `Edited a customer's ${[crmChanged ? 'CRM ID' : null, nameChanged ? 'name' : null]
          .filter(Boolean)
          .join(' and ')}`,
        metadata: { changes },
        req,
      });
    }

    res.json({ id: row.id, name: row.name, external_crm_id: row.external_crm_id });
  } catch (err) {
    next(err);
  }
});

// ── One person, several numbers (CG-8) ────────────────────────────────────────
//
// `customers` is keyed per phone number, so a customer who rings from a second
// number is a second row and their calls can never join the sale. Linking two
// rows says "these are the same person", and journey assembly then gathers
// calls across the group (services/journey.ts identityCustomerIds).
//
// Admin-only, and it takes a reason. A link changes which calls a compliance
// score is computed from — it can move a score, add breaches or remove them —
// so it is an assertion someone has to own, and migration 114 keeps the record
// of who made it even after it is undone.

// GET /api/customers/:id/identity — the group this customer belongs to, and the
// history of how it was formed.
customersRouter.get('/:id/identity', requireOrgView, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const customer = await queryOne<{ id: string; identity_id: string | null }>(
      'SELECT id, identity_id FROM customers WHERE id = $1 AND organization_id = $2',
      [String(req.params.id), orgId]
    );
    if (!customer) throw new AppError(404, 'Customer not found');

    const members = customer.identity_id
      ? await query<{ id: string; phone_normalized: string; name: string | null; call_count: number }>(
          `SELECT id, phone_normalized, name, call_count
             FROM customers
            WHERE organization_id = $1 AND identity_id = $2
            ORDER BY first_seen_at ASC`,
          [orgId, customer.identity_id]
        )
      : [];

    const history = customer.identity_id
      ? await query(
          `SELECT action, customer_id, actor_name, reason, created_at
             FROM customer_identity_events
            WHERE identity_id = $1
            ORDER BY created_at ASC`,
          [customer.identity_id]
        )
      : [];

    res.json({ identity_id: customer.identity_id, members, history });
  } catch (err) {
    next(err);
  }
});

/**
 * Validate a link request, independent of Express and the database.
 *
 * Extracted so the rules can be tested directly: the customers router is plan-
 * gated by a middleware that queries before any route runs, so a route-level
 * test of these rules would end up testing that middleware instead.
 *
 * `reason` is required here even though migration 114 leaves the column
 * nullable. The column is nullable so an older row is not retro-invalidated;
 * the API requires it because a link with no stated basis leaves a moved
 * compliance score with no explanation, which is what the event table exists
 * to prevent.
 */
export function validateLinkRequest(
  selfId: string,
  body: { customer_id?: unknown; reason?: unknown }
): { customerId: string; reason: string } {
  const otherId = typeof body?.customer_id === 'string' ? body.customer_id : '';
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!otherId) throw new AppError(400, 'customer_id is required');
  if (!reason) throw new AppError(400, 'reason is required');
  if (otherId === selfId) {
    throw new AppError(400, 'A customer cannot be linked to themselves');
  }
  return { customerId: otherId, reason };
}

// POST /api/customers/:id/identity/link — declare another customer the same
// person. Body: { customer_id, reason }.
customersRouter.post('/:id/identity/link', requireAdmin, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const { customerId: otherId, reason } = validateLinkRequest(String(req.params.id), req.body ?? {});

    const actor = await queryOne<{ name: string | null; email: string | null }>(
      'SELECT name, email FROM users WHERE id = $1',
      [req.user!.userId]
    );
    const actorName = actor?.name || actor?.email || 'Unknown user';

    const result = await withTransaction(async (tx) => {
      // Both locked: two admins linking overlapping pairs at once would
      // otherwise each read the other's group as unset and split one person
      // across two identities.
      const [a] = await tx.query<{ id: string; identity_id: string | null }>(
        'SELECT id, identity_id FROM customers WHERE id = $1 AND organization_id = $2 FOR UPDATE',
        [String(req.params.id), orgId]
      );
      const [b] = await tx.query<{ id: string; identity_id: string | null }>(
        'SELECT id, identity_id FROM customers WHERE id = $1 AND organization_id = $2 FOR UPDATE',
        [otherId, orgId]
      );
      if (!a || !b) throw new AppError(404, 'Customer not found');
      if (a.identity_id && b.identity_id && a.identity_id === b.identity_id) {
        return { identityId: a.identity_id, alreadyLinked: true, joined: [] as string[] };
      }
      // Merging two established groups would silently restate who several other
      // customers are, on the strength of one reason about two of them. Refused
      // rather than guessed: unlink one side first, deliberately.
      if (a.identity_id && b.identity_id) {
        throw new AppError(
          409,
          'Both customers already belong to different linked groups. Unlink one before joining them.'
        );
      }

      // Adopt whichever group exists, else start one.
      const identityId =
        a.identity_id ?? b.identity_id ?? (await tx.query<{ id: string }>('SELECT uuid_generate_v4() AS id'))[0]!.id;

      const joined = [a, b].filter((c) => c.identity_id !== identityId).map((c) => c.id);
      await tx.query(
        'UPDATE customers SET identity_id = $2 WHERE id = ANY($1::uuid[]) AND organization_id = $3',
        [joined, identityId, orgId]
      );
      for (const id of joined) {
        await tx.query(
          `INSERT INTO customer_identity_events
             (organization_id, identity_id, customer_id, action, actor_user_id, actor_name, reason)
           VALUES ($1, $2, $3, 'linked', $4, $5, $6)`,
          [orgId, identityId, id, req.user!.userId, actorName, reason]
        );
      }
      return { identityId, alreadyLinked: false, joined };
    });

    if (!result.alreadyLinked) {
      void recordAuditEvent({
        organizationId: orgId,
        userId: req.user!.userId,
        actionType: 'customer.identity_link',
        entityType: 'customer',
        entityId: [String(req.params.id), otherId],
        summary: `Linked two customer numbers as the same person: ${reason}`,
        metadata: { identity_id: result.identityId, joined: result.joined },
        req,
      });
    }

    res.json({ identity_id: result.identityId, already_linked: result.alreadyLinked });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/customers/:id/identity/link — remove this customer from its group.
//
// The group's other members keep their identity_id: removing one number does
// not dissolve everyone else's link. The event row is written, not deleted —
// "linked, acted on, then quietly unlinked" is exactly the sequence a reader
// needs to be able to see.
customersRouter.delete('/:id/identity/link', requireAdmin, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

    const actor = await queryOne<{ name: string | null; email: string | null }>(
      'SELECT name, email FROM users WHERE id = $1',
      [req.user!.userId]
    );
    const actorName = actor?.name || actor?.email || 'Unknown user';

    const customer = await queryOne<{ id: string; identity_id: string | null }>(
      'SELECT id, identity_id FROM customers WHERE id = $1 AND organization_id = $2',
      [String(req.params.id), orgId]
    );
    if (!customer) throw new AppError(404, 'Customer not found');
    if (!customer.identity_id) throw new AppError(400, 'This customer is not linked to anyone');

    await query(
      `INSERT INTO customer_identity_events
         (organization_id, identity_id, customer_id, action, actor_user_id, actor_name, reason)
       VALUES ($1, $2, $3, 'unlinked', $4, $5, $6)`,
      [orgId, customer.identity_id, customer.id, req.user!.userId, actorName, reason || null]
    );
    await query('UPDATE customers SET identity_id = NULL WHERE id = $1 AND organization_id = $2', [
      customer.id,
      orgId,
    ]);

    void recordAuditEvent({
      organizationId: orgId,
      userId: req.user!.userId,
      actionType: 'customer.identity_unlink',
      entityType: 'customer',
      entityId: customer.id,
      summary: 'Unlinked a customer number from its linked person',
      metadata: { identity_id: customer.identity_id },
      req,
    });

    res.json({ unlinked: true });
  } catch (err) {
    next(err);
  }
});
