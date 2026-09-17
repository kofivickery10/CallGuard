import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin, requireActioner, requireOrgView, requireRole } from '../middleware/auth.js';
import { upload, handleUploadError, UPLOAD_SIZE_LIMIT_MESSAGE } from '../middleware/upload.js';
import { query, queryOne } from '../db/client.js';
import { uploadFile, deleteFile, readFile } from '../services/storage.js';
import { transcriptionQueue } from '../jobs/queue.js';
import { AppError } from '../middleware/errors.js';
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES } from '@callguard/shared';
import { ingestCall, fetchRemoteAudio, upsertCustomer, normalizePhone } from '../services/ingestion.js';
import { prepareMediaForIngest } from '../services/media.js';
import { recordAuditEvent } from '../services/audit.js';
import { getScoringSettings, scoresCallsIndividually, orgHasFeature } from '../services/tenant-settings.js';
import { resolveTranscriptAccess, withheldTranscript } from '../services/transcript-access.js';
import { evaluateAlertsForResolvedItem } from '../services/alert-evaluator.js';
import { LINKED_TO_ANY_JOURNEY } from '../services/stuck.js';
import {
  FEEDBACK_STATUS_SQL,
  FEEDBACK_SENT_AT_SQL,
  FEEDBACK_CONFIRMED_AT_SQL,
} from '../db/feedback-status.js';
import {
  parseTranscriptBlocks,
  extractUtterances,
  locateEvidenceAgainst,
  blockStartTimesAgainst,
} from '../services/evidence-locator.js';
import type {
  Call,
  CallScore,
  CallItemScore,
  BreachSeverity,
  ItemResult,
  JourneyStatus,
  FeedbackStatus,
  CallJourneyContext,
  CallJourneySibling,
  CallPositionsResponse,
  CallItemPosition,
  CallListRow,
  CallListResponse,
  CallAdviserOption,
} from '@callguard/shared';
import { deriveSeverity, isItemPass, callPasses } from '@callguard/shared';

export const callRouter = Router();
callRouter.use(authenticate);

// The calls list's columns. Deliberately excludes transcript_text,
// transcript_raw and the storage pointers (file_key, recording_pointer): see the
// list route below.
const CALL_LIST_COLUMNS = [
  'id', 'organization_id', 'file_name', 'duration_seconds', 'status', 'error_message',
  'agent_id', 'agent_name', 'customer_id', 'customer_phone', 'call_date', 'tags',
  'external_id', 'ingestion_source', 'scorecard_id', 'journey_id', 'is_exemplar',
  'reviewed_at', 'created_at', 'updated_at', 'direction',
]
  .map((column) => `c.${column}`)
  .join(', ');

// The date GET /api/calls sorts, filters and pages by: the same "when did
// this call actually happen" rule the sales list uses for a sale
// (journeys.ts's SALE_DATE_SQL) — created_at is when the row was inserted
// (wrong for a backfill), call_date is what the dialler/upload says the call
// happened and is preferred whenever it is set.
const CALL_DATE_SQL = 'COALESCE(c.call_date, c.created_at)';

// A call's status is 'transcribed', 'scoring' or 'scored' if and only if it
// has a transcript: jobs/processors/transcribe.ts sets transcript_text and
// status = 'transcribed' in the same UPDATE, and nothing ever clears
// transcript_text or moves a call backwards out of that status range
// afterwards ('scoring'/'scored' only apply to a firm scoring calls
// individually — scoresCallsIndividually — since a sales_only firm's calls
// rest at 'transcribed' by design and never reach per-call scoring). Used in
// place of reading transcript_text itself, which CALL_LIST_COLUMNS and every
// query below deliberately never selects.
function hasTranscript(column: string): string {
  return `${column} IN ('transcribed', 'scoring', 'scored')`;
}

const PROCESSING_STATUSES = ['uploaded', 'transcribing', 'scoring'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SALES_TABS = ['all', 'in_sale', 'not_in_sale', 'processing', 'failed'] as const;
const CALLS_TABS = ['all', 'attention', 'failed_checks', 'passed', 'processing', 'failed'] as const;
// Tabs that assert a pass/fail verdict — hidden entirely under score_only
// (services/tenant-settings.ts: "the client hides the badge, but the value
// must not ship in the payload either" — applied here to which tabs even
// exist, not just how they're drawn).
const VERDICT_TABS = new Set(['failed_checks', 'passed']);

// One filter on the calls list: a SQL fragment carrying its own parameters,
// with `?` standing in for each of them rather than a pre-assigned $n.
// Renumbered at render time (buildCallWhere) so the per-tab counts can drop
// exactly one filter and still bind correctly — see journeys.ts's
// JourneyFilter/buildWhere for the fuller rationale (a clause numbered at
// construction time cannot survive being left out).
interface CallFilter {
  key: string;
  sql: string;
  params: unknown[];
}

function buildCallWhere(filters: CallFilter[], excludeKey?: string): { sql: string; params: unknown[] } {
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

// The tab predicates, keyed the same as the `tab` query param and the
// `counts` response. Fixed SQL (no user input), safe to interpolate.
function salesTabSql(tab: string): string {
  switch (tab) {
    case 'in_sale':
      return LINKED_TO_ANY_JOURNEY;
    case 'not_in_sale':
      // Not linked to a sale, and not in a state that would still explain the
      // absence (still processing, or failed outright) — see the tab's own
      // banner on the page for why these calls are kept unscored on purpose.
      return `NOT ${LINKED_TO_ANY_JOURNEY}
        AND c.status NOT IN ('${PROCESSING_STATUSES.join("','")}')
        AND c.status <> 'failed'`;
    case 'processing':
      return `c.status IN ('${PROCESSING_STATUSES.join("','")}')`;
    case 'failed':
      return `c.status = 'failed'`;
    default:
      return 'TRUE';
  }
}

// Calls-mode tab predicates. Reference `latest.pass` / `latest.has_manual_review`
// — the per-row LATERAL joined in by CALLS_LATEST_SCORE_LATERAL — rather than
// re-deriving them per predicate, so a row scored under two different
// scorecards is judged by the same "latest by scored_at" score everywhere: the
// page, every tab's count, and the row's own `score` field.
function callsTabSql(tab: string, scoreOnly: boolean): string {
  switch (tab) {
    case 'attention':
      // Under score_only the pass/fail verdict is never asserted to the tenant
      // (see VERDICT_TABS) — "needs attention" narrows to what score_only still
      // shows: a checkpoint waiting on a human.
      return scoreOnly
        ? 'latest.has_manual_review IS TRUE'
        : '(latest.pass IS FALSE OR latest.has_manual_review IS TRUE)';
    case 'failed_checks':
      return 'latest.pass IS FALSE';
    case 'passed':
      return 'latest.pass IS TRUE';
    case 'processing':
      return `c.status IN ('${PROCESSING_STATUSES.join("','")}')`;
    case 'failed':
      return `c.status = 'failed'`;
    default:
      return 'TRUE';
  }
}

// This call's latest score (by scored_at — a call can have more than one
// call_scores row, rescored against a different scorecard over time; see the
// LATERAL note this replaces below) and whether any of ITS checkpoints is
// still waiting on a human. `latest_score_id` is the presence marker: a call
// with no call_scores row at all makes every other lateral column NULL (the
// inner query never runs), which is indistinguishable in SQL from a scored
// call whose overall_score/pass are legitimately NULL (every checkpoint went
// to manual review, so nothing was auto-scored — see score.ts's
// nothingAutoScored) without a column that is only ever non-NULL when a row
// exists.
const CALLS_LATEST_SCORE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT cs.id AS latest_score_id, cs.overall_score, cs.pass,
           EXISTS (
             SELECT 1 FROM call_item_scores cis
              WHERE cis.call_score_id = cs.id AND cis.result = 'manual_review'
           ) AS has_manual_review,
           (SELECT COUNT(*)::int FROM call_item_scores cis
              WHERE cis.call_score_id = cs.id AND cis.result = 'fail') AS failed_count,
           (SELECT COUNT(*)::int FROM call_item_scores cis
              WHERE cis.call_score_id = cs.id AND cis.result = 'manual_review') AS waiting_count
      FROM call_scores cs
     WHERE cs.call_id = c.id
     ORDER BY cs.scored_at DESC
     LIMIT 1
  ) latest ON true
`;

// The sale this call belongs to (resolved via calls.journey_id, the same
// column GET /calls/:id keys its own journey summary off — kept in sync with
// journey_calls at assembly time by services/journey.ts), with the
// call-numbering and per-call breach counts a list row needs. `sale.id` is
// the presence marker: c.journey_id IS NULL can never equal a journeys.id, so
// the whole row is NULL rather than a false match.
const SALES_JOURNEY_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT j.id, j.status, j.overall_score, j.pass,
           (SELECT COUNT(*)::int
              FROM journey_calls sjc JOIN calls sc ON sc.id = sjc.call_id
             WHERE sjc.journey_id = j.id AND ${hasTranscript('sc.status')}
           ) AS call_total,
           -- This call's 1-based position among the sale's transcribed calls,
           -- in call-date order (ties broken on id) — the same order and the
           -- same "transcribed calls only" filter GET /calls/:id numbers a
           -- sale's calls by.
           (SELECT COUNT(*)::int
              FROM journey_calls njc JOIN calls nc ON nc.id = njc.call_id
             WHERE njc.journey_id = j.id AND ${hasTranscript('nc.status')}
               AND (COALESCE(nc.call_date, nc.created_at), nc.id)
                   <= (COALESCE(c.call_date, c.created_at), c.id)
           ) AS call_number_if_transcribed,
           (SELECT COUNT(*)::int FROM journey_item_scores jis
             WHERE jis.journey_id = j.id AND jis.source_call_id = c.id AND jis.result = 'fail'
           ) AS failed_here,
           (SELECT COUNT(*)::int FROM journey_item_scores jis
             WHERE jis.journey_id = j.id AND jis.source_call_id = c.id AND jis.result = 'manual_review'
           ) AS waiting_here
      FROM journeys j
     WHERE j.id = c.journey_id
  ) sale ON true
`;

interface CallListQueryRow {
  id: string;
  file_name: string;
  status: string;
  duration_seconds: string | null;
  called_at: string;
  direction: string | null;
  agent_id: string | null;
  adviser_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  resolved_customer_phone: string | null;
  sale_id: string | null;
  sale_status: JourneyStatus | null;
  sale_overall_score: string | null;
  sale_pass: boolean | null;
  sale_call_total: number | null;
  sale_call_number_if_transcribed: number | null;
  sale_failed_here: number | null;
  sale_waiting_here: number | null;
  latest_score_id: string | null;
  latest_overall_score: string | null;
  latest_pass: boolean | null;
  latest_failed_count: number | null;
  latest_waiting_count: number | null;
}

// GET /api/calls/advisers — the advisers a supervisor/viewer can filter the
// calls list by. /agents (used by AgentFilter everywhere else) is admin-only;
// this is the same idea scoped to who has actually taken a call, open to
// every role the list itself is (bar 'adviser', who has no use for a filter
// that only ever narrows to themselves). Declared before /:id so "advisers"
// is never swallowed as an id.
callRouter.get('/advisers', requireOrgView, async (req, res, next) => {
  try {
    const rows = await query<CallAdviserOption>(
      `SELECT DISTINCT u.id, u.name
         FROM users u
         JOIN calls c ON c.agent_id = u.id AND c.organization_id = u.organization_id
        WHERE u.organization_id = $1
        ORDER BY u.name ASC`,
      [req.user!.organizationId]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/calls — the calls list: every call from the org's dialler, with
// enough about its customer and its result (a sale's, or its own) to work
// from without opening it. Shaped by the org's scoring_scope
// (scoresCallsIndividually) rather than by anything Zoho-related — a
// sales_only firm's calls mostly rest unscored by design, so its tabs ask
// whether a call joined a sale; a firm scoring every call filters on the
// call's own verdict instead.
callRouter.get('/', async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const role = req.user!.role;

    const settings = await getScoringSettings(orgId);
    const mode: CallListResponse['mode'] = scoresCallsIndividually(settings) ? 'calls' : 'sales';
    const scoreOnly = mode === 'calls' && (await orgHasFeature(orgId, 'score_only'));

    let page = parseInt(req.query.page as string) || 1;
    if (page < 1) page = 1;
    let limit = parseInt(req.query.limit as string) || 20;
    limit = Math.min(Math.max(limit, 1), 100);
    const offset = (page - 1) * limit;

    const sortParam = typeof req.query.sort === 'string' ? req.query.sort : 'newest';
    if (sortParam !== 'newest' && sortParam !== 'oldest') {
      throw new AppError(400, "sort must be 'newest' or 'oldest'.");
    }
    const sortDir = sortParam === 'oldest' ? 'ASC' : 'DESC';

    const allTabs: readonly string[] = mode === 'sales' ? SALES_TABS : CALLS_TABS;
    // score_only never asserts a verdict (services/tenant-settings.ts) — the
    // tabs that would (failed_checks, passed) don't exist for this org, not
    // just "look empty": requesting one is refused outright, same as an
    // unrecognised tab.
    const availableTabs = scoreOnly ? allTabs.filter((t) => !VERDICT_TABS.has(t)) : allTabs;
    const tab = typeof req.query.tab === 'string' && req.query.tab ? req.query.tab : 'all';
    if (!availableTabs.includes(tab)) {
      if (scoreOnly && VERDICT_TABS.has(tab)) {
        throw new AppError(400, 'This organisation hides the pass/fail verdict, so tab cannot be failed_checks or passed.');
      }
      throw new AppError(400, `tab must be one of ${availableTabs.join(', ')}.`);
    }

    const filters: CallFilter[] = [{ key: 'org', sql: 'c.organization_id = ?', params: [orgId] }];

    // Advisers are scoped to their own calls whatever they pass — the query
    // param is for admin/supervisor/viewer, the roles GET /agents is also
    // limited by way of the page (the API itself never restricted it further).
    if (role === 'adviser') {
      filters.push({ key: 'adviser', sql: 'c.agent_id = ?', params: [req.user!.userId] });
    } else if (typeof req.query.adviser === 'string' && req.query.adviser) {
      if (!UUID_RE.test(req.query.adviser)) {
        throw new AppError(400, 'adviser must be a UUID.');
      }
      filters.push({ key: 'adviser', sql: 'c.agent_id = ?', params: [req.query.adviser] });
    }

    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const q = req.query.q.trim();
      if (q.length > 100) throw new AppError(400, 'q must be at most 100 characters.');
      // Escaped for ILIKE's own wildcards, not just for injection (the driver's
      // parameterisation already prevents that) — a customer literally named
      // "50% Off" or searched by a stray "_" must match itself, not act as a
      // wildcard.
      const likeSafe = q.replace(/[\\%_]/g, (m) => `\\${m}`);
      const digits = q.replace(/\D/g, '');
      // A phone match needs at least 3 digits: fewer than that, "07" or "44"
      // would match nearly every call in the org rather than narrowing to one
      // customer, which reads as a broken search rather than an unhelpful one.
      if (digits.length >= 3) {
        filters.push({
          key: 'q',
          sql: `(cust.name ILIKE ? ESCAPE '\\'
                 OR REGEXP_REPLACE(COALESCE(cust.phone_normalized, ''), '\\D', '', 'g') LIKE ?
                 OR REGEXP_REPLACE(COALESCE(c.customer_phone, ''), '\\D', '', 'g') LIKE ?)`,
          params: [`%${likeSafe}%`, `%${digits}%`, `%${digits}%`],
        });
      } else {
        filters.push({ key: 'q', sql: `cust.name ILIKE ? ESCAPE '\\'`, params: [`%${likeSafe}%`] });
      }
    }

    // The call's date, interpreted in Europe/London (the org's timezone) —
    // casting a bare date to timestamp and reading it AT TIME ZONE turns "that
    // calendar day, London time" into the UTC instant CALL_DATE_SQL is
    // actually compared against.
    if (typeof req.query.from === 'string') {
      if (!ISO_DATE_RE.test(req.query.from)) throw new AppError(400, 'from must be an ISO date (YYYY-MM-DD).');
      filters.push({
        key: 'from',
        sql: `${CALL_DATE_SQL} >= ((?::date)::timestamp AT TIME ZONE 'Europe/London')`,
        params: [req.query.from],
      });
    }
    if (typeof req.query.to === 'string') {
      if (!ISO_DATE_RE.test(req.query.to)) throw new AppError(400, 'to must be an ISO date (YYYY-MM-DD).');
      filters.push({
        key: 'to',
        sql: `${CALL_DATE_SQL} < (((?::date) + 1)::timestamp AT TIME ZONE 'Europe/London')`,
        params: [req.query.to],
      });
    }

    const where = buildCallWhere(filters);
    const tabSql = mode === 'sales' ? salesTabSql(tab) : callsTabSql(tab, scoreOnly);
    const latestScoreLateral = mode === 'calls' ? CALLS_LATEST_SCORE_LATERAL : '';
    const saleLateral = mode === 'sales' ? SALES_JOURNEY_LATERAL : '';

    // One count query, one FILTER per tab of this mode — never a query per
    // tab, and never a query per row of the page below. `latest`/`sale` are
    // joined in even here because the calls-mode tabs are predicates over
    // `latest.*` (see callsTabSql); the sales-mode ones (LINKED_TO_ANY_JOURNEY,
    // status) need no join at all.
    const countRow = await queryOne<Record<string, string>>(
      `SELECT ${availableTabs
        .map((t) => `COUNT(*) FILTER (WHERE ${mode === 'sales' ? salesTabSql(t) : callsTabSql(t, scoreOnly)})::text AS ${t}`)
        .join(', ')}
         FROM calls c
         LEFT JOIN customers cust ON cust.id = c.customer_id
         ${latestScoreLateral}
        WHERE ${where.sql}`,
      where.params
    );
    const counts: Record<string, number> = {};
    for (const t of availableTabs) counts[t] = parseInt(countRow?.[t] ?? '0', 10);

    // A call can have more than one call_scores row (rescored against a
    // different scorecard over time) and, in sales mode, belongs to at most
    // one journey — both are picked with a per-row LATERAL rather than a plain
    // JOIN so a call is never fanned out into more than one page row. Only the
    // columns a list row needs: this used to be `c.*`, which put every call's
    // transcript_text and the raw transcription payload into each page —
    // measured on a live tenant at 27.6 MB for one page of 20 transcribed
    // calls. The full record is GET /:id, behind the transcript-access gate.
    const rows = await query<CallListQueryRow>(
      `SELECT ${CALL_LIST_COLUMNS}, ${CALL_DATE_SQL} AS called_at,
              COALESCE(u.name, c.agent_name) AS adviser_name,
              cust.name AS customer_name,
              COALESCE(cust.phone_normalized, c.customer_phone) AS resolved_customer_phone
              ${
                mode === 'sales'
                  ? `, sale.id AS sale_id, sale.status AS sale_status, sale.overall_score AS sale_overall_score,
                       sale.pass AS sale_pass, sale.call_total AS sale_call_total,
                       sale.call_number_if_transcribed AS sale_call_number_if_transcribed,
                       sale.failed_here AS sale_failed_here, sale.waiting_here AS sale_waiting_here`
                  : `, latest.latest_score_id AS latest_score_id, latest.overall_score AS latest_overall_score,
                       latest.pass AS latest_pass, latest.failed_count AS latest_failed_count,
                       latest.waiting_count AS latest_waiting_count`
              }
         FROM calls c
         LEFT JOIN users u ON u.id = c.agent_id
         LEFT JOIN customers cust ON cust.id = c.customer_id
         ${saleLateral}
         ${latestScoreLateral}
        WHERE ${where.sql} AND (${tabSql})
        ORDER BY ${CALL_DATE_SQL} ${sortDir}, c.id ${sortDir}
        LIMIT $${where.params.length + 1} OFFSET $${where.params.length + 2}`,
      [...where.params, limit, offset]
    );

    const data: CallListRow[] = rows.map((r) => ({
      id: r.id,
      file_name: r.file_name,
      status: r.status as CallListRow['status'],
      duration_seconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
      called_at: r.called_at,
      direction: r.direction,
      adviser_id: r.agent_id,
      adviser_name: r.adviser_name,
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      customer_phone: r.resolved_customer_phone,
      sale:
        mode === 'sales' && r.sale_id
          ? {
              id: r.sale_id,
              status: r.sale_status as JourneyStatus,
              overall_score: r.sale_overall_score === null ? null : Number(r.sale_overall_score),
              pass: r.sale_pass,
              call_number: hasTranscriptStatus(r.status) ? r.sale_call_number_if_transcribed : null,
              call_total: r.sale_call_total ?? 0,
              failed_here: r.sale_failed_here ?? 0,
              waiting_here: r.sale_waiting_here ?? 0,
            }
          : null,
      score:
        mode === 'calls' && r.latest_score_id
          ? {
              overall_score: r.latest_overall_score === null ? null : Number(r.latest_overall_score),
              pass: r.latest_pass,
              failed: r.latest_failed_count ?? 0,
              waiting: r.latest_waiting_count ?? 0,
            }
          : null,
    }));

    const response: CallListResponse = {
      data,
      // The current tab's own count IS the total for this request — every
      // filter that shapes the page (including the tab itself) also shapes
      // this count, so a third query just to re-total the same WHERE would
      // only ever agree with it.
      total: counts[tab] ?? 0,
      page,
      limit,
      mode,
      counts,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

function hasTranscriptStatus(status: string): boolean {
  return status === 'transcribed' || status === 'scoring' || status === 'scored';
}

// Upload a call. Viewers are read-only elsewhere in the app and must not gain
// upload access just by typing the URL — admin, supervisor and adviser only
// (bulk import below stays admin-only).
callRouter.post(
  '/upload',
  requireRole('admin', 'supervisor', 'adviser'),
  upload.single('audio'),
  handleUploadError,
  async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      throw new AppError(400, 'No audio file provided');
    }

    // multer's fileSize limit is the video ceiling (a meeting recording arrives
    // as a container); a plain audio file is held to the tighter, stated limit.
    if (ALLOWED_MIME_TYPES.includes(req.file.mimetype) && req.file.size > MAX_FILE_SIZE_BYTES) {
      throw new AppError(413, UPLOAD_SIZE_LIMIT_MESSAGE);
    }

    // A sale can only be matched to the customer's other calls by phone — flag
    // it without one and the call would rest at 'transcribed' forever (see the
    // deferToSale branch in jobs/processors/transcribe.ts, which needs a
    // customer_id to assemble a journey against). Checked before anything is
    // written to storage.
    if (req.body.mark_as_sale === 'true' && !normalizePhone(req.body.customer_phone || '')) {
      throw new AppError(
        400,
        "To score this call as a sale, add the customer's phone number — it's how the call is matched to the customer's other calls."
      );
    }

    const callId = uuid();
    // A Teams/Zoom recording arrives as a video container — reduce it to audio
    // before anything is stored, so the rest of the pipeline only ever handles
    // audio (services/media.ts). A no-op for audio uploads.
    const media = await prepareMediaForIngest({
      buffer: req.file.buffer,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
    });

    // path.basename strips any directory component a crafted originalname
    // (e.g. "../../../etc/x") would otherwise carry into the storage key.
    const safeFileName = path.basename(media.fileName);
    const fileKey = `calls/${req.user!.organizationId}/${callId}/${safeFileName}`;

    await uploadFile(fileKey, media.buffer, media.mimeType);

    // If member, auto-assign to self
    let agentId = req.body.agent_id || null;
    const agentName = req.body.agent_name || null;

    if (req.user!.role === 'adviser') {
      agentId = req.user!.userId;
    }

    // Validate per-call scorecard selection (BPO multi-campaign use case)
    let scorecardId: string | null = null;
    if (req.body.scorecard_id) {
      const sc = await queryOne<{ id: string }>(
        'SELECT id FROM scorecards WHERE id = $1 AND organization_id = $2',
        [req.body.scorecard_id, req.user!.organizationId]
      );
      if (!sc) throw new AppError(404, `Scorecard ${req.body.scorecard_id} not found`);
      scorecardId = sc.id;
    }

    // Resolve the customer by phone so this call can join a journey (spec §9)
    // — without a customer_id, marking it as a sale below has nothing to
    // attach the journey to.
    let customerId: string | null = null;
    if (req.body.customer_phone) {
      const normalised = normalizePhone(req.body.customer_phone);
      if (normalised) {
        customerId = await upsertCustomer(req.user!.organizationId, normalised);
      }
    }

    // Manually flags this call as having resulted in a sale — for
    // 'sales_only' tenants, transcribe.ts assembles + scores a journey for
    // this customer once transcription completes, the same way a CRM sale
    // webhook would (see services/journey.ts). Honoured for whoever uploads,
    // not only admins: at a sales_only firm it is one of the three ways a sale
    // arrives, and the Upload page offers it to every uploading role.
    const saleFlagged = req.body.mark_as_sale === 'true';

    const rows = await query<Call>(
      `INSERT INTO calls (id, organization_id, uploaded_by, file_name, file_key, file_size_bytes, mime_type, agent_id, agent_name, customer_phone, customer_id, call_date, tags, status, encrypted_at_rest, scorecard_id, sale_flagged)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'uploaded', true, $14, $15) RETURNING *`,
      [
        callId,
        req.user!.organizationId,
        req.user!.userId,
        safeFileName,
        fileKey,
        // The stored audio's size/type, not the uploaded container's — the
        // video file itself is never persisted.
        media.buffer.length,
        media.mimeType,
        agentId,
        agentName,
        req.body.customer_phone || null,
        customerId,
        req.body.call_date || null,
        req.body.tags ? JSON.parse(req.body.tags) : [],
        scorecardId,
        saleFlagged,
      ]
    );

    // Auto-match agent_name to a member user if no agent_id was set
    if (!agentId && agentName) {
      await query(
        `UPDATE calls SET agent_id = u.id
         FROM users u
         WHERE calls.id = $1
           AND u.organization_id = $2
           AND u.role = 'adviser'
           AND lower(trim(u.name)) = lower(trim($3))`,
        [callId, req.user!.organizationId, agentName]
      );
    }

    // Enqueue transcription job
    await transcriptionQueue.add('transcribe', { callId }, { jobId: callId });

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
  }
);

// Bulk historical recording import (admin only)
//
// Accepts JSON: { rows: [{ audio_url, agent_name?, customer_phone?,
// call_date?, external_id?, tags? }] }
//
// Each row is downloaded, ingested via the unified ingestion service
// (which handles dedupe by external_id, agent matching, and queue for
// transcription). Capped at 200 rows per request so a typo cannot
// timeout the worker. Returns a per-row outcome summary.
interface BulkImportRow {
  audio_url: string;
  agent_name?: string | null;
  customer_phone?: string | null;
  call_date?: string | null;
  external_id?: string | null;
  tags?: string[] | string;
  scorecard_id?: string | null;
}

callRouter.post('/bulk-import', requireAdmin, async (req, res, next) => {
  try {
    const rows = (req.body?.rows ?? []) as BulkImportRow[];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new AppError(400, 'rows[] is required');
    }
    if (rows.length > 200) {
      throw new AppError(400, 'Maximum 200 rows per request');
    }

    const orgId = req.user!.organizationId;
    const userId = req.user!.userId;
    const queued: { row: number; call_id: string; external_id: string | null }[] = [];
    const duplicates: { row: number; call_id: string; external_id: string | null }[] = [];
    const errors: { row: number; audio_url: string; error: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        if (!r.audio_url || typeof r.audio_url !== 'string') {
          throw new Error('audio_url missing or not a string');
        }
        const { buffer, fileName, mimeType } = await fetchRemoteAudio(r.audio_url);
        const tags = Array.isArray(r.tags)
          ? r.tags
          : typeof r.tags === 'string' && r.tags
            ? r.tags.split(/\s*,\s*/).filter(Boolean)
            : [];

        const { call, isDuplicate } = await ingestCall({
          organizationId: orgId,
          uploadedBy: userId,
          fileName,
          buffer,
          mimeType,
          ingestionSource: 'upload',
          agentName: r.agent_name ?? null,
          customerPhone: r.customer_phone ?? null,
          callDate: r.call_date ?? null,
          externalId: r.external_id ?? null,
          tags,
          scorecardId: r.scorecard_id ?? null,
        });

        (isDuplicate ? duplicates : queued).push({
          row: i,
          call_id: call.id,
          external_id: call.external_id,
        });
      } catch (err) {
        errors.push({
          row: i,
          audio_url: r.audio_url || '',
          error: err instanceof Error ? err.message : 'unknown error',
        });
      }
    }

    void recordAuditEvent({
      organizationId: orgId,
      userId,
      actionType: 'call.bulk_import',
      entityType: 'call',
      summary: `Bulk imported ${queued.length} new + ${duplicates.length} duplicate / ${errors.length} failed`,
      metadata: {
        total_rows: rows.length,
        queued: queued.length,
        duplicates: duplicates.length,
        errors: errors.length,
      },
      req,
    });

    res.json({
      total: rows.length,
      queued: queued.length,
      duplicates: duplicates.length,
      errors: errors.length,
      queued_calls: queued,
      duplicate_calls: duplicates,
      error_rows: errors,
    });
  } catch (err) {
    next(err);
  }
});

// The org's advisers, for the upload page's "assign to" picker — a supervisor
// may attribute an upload but can't reach the full /agents list (admin-only,
// and carries stats/audit-sensitive fields this page has no need of).
// Registered before '/:id', like journeys.ts's own /advisers, or Express would
// match "advisers" as a call id.
callRouter.get('/advisers', requireActioner, async (req, res, next) => {
  try {
    const advisers = await query<{ id: string; name: string }>(
      `SELECT id, name FROM users
       WHERE organization_id = $1 AND role = 'adviser'
       ORDER BY name`,
      [req.user!.organizationId]
    );
    res.json({ data: advisers });
  } catch (err) {
    next(err);
  }
});

// Get single call (role-scoped)
callRouter.get('/:id', async (req, res, next) => {
  try {
    // customer_name so the call page can name the customer and link to their
    // profile; the org condition on the join keeps it to this tenant's row.
    let sql =
      'SELECT c.*, u.name as resolved_agent_name, cust.name AS customer_name FROM calls c LEFT JOIN users u ON u.id = c.agent_id LEFT JOIN customers cust ON cust.id = c.customer_id AND cust.organization_id = c.organization_id WHERE c.id = $1 AND c.organization_id = $2';
    const params: unknown[] = [req.params.id, req.user!.organizationId];

    if (req.user!.role === 'adviser') {
      params.push(req.user!.userId);
      sql += ` AND c.agent_id = $${params.length}`;
    }

    const call = await queryOne<{ id: string; journey_id: string | null }>(sql, params);
    if (!call) throw new AppError(404, 'Call not found');

    // If this call belongs to a scored sale journey, attach a summary + the
    // checkpoints whose evidence came from THIS call, so the call view can link
    // to and surface its journey (per-call scoring doesn't run for journey
    // calls — the score lives on the journey; see jobs/processors/score-journey).
    let journey: CallJourneyContext | null = null;
    if (call.journey_id) {
      const j = await queryOne<{
        id: string;
        status: JourneyStatus;
        branch: string | null;
        overall_score: string | null;
        pass: boolean | null;
        customer_id: string;
        feedback_status: FeedbackStatus;
        feedback_sent_at: string | null;
        feedback_confirmed_at: string | null;
      }>(
        `SELECT j.id, j.status, j.branch, j.overall_score, j.pass, j.customer_id,
                ${FEEDBACK_STATUS_SQL} AS feedback_status,
                ${FEEDBACK_SENT_AT_SQL} AS feedback_sent_at,
                ${FEEDBACK_CONFIRMED_AT_SQL} AS feedback_confirmed_at
           FROM journeys j
          WHERE j.id = $1 AND j.organization_id = $2`,
        [call.journey_id, req.user!.organizationId]
      );
      if (j) {
        const itemRows = await query<{
          id: string;
          scorecard_item_id: string;
          result: ItemResult;
          normalized_score: number | null;
          evidence: string | null;
          reasoning: string | null;
          label: string;
          section: string | null;
          severity: string | null;
          weight: string;
        }>(
          `SELECT jis.id, jis.scorecard_item_id, jis.result, jis.normalized_score, jis.evidence, jis.reasoning,
                  si.label, si.section, si.severity, si.weight::text AS weight
             FROM journey_item_scores jis
             JOIN scorecard_items si ON si.id = jis.scorecard_item_id
            WHERE jis.journey_id = $1 AND jis.source_call_id = $2
            ORDER BY si.sort_order ASC`,
          [call.journey_id, call.id]
        );
        // The severity the sale was actually judged by — see journeys.ts's sale
        // detail endpoint (deriveSeverity) for why the raw column isn't enough
        // on its own.
        const thisCallItems = itemRows.map(({ weight, severity, ...row }) => ({
          ...row,
          severity: deriveSeverity(Number(weight), severity),
        }));

        // Whose sale this is, resolved the same way the sale detail endpoint
        // resolves it: the linked customer's name.
        const customer = await queryOne<{ name: string | null }>(
          'SELECT name FROM customers WHERE id = $1',
          [j.customer_id]
        );

        // Every call in the sale, in the order the sale page numbers them
        // ("Call 1", "Call 2", ...) — only calls with a transcript are
        // numbered, matching score-journey.ts's withTranscript filter, so this
        // call's "Call N of M" and its siblings' numbers agree with the sale.
        const journeyCalls = await query<{
          id: string;
          duration_seconds: number | null;
          has_transcript: boolean;
        }>(
          `SELECT c2.id, c2.duration_seconds,
                  (COALESCE(c2.transcript_text, '') <> '') AS has_transcript
             FROM journey_calls jc2
             JOIN calls c2 ON c2.id = jc2.call_id
            WHERE jc2.journey_id = $1
            ORDER BY COALESCE(c2.call_date::timestamptz, c2.created_at) ASC`,
          [call.journey_id]
        );
        const itemCountRows = await query<{ source_call_id: string; item_count: string }>(
          `SELECT source_call_id, COUNT(*)::text AS item_count
             FROM journey_item_scores
            WHERE journey_id = $1 AND source_call_id IS NOT NULL
            GROUP BY source_call_id`,
          [call.journey_id]
        );
        const itemCountByCall = new Map(
          itemCountRows.map((r) => [r.source_call_id, parseInt(r.item_count, 10)])
        );

        let callTotal = 0;
        const callNumberById = new Map<string, number>();
        for (const jc of journeyCalls) {
          if (jc.has_transcript) callNumberById.set(jc.id, ++callTotal);
        }
        const siblings: CallJourneySibling[] = journeyCalls
          .filter((jc) => jc.id !== call.id)
          .map((jc) => ({
            id: jc.id,
            call_number: callNumberById.get(jc.id) ?? null,
            has_transcript: jc.has_transcript,
            duration_seconds: jc.duration_seconds,
            item_count: itemCountByCall.get(jc.id) ?? 0,
          }));

        journey = {
          id: j.id,
          status: j.status,
          branch: j.branch,
          overall_score: j.overall_score === null ? null : Number(j.overall_score),
          pass: j.pass,
          this_call_items: thisCallItems,
          client_name: customer?.name ?? null,
          call_number: callNumberById.get(call.id) ?? null,
          call_total: callTotal,
          siblings,
          feedback_status: j.feedback_status,
          feedback_sent_at: j.feedback_sent_at,
          feedback_confirmed_at: j.feedback_confirmed_at,
        };
      }
    }

    // Transcript content is withheld from roles below admin where the tenant
    // keeps a redaction category in the clear (DPIA action 11). SELECT c.* means
    // transcript_text and transcript_raw are on this row, so the filter has to be
    // here rather than in the query — a new column carrying transcript content
    // would otherwise arrive ungated.
    const access = await resolveTranscriptAccess(req.user!.organizationId, req.user!.role);

    res.json({ ...withheldTranscript(call as Record<string, unknown>, access), journey });
  } catch (err) {
    next(err);
  }
});

// Where every checkpoint's evidence quote sits in this call, and the time of
// each transcript line — the call detail page's "listen from here" and
// running clock, computed against services/evidence-locator.ts.
//
// Deliberately carries no transcript text of any kind, only positions and
// times, which is why it doesn't need transcript-access.ts's redaction gate
// (see GET /:id above): a user whose transcript is restricted can still be
// told when a quote was said and be sent to that point in the recording
// without ever being shown the words themselves.
callRouter.get('/:id/positions', async (req, res, next) => {
  try {
    let sql =
      'SELECT id, transcript_text, transcript_raw FROM calls WHERE id = $1 AND organization_id = $2';
    const params: unknown[] = [req.params.id, req.user!.organizationId];

    if (req.user!.role === 'adviser') {
      params.push(req.user!.userId);
      sql += ` AND agent_id = $${params.length}`;
    }

    const call = await queryOne<{
      id: string;
      transcript_text: string | null;
      transcript_raw: unknown;
    }>(sql, params);
    if (!call) throw new AppError(404, 'Call not found');

    if (!call.transcript_text) {
      const empty: CallPositionsResponse = { lines: [], items: [] };
      res.json(empty);
      return;
    }

    // Parsed once and reused for every checkpoint below (~40 per call) rather
    // than re-parsing the transcript per item.
    const blocks = parseTranscriptBlocks(call.transcript_text);
    const utterances = extractUtterances(call.transcript_raw);

    const times = blockStartTimesAgainst(blocks, utterances);
    const lines = blocks.map((block, i) => ({ index: block.index, start_seconds: times[i] }));

    // A journey call's checkpoints (source_call_id points straight at this
    // call, no journey join needed — it can only name a call already scoped
    // to this org by the WHERE above) plus, if this call was ever scored on
    // its own, its own most recent scoring run's checkpoints.
    const journeyItems = await query<{ id: string; evidence: string | null }>(
      `SELECT id, evidence FROM journey_item_scores
        WHERE source_call_id = $1 AND evidence IS NOT NULL AND evidence <> ''`,
      [call.id]
    );

    const latestCallScore = await queryOne<{ id: string }>(
      `SELECT id FROM call_scores WHERE call_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [call.id]
    );
    const callItems = latestCallScore
      ? await query<{ id: string; evidence: string | null }>(
          `SELECT id, evidence FROM call_item_scores
            WHERE call_score_id = $1 AND evidence IS NOT NULL AND evidence <> ''`,
          [latestCallScore.id]
        )
      : [];

    const items: CallItemPosition[] = [
      ...journeyItems.map((row) => ({ ...row, kind: 'journey' as const })),
      ...callItems.map((row) => ({ ...row, kind: 'call' as const })),
    ].map(({ id, evidence, kind }) => {
      const located = locateEvidenceAgainst({ quote: evidence, blocks, utterances });
      const lineIndex = located.matched
        ? (located.excerpt.find((l) => l.is_match)?.index ?? null)
        : null;
      return {
        item_score_id: id,
        kind,
        matched: located.matched,
        line_index: lineIndex,
        timestamp_seconds: located.matched ? located.timestamp_seconds : null,
      };
    });

    const response: CallPositionsResponse = { lines, items };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

// Mark a call reviewed (or clear it). The implicit calibration signal: items
// the reviewer didn't correct on a reviewed call count as agreements.
callRouter.post('/:id/review', requireActioner, async (req, res, next) => {
  try {
    const reviewed = req.body?.reviewed !== false; // default true
    const rows = await query<Call>(
      `UPDATE calls
          SET reviewed_at = ${reviewed ? 'now()' : 'NULL'},
              reviewed_by = ${reviewed ? '$3' : 'NULL'},
              updated_at = now()
        WHERE id = $1 AND organization_id = $2
        RETURNING *`,
      reviewed
        ? [req.params.id, req.user!.organizationId, req.user!.userId]
        : [req.params.id, req.user!.organizationId]
    );
    if (rows.length === 0) throw new AppError(404, 'Call not found');
    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: reviewed ? 'call.reviewed' : 'call.review_cleared',
      entityType: 'call',
      entityId: req.params.id,
      summary: reviewed ? 'Marked call as reviewed' : 'Cleared call review',
      req,
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Delete a call (admin only). DB cascades to call_scores, call_item_scores,
// breaches, score_corrections; we also remove the audio file from storage.
callRouter.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const call = await queryOne<{ id: string; file_key: string | null }>(
      'SELECT id, file_key FROM calls WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!call) throw new AppError(404, 'Call not found');

    // Refuse once the call has been fed back to its adviser (migration 118),
    // for the reason the re-score below refuses — and more so. journey_feedback
    // .call_id is ON DELETE CASCADE, so deleting the call would erase the record
    // of what the adviser was told, their confirmation, and every outcome they
    // recorded about a customer. That cascade exists for retention and
    // data-subject erasure, which are deliberate policy; a delete button is not.
    //
    // Checked before the audio is removed, so a refused delete changes nothing.
    const fedBack = await queryOne<{ adviser_name: string; confirmed_at: string | null }>(
      `SELECT adviser_name, confirmed_at FROM journey_feedback
        WHERE call_id = $1 ORDER BY sent_at DESC LIMIT 1`,
      [call.id]
    );
    if (fedBack) {
      throw new AppError(
        409,
        `This call has been fed back to ${fedBack.adviser_name}` +
          (fedBack.confirmed_at ? ', and they confirmed receipt' : '') +
          '. Deleting it would also delete the record of what they were told, and anything they recorded about what they did. ' +
          'Ask CallGuard support if this call genuinely needs deleting.'
      );
    }

    if (call.file_key) {
      try {
        await deleteFile(call.file_key);
      } catch (err) {
        console.warn(`[Calls] Failed to delete audio for ${call.id}:`, err);
      }
    }

    await query('DELETE FROM calls WHERE id = $1', [call.id]);
    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'call.delete',
      entityType: 'call',
      entityId: call.id,
      summary: `Deleted call ${call.id}`,
      req,
    });
    res.json({ message: 'Call deleted', id: call.id });
  } catch (err) {
    next(err);
  }
});

// Stream the decrypted audio file for a call.
// Access is auth-gated and org-scoped — no public URLs exposed.
callRouter.get('/:id/audio', async (req, res, next) => {
  try {
    let sql =
      'SELECT file_key, mime_type, file_name, encrypted_at_rest FROM calls WHERE id = $1 AND organization_id = $2';
    const params: unknown[] = [req.params.id, req.user!.organizationId];

    if (req.user!.role === 'adviser') {
      params.push(req.user!.userId);
      sql += ` AND agent_id = $${params.length}`;
    }

    const call = await queryOne<{
      file_key: string | null;
      mime_type: string | null;
      file_name: string | null;
      encrypted_at_rest: boolean;
    }>(sql, params);

    if (!call) throw new AppError(404, 'Call not found');
    if (!call.file_key) throw new AppError(404, 'No audio file for this call');

    const buffer = await readFile(call.file_key, call.encrypted_at_rest);
    const contentType = call.mime_type || 'audio/mpeg';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(call.file_name || 'audio')}"`,
    );
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// Get scores for a call
callRouter.get('/:id/scores', async (req, res, next) => {
  try {
    let sql = 'SELECT id FROM calls WHERE id = $1 AND organization_id = $2';
    const params: unknown[] = [req.params.id, req.user!.organizationId];

    if (req.user!.role === 'adviser') {
      params.push(req.user!.userId);
      sql += ` AND agent_id = $${params.length}`;
    }

    const call = await queryOne(sql, params);
    if (!call) throw new AppError(404, 'Call not found');

    const scores = await query<CallScore>(
      'SELECT * FROM call_scores WHERE call_id = $1',
      [req.params.id]
    );

    const result = await Promise.all(
      scores.map(async (score) => {
        const itemScores = await query<
          CallItemScore & { section: string | null; severity: BreachSeverity | null; weight: string }
        >(
          `SELECT cis.*, si.label, si.description as item_description, si.score_type,
                  si.section, si.severity, si.weight::text AS weight
           FROM call_item_scores cis
           JOIN scorecard_items si ON si.id = cis.scorecard_item_id
           WHERE cis.call_score_id = $1
           ORDER BY si.sort_order`,
          [score.id]
        );
        return {
          ...score,
          // Same rule as the sale's checkpoints (routes/journeys.ts): a
          // scorecard item need not carry an explicit severity, and scoring
          // falls back to its weight, so the page must not be shown a null
          // where the scorer would have read "high".
          item_scores: itemScores.map(({ weight, severity, ...item }) => ({
            ...item,
            severity: deriveSeverity(Number(weight), severity),
          })),
        };
      })
    );

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// Assign agent to a call (admin only)
callRouter.patch('/:id/assign-agent', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { agent_id } = req.body;

    const call = await queryOne(
      'SELECT id FROM calls WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!call) throw new AppError(404, 'Call not found');

    if (agent_id) {
      const agent = await queryOne(
        'SELECT id FROM users WHERE id = $1 AND organization_id = $2 AND role = $3',
        [agent_id, req.user!.organizationId, 'adviser']
      );
      if (!agent) throw new AppError(404, 'Agent not found');
    }

    await query(
      'UPDATE calls SET agent_id = $1, updated_at = now() WHERE id = $2',
      [agent_id || null, req.params.id]
    );

    res.json({ message: 'Agent assigned' });
  } catch (err) {
    next(err);
  }
});

// Re-score a call. Admin-only: re-scoring re-spends scoring tokens, so it's a
// considered action, not something every actioner should trigger at will.
callRouter.post('/:id/rescore', requireAdmin, async (req, res, next) => {
  try {
    const call = await queryOne<Call>(
      'SELECT * FROM calls WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!call) throw new AppError(404, 'Call not found');
    if (!call.transcript_text) {
      throw new AppError(400, 'Call has not been transcribed yet');
    }

    // Refuse once the call has been fed back to its adviser (migration 118) —
    // the per-call twin of the guard on POST /api/journeys/:id/rescore, and for
    // the same reason. A re-score replaces the call's breaches; if the adviser
    // has already been sent the findings, re-scoring rewrites what they were
    // told about, after they were told. The feedback record keeps its own
    // snapshot, but the register would hold a confirmed conversation about
    // findings the call no longer has.
    //
    // Blocked from the moment it is SENT, not from confirmation, and not
    // overridable by the tenant. Superadmins keep the override for support.
    if (req.user!.role !== 'superadmin') {
      const fedBack = await queryOne<{ adviser_name: string; confirmed_at: string | null }>(
        `SELECT adviser_name, confirmed_at FROM journey_feedback
          WHERE call_id = $1 ORDER BY sent_at DESC LIMIT 1`,
        [call.id]
      );
      if (fedBack) {
        throw new AppError(
          409,
          `This call has been fed back to ${fedBack.adviser_name}` +
            (fedBack.confirmed_at ? ', and they confirmed receipt' : '') +
            '. Re-scoring would change the findings they were told about, after they were told. ' +
            'Ask CallGuard support if this call genuinely needs re-scoring.'
        );
      }
    }

    await query(
      "UPDATE calls SET status = 'scoring', updated_at = now() WHERE id = $1",
      [call.id]
    );

    const { scoringQueue } = await import('../jobs/queue.js');
    await scoringQueue.add('score', { callId: call.id }, { jobId: `rescore-${call.id}-${Date.now()}` });

    res.json({ message: 'Re-scoring initiated' });
  } catch (err) {
    next(err);
  }
});

// Correct a scorecard item score (admin only) - feeds the AI learning loop
callRouter.post('/:id/scores/items/:itemScoreId/correct', requireActioner, async (req, res, next) => {
  try {
    const { corrected_pass, reason } = req.body;
    if (typeof corrected_pass !== 'boolean') {
      throw new AppError(400, 'corrected_pass must be boolean');
    }

    // Verify call belongs to this org
    const call = await queryOne<{ id: string; organization_id: string }>(
      'SELECT id, organization_id FROM calls WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!call) throw new AppError(404, 'Call not found');

    // Load the item score row (must belong to this call)
    const itemScore = await queryOne<{
      id: string;
      call_score_id: string;
      scorecard_item_id: string;
      score: number;
      normalized_score: number;
      evidence: string | null;
    }>(
      `SELECT cis.id, cis.call_score_id, cis.scorecard_item_id, cis.score, cis.normalized_score, cis.evidence
         FROM call_item_scores cis
         JOIN call_scores cs ON cs.id = cis.call_score_id
        WHERE cis.id = $1 AND cs.call_id = $2`,
      [req.params.itemScoreId, call.id]
    );
    if (!itemScore) throw new AppError(404, 'Item score not found');

    const scoringSettings = await getScoringSettings(call.organization_id);
    const correctedNormalized = corrected_pass ? 100 : 0;
    const correctedRawScore = corrected_pass ? 1 : 0;
    const originalPass = isItemPass(Number(itemScore.normalized_score), scoringSettings.passThreshold);

    // Upsert correction record (unique on call_item_score_id)
    await query(
      `INSERT INTO score_corrections
         (organization_id, call_id, call_item_score_id, scorecard_item_id, corrected_by,
          original_score, corrected_score, original_pass, corrected_pass, reason, transcript_excerpt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (call_item_score_id) DO UPDATE SET
         corrected_score = EXCLUDED.corrected_score,
         corrected_pass = EXCLUDED.corrected_pass,
         reason = EXCLUDED.reason,
         corrected_by = EXCLUDED.corrected_by,
         created_at = now()`,
      [
        call.organization_id,
        call.id,
        itemScore.id,
        itemScore.scorecard_item_id,
        req.user!.userId,
        itemScore.normalized_score,
        correctedNormalized,
        originalPass,
        corrected_pass,
        reason || null,
        itemScore.evidence,
      ]
    );

    // Update the actual item score to reflect the correction
    await query(
      'UPDATE call_item_scores SET score = $1, normalized_score = $2 WHERE id = $3',
      [correctedRawScore, correctedNormalized, itemScore.id]
    );

    // Recalculate overall score for this call_score. Only pass/fail rows count
    // toward the weighted denominator — na / manual_review rows carry a NULL
    // normalized_score and must be excluded, or Number(null)=0 would drag them
    // in as zero-scored failures, deflating the overall and inventing breaches.
    const items = await query<{ normalized_score: string; weight: string; severity: string | null }>(
      `SELECT cis.normalized_score::text, si.weight::text, si.severity
         FROM call_item_scores cis
         JOIN scorecard_items si ON si.id = cis.scorecard_item_id
        WHERE cis.call_score_id = $1
          AND cis.result IN ('pass', 'fail')`,
      [itemScore.call_score_id]
    );
    let totalWeighted = 0;
    let totalWeight = 0;
    const failingSeverities: BreachSeverity[] = [];
    for (const it of items) {
      const w = Number(it.weight);
      const normalized = Number(it.normalized_score);
      totalWeighted += normalized * w;
      totalWeight += w;
      if (!isItemPass(normalized, scoringSettings.passThreshold)) failingSeverities.push(deriveSeverity(w, it.severity));
    }
    const newOverall = totalWeight > 0 ? totalWeighted / totalWeight : 0;
    // Use the same pass gate as initial scoring: a critical-severity failure
    // fails the call regardless of overall score, and the org's own pass
    // threshold (not a hardcoded 70) decides borderline items.
    const newPass = callPasses(newOverall, failingSeverities, scoringSettings.passThreshold);

    await query(
      'UPDATE call_scores SET overall_score = $1, pass = $2 WHERE id = $3',
      [newOverall, newPass, itemScore.call_score_id]
    );

    // Also update/create a breach record based on new state
    if (corrected_pass) {
      // Passing - delete any breach for this item score
      await query(
        'DELETE FROM breaches WHERE call_item_score_id = $1',
        [itemScore.id]
      );
    } else {
      // Failing - ensure breach exists (derive severity from item weight)
      const sItem = await queryOne<{ weight: string; severity: string | null }>(
        'SELECT weight::text, severity FROM scorecard_items WHERE id = $1',
        [itemScore.scorecard_item_id]
      );
      const w = sItem ? Number(sItem.weight) : 1;
      const severity = deriveSeverity(w, sItem?.severity);
      await query(
        `INSERT INTO breaches
           (organization_id, call_id, call_item_score_id, scorecard_item_id, severity, detected_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (call_item_score_id) DO NOTHING`,
        [call.organization_id, call.id, itemScore.id, itemScore.scorecard_item_id, severity]
      );
    }

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'score.correct',
      entityType: 'score',
      entityId: req.params.itemScoreId,
      summary: `Corrected scorecard item ${req.params.itemScoreId} on call ${req.params.id} to ${corrected_pass ? 'pass' : 'fail'}`,
      metadata: { call_id: req.params.id, corrected_pass, reason: reason || null, new_overall: newOverall, new_pass: newPass },
      req,
    });

    // A verdict corrected to a fail is a failure the firm may never have been
    // told about — the AI passed it, so no rule ever matched. Evaluate the
    // rules for this checkpoint now. A correction back to pass matches nothing,
    // and a checkpoint already alerted on is not announced twice (migration
    // 117). Fire-and-forget, after the writes.
    void evaluateAlertsForResolvedItem({
      kind: 'call',
      entityId: call.id,
      scorecardItemId: itemScore.scorecard_item_id,
    });

    res.json({ message: 'Correction saved', overall_score: newOverall, pass: newPass });
  } catch (err) {
    next(err);
  }
});

// Toggle exemplar (admin only)
callRouter.post('/:id/exemplar', requireActioner, async (req, res, next) => {
  try {
    const { is_exemplar, reason } = req.body;
    if (typeof is_exemplar !== 'boolean') {
      throw new AppError(400, 'is_exemplar must be boolean');
    }

    const result = await queryOne(
      `UPDATE calls SET
         is_exemplar = $1,
         exemplar_reason = CASE WHEN $1 THEN $2 ELSE NULL END,
         updated_at = now()
       WHERE id = $3 AND organization_id = $4
       RETURNING id`,
      [is_exemplar, reason || 'Manually marked by admin', req.params.id, req.user!.organizationId]
    );
    if (!result) throw new AppError(404, 'Call not found');

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'exemplar.toggle',
      entityType: 'call',
      entityId: req.params.id,
      summary: is_exemplar ? `Marked call ${req.params.id} as exemplar` : `Removed exemplar flag from call ${req.params.id}`,
      metadata: { is_exemplar, reason: reason || null },
      req,
    });

    res.json({ message: 'Exemplar flag updated' });
  } catch (err) {
    next(err);
  }
});
