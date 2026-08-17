import { Router } from 'express';
import { authenticate, requireOrgView } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { CALL_IS_SCORED, classifyRisk, recommendAction } from './dashboard.js';
import { SALE_DATE_SQL } from './journeys.js';
import type {
  AdviserRisk,
  BoardPackResponse,
  BoardPackOutcomesWindow,
  BoardPackConsumerDutyOutcomeCount,
  BreachSeverity,
  ConsumerDutyOutcome,
} from '@callguard/shared';

export const boardPackRouter = Router();
boardPackRouter.use(authenticate);

// ============================================================
// GET /api/board-pack
//
// A single evidence pack for a compliance committee / board sign-off over a
// period, optionally narrowed to one product (org-wide, so advisers — who are
// self-scoped everywhere else — are excluded by requireOrgView below, same as
// every other report route in the app).
//
// Reuses the app's existing "what does this figure mean" decisions rather
// than re-deriving them: CALL_IS_SCORED (dashboard.ts's "scored unit" rule),
// SALE_DATE_SQL (journeys.ts's "when did this sale happen" rule), and
// classifyRisk / recommendAction (dashboard.ts's adviser-risk classification).
// ============================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parsePeriod(req: { query: Record<string, unknown> }): { from: string; to: string } {
  const from = req.query.from;
  const to = req.query.to;
  if (typeof from !== 'string' || !DATE_RE.test(from)) {
    throw new AppError(400, 'from is required (YYYY-MM-DD)');
  }
  if (typeof to !== 'string' || !DATE_RE.test(to)) {
    throw new AppError(400, 'to is required (YYYY-MM-DD)');
  }
  if (to < from) {
    throw new AppError(400, 'to must not be before from');
  }
  return { from, to };
}

// The immediately preceding period of equal length (inclusive day counts), so
// "how does this period compare" never has to explain a mismatched window.
function previousPeriod(from: string, to: string): { from: string; to: string } {
  const dayMs = 24 * 60 * 60 * 1000;
  const fromMs = new Date(`${from}T00:00:00Z`).getTime();
  const toMs = new Date(`${to}T00:00:00Z`).getTime();
  const lengthDays = Math.round((toMs - fromMs) / dayMs) + 1;
  const prevToMs = fromMs - dayMs;
  const prevFromMs = fromMs - lengthDays * dayMs;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(prevFromMs), to: iso(prevToMs) };
}

// Scored units (latest per-call score UNION each scored journey dated into
// the window) — the same union dashboard.ts's /summary builds, but bounded to
// an explicit [from, to) range instead of "since now()". `includeCalls` is
// false while a product filter is active: calls carry no product
// attribution, so they're left out of a product-scoped slice rather than
// silently mixed in as unfiltered noise.
function scoredUnitsSQL(includeCalls: boolean, productParamIdx: number | null): string {
  const journeyProductClause =
    productParamIdx != null
      ? ` AND EXISTS (SELECT 1 FROM journey_products jp WHERE jp.journey_id = j.id AND jp.product_id = $${productParamIdx})`
      : '';
  const callsBranch = includeCalls
    ? `
      SELECT latest.overall_score AS score, latest.pass AS pass
      FROM (
        SELECT DISTINCT ON (cs.call_id) cs.overall_score, cs.pass
        FROM call_scores cs
        JOIN calls c ON c.id = cs.call_id
        WHERE c.organization_id = $1
          AND cs.scored_at >= $2::date AND cs.scored_at < ($3::date + interval '1 day')
        ORDER BY cs.call_id, cs.scored_at DESC
      ) latest
      UNION ALL
    `
    : '';
  return `
    ${callsBranch}
    SELECT j.overall_score AS score, j.pass AS pass
    FROM journeys j
    WHERE j.organization_id = $1 AND j.status = 'scored'
      AND ${SALE_DATE_SQL} >= $2::date AND ${SALE_DATE_SQL} < ($3::date + interval '1 day')
      ${journeyProductClause}
  `;
}

boardPackRouter.get('/', requireOrgView, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const { from, to } = parsePeriod(req);
    const prev = previousPeriod(from, to);

    const rawProduct = req.query.product;
    const productId = typeof rawProduct === 'string' && rawProduct.trim() ? rawProduct.trim() : null;
    if (productId && !UUID_RE.test(productId)) {
      throw new AppError(400, 'product must be a product id');
    }

    let product: { id: string; name: string } | null = null;
    if (productId) {
      const row = await queryOne<{ id: string; name: string }>(
        'SELECT id, name FROM products WHERE id = $1 AND organization_id = $2',
        [productId, orgId]
      );
      if (!row) throw new AppError(404, 'Product not found');
      product = row;
    }

    const org = await queryOne<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [orgId]);

    // journey_products EXISTS clause params, appended after [orgId, from, to]
    // on any journey-scoped query that needs it.
    const journeyProductParams = productId ? [productId] : [];
    const journeyProductClause = productId
      ? ` AND EXISTS (SELECT 1 FROM journey_products jp WHERE jp.journey_id = j.id AND jp.product_id = $4)`
      : '';
    // Same clause but keyed to a breach's journey_id (findings/action-taken
    // queries join breaches, not journeys, as their base table). When a
    // product filter is active, call-level breaches (journey_id NULL) are
    // excluded from these slices — they carry no product attribution.
    const breachProductClause = productId
      ? ` AND b.journey_id IS NOT NULL AND EXISTS (SELECT 1 FROM journey_products jp WHERE jp.journey_id = b.journey_id AND jp.product_id = $4)`
      : '';

    // ── 1. Monitoring coverage ──────────────────────────────────────────
    const callCoverageRow = await queryOne<{ total: string; scored: string }>(
      `SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE ${CALL_IS_SCORED})::text AS scored
         FROM calls c
        WHERE c.organization_id = $1
          AND c.created_at >= $2::date AND c.created_at < ($3::date + interval '1 day')`,
      [orgId, from, to]
    );
    const callsNotScoredRows = await query<{ status: string; count: string }>(
      `SELECT c.status, COUNT(*)::text AS count
         FROM calls c
        WHERE c.organization_id = $1
          AND c.created_at >= $2::date AND c.created_at < ($3::date + interval '1 day')
          AND NOT (${CALL_IS_SCORED})
        GROUP BY c.status
        ORDER BY COUNT(*) DESC`,
      [orgId, from, to]
    );
    const journeyStatusRows = await query<{ status: string; count: string }>(
      `SELECT j.status, COUNT(*)::text AS count
         FROM journeys j
        WHERE j.organization_id = $1
          AND ${SALE_DATE_SQL} >= $2::date AND ${SALE_DATE_SQL} < ($3::date + interval '1 day')
          ${journeyProductClause}
        GROUP BY j.status`,
      [orgId, from, to, ...journeyProductParams]
    );
    const salesScored = parseInt(journeyStatusRows.find((r) => r.status === 'scored')?.count || '0', 10);

    // ── 2. Outcomes ──────────────────────────────────────────────────────
    const currentOutcomesRow = await queryOne<{
      total: string;
      avg_score: string | null;
      pass_count: string;
      band_90: string;
      band_80: string;
      band_70: string;
      band_60: string;
      band_below_60: string;
    }>(
      `WITH scored AS (${scoredUnitsSQL(!productId, productId ? 4 : null)})
       SELECT
         COUNT(*)::text AS total,
         AVG(score) AS avg_score,
         COUNT(*) FILTER (WHERE pass = true)::text AS pass_count,
         COUNT(*) FILTER (WHERE score >= 90)::text AS band_90,
         COUNT(*) FILTER (WHERE score >= 80 AND score < 90)::text AS band_80,
         COUNT(*) FILTER (WHERE score >= 70 AND score < 80)::text AS band_70,
         COUNT(*) FILTER (WHERE score >= 60 AND score < 70)::text AS band_60,
         COUNT(*) FILTER (WHERE score < 60)::text AS band_below_60
       FROM scored`,
      [orgId, from, to, ...journeyProductParams]
    );
    const previousOutcomesRow = await queryOne<{ total: string; avg_score: string | null; pass_count: string }>(
      `SELECT
         COUNT(*)::text AS total,
         AVG(u.score) AS avg_score,
         COUNT(*) FILTER (WHERE u.pass = true)::text AS pass_count
       FROM (${scoredUnitsSQL(!productId, productId ? 4 : null)}) u`,
      [orgId, prev.from, prev.to, ...journeyProductParams]
    );

    const buildWindow = (
      period: { from: string; to: string },
      row: { total: string; avg_score: string | null; pass_count: string } | null
    ): BoardPackOutcomesWindow => {
      const total = parseInt(row?.total || '0', 10);
      return {
        period,
        total_scored: total,
        average_score: row?.avg_score != null ? parseFloat(row.avg_score) : null,
        pass_rate: total > 0 ? (parseInt(row?.pass_count || '0', 10) / total) * 100 : null,
      };
    };

    // ── 3. Findings by severity ─────────────────────────────────────────
    const severityRows = await query<{ severity: BreachSeverity; count: string }>(
      `SELECT b.severity, COUNT(*)::text AS count
         FROM breaches b
        WHERE b.organization_id = $1
          AND b.detected_at >= $2::date AND b.detected_at < ($3::date + interval '1 day')
          ${breachProductClause}
        GROUP BY b.severity`,
      [orgId, from, to, ...journeyProductParams]
    );

    // ── 4. Findings by theme (the firm's own scorecard sections) ───────
    const themeRows = await query<{ section: string | null; count: string }>(
      `SELECT si.section, COUNT(*)::text AS count
         FROM breaches b
         JOIN scorecard_items si ON si.id = b.scorecard_item_id
        WHERE b.organization_id = $1
          AND b.detected_at >= $2::date AND b.detected_at < ($3::date + interval '1 day')
          ${breachProductClause}
        GROUP BY si.section
        ORDER BY COUNT(*) DESC`,
      [orgId, from, to, ...journeyProductParams]
    );

    // ── 4b. Findings by Consumer Duty outcome ───────────────────────────
    // Same population and product scoping as the theme query above, grouped
    // by the checkpoint's tagged outcome instead of its section. A checkpoint
    // nobody has tagged (consumer_duty_outcome IS NULL — the default for
    // every scorecard until migration 101) groups under NULL here, which is
    // rendered below as an explicit "Unmapped" bucket rather than dropped.
    const consumerDutyRows = await query<{ consumer_duty_outcome: ConsumerDutyOutcome | null; count: string }>(
      `SELECT si.consumer_duty_outcome, COUNT(*)::text AS count
         FROM breaches b
         JOIN scorecard_items si ON si.id = b.scorecard_item_id
        WHERE b.organization_id = $1
          AND b.detected_at >= $2::date AND b.detected_at < ($3::date + interval '1 day')
          ${breachProductClause}
        GROUP BY si.consumer_duty_outcome
        ORDER BY COUNT(*) DESC`,
      [orgId, from, to, ...journeyProductParams]
    );

    // ── 4c. Vulnerability ────────────────────────────────────────────────
    // Vulnerability is a cross-cutting Consumer Duty consideration, not a
    // fifth outcome (see ScorecardItem.vulnerability_related), so it is
    // counted independently of findings_by_consumer_duty above rather than
    // as one more bucket in that grouping.
    const vulnerabilityRow = await queryOne<{ total: string; vulnerability_related: string }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE si.vulnerability_related)::text AS vulnerability_related
         FROM breaches b
         JOIN scorecard_items si ON si.id = b.scorecard_item_id
        WHERE b.organization_id = $1
          AND b.detected_at >= $2::date AND b.detected_at < ($3::date + interval '1 day')
          ${breachProductClause}`,
      [orgId, from, to, ...journeyProductParams]
    );

    // ── 5. Human oversight ───────────────────────────────────────────────
    // Journeys: score_corrections carries both pathways (manual-review
    // resolution AND an explicit override of a confident verdict) for sales,
    // keyed by whether the AI had a verdict to overturn (migration 077).
    const journeyOversightRow = await queryOne<{ ai_declined: string; human_overturned: string; total: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE sc.original_pass IS NULL)::text AS ai_declined,
         COUNT(*) FILTER (WHERE sc.original_pass IS NOT NULL)::text AS human_overturned,
         COUNT(*)::text AS total
         FROM score_corrections sc
        WHERE sc.organization_id = $1 AND sc.journey_id IS NOT NULL
          AND sc.created_at >= $2::date AND sc.created_at < ($3::date + interval '1 day')
          ${productId ? 'AND EXISTS (SELECT 1 FROM journey_products jp WHERE jp.journey_id = sc.journey_id AND jp.product_id = $4)' : ''}`,
      [orgId, from, to, ...journeyProductParams]
    );

    // Calls: resolving a manual-review call checkpoint (routes/review.ts,
    // resolveCallItem) never writes score_corrections — only the journey path
    // does. So "AI declined, human decided" for a call only exists as an
    // audit_log trail; "human overturned a confident verdict" (the separate
    // /calls/:id/scores/items/:itemScoreId/correct endpoint) does write
    // score_corrections with call_id set. The two are read from different
    // places and are not additive into one "total resolved" for calls — see
    // asymmetry_note below.
    const callDeclinedRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM audit_log al
        WHERE al.organization_id = $1
          AND al.action_type = 'review.resolve'
          AND al.metadata->>'kind' = 'call'
          AND al.created_at >= $2::date AND al.created_at < ($3::date + interval '1 day')`,
      [orgId, from, to]
    );
    const callOverturnedRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM score_corrections sc
        WHERE sc.organization_id = $1 AND sc.call_id IS NOT NULL
          AND sc.created_at >= $2::date AND sc.created_at < ($3::date + interval '1 day')`,
      [orgId, from, to]
    );

    const confirmedRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM breaches b
        WHERE b.organization_id = $1 AND b.confirmed_at IS NOT NULL
          AND b.confirmed_at >= $2::date AND b.confirmed_at < ($3::date + interval '1 day')
          ${breachProductClause}`,
      [orgId, from, to, ...journeyProductParams]
    );

    // ── 6. Advisers needing attention ───────────────────────────────────
    // Same breach->agent attribution and risk classification as
    // GET /dashboard/adviser-risk (breach's evidenced source call, falling
    // back to the journey's wrap-up agent is NOT used here — this mirrors
    // that endpoint's own attribution, not breaches.ts's JOURNEY_AGENT_JOIN),
    // just bounded to an explicit period instead of "last N days". Not
    // narrowed by product — a breach's agent attribution is independent of
    // which product the sale covered, and advisers work across products.
    const adviserRows = await query<{
      agent_id: string;
      agent_name: string;
      email: string;
      critical: string;
      high: string;
      medium: string;
      low: string;
      total_calls: string;
      scored_calls: string;
      top_breach_label: string | null;
    }>(
      `WITH breach_agents AS (
         SELECT b.id, b.severity, b.scorecard_item_id,
                COALESCE(c.agent_id, srccall.agent_id) as agent_id
           FROM breaches b
           LEFT JOIN calls c ON c.id = b.call_id
           LEFT JOIN journey_item_scores jis ON jis.id = b.journey_item_score_id
           LEFT JOIN calls srccall ON srccall.id = jis.source_call_id
          WHERE b.organization_id = $1
            AND b.detected_at >= $2::date AND b.detected_at < ($3::date + interval '1 day')
       ),
       bc AS (
         SELECT
           u.id as agent_id,
           u.name as agent_name,
           u.email,
           (SELECT COUNT(*) FROM breach_agents ba WHERE ba.agent_id = u.id AND ba.severity = 'critical')::text as critical,
           (SELECT COUNT(*) FROM breach_agents ba WHERE ba.agent_id = u.id AND ba.severity = 'high')::text as high,
           (SELECT COUNT(*) FROM breach_agents ba WHERE ba.agent_id = u.id AND ba.severity = 'medium')::text as medium,
           (SELECT COUNT(*) FROM breach_agents ba WHERE ba.agent_id = u.id AND ba.severity = 'low')::text as low,
           COUNT(DISTINCT c.id)::text as total_calls,
           COUNT(DISTINCT c.id) FILTER (WHERE ${CALL_IS_SCORED})::text as scored_calls
         FROM users u
         LEFT JOIN calls c ON c.agent_id = u.id
           AND c.created_at >= $2::date AND c.created_at < ($3::date + interval '1 day')
         WHERE u.organization_id = $1 AND u.role = 'adviser'
         GROUP BY u.id
       ),
       agent_breach_counts AS (
         SELECT ba.agent_id, si.label, COUNT(*) as n
           FROM breach_agents ba
           JOIN scorecard_items si ON si.id = ba.scorecard_item_id
          WHERE ba.agent_id IS NOT NULL
            AND ba.severity IN ('critical','high','medium')
          GROUP BY ba.agent_id, si.label
       ),
       top_breaches AS (
         SELECT DISTINCT ON (agent_id) agent_id, label as top_breach_label
           FROM agent_breach_counts
          ORDER BY agent_id, n DESC
       )
       SELECT bc.*, tb.top_breach_label
         FROM bc
         LEFT JOIN top_breaches tb ON tb.agent_id = bc.agent_id
        ORDER BY
          (bc.critical::int * 10 + bc.high::int * 3 + bc.medium::int) DESC,
          bc.agent_name`,
      [orgId, from, to]
    );

    const advisersNeedingAttention: AdviserRisk[] = adviserRows
      .map((r) => {
        const critical = parseInt(r.critical, 10);
        const high = parseInt(r.high, 10);
        const medium = parseInt(r.medium, 10);
        const low = parseInt(r.low, 10);
        const risk_level = classifyRisk(critical, high, medium, low);
        return {
          agent_id: r.agent_id,
          agent_name: r.agent_name,
          email: r.email,
          critical,
          high,
          medium,
          low,
          total_calls: parseInt(r.total_calls, 10),
          scored_calls: parseInt(r.scored_calls, 10),
          top_breach_label: r.top_breach_label,
          risk_level,
          recommended_action: recommendAction(risk_level, r.top_breach_label),
        };
      })
      // "Needing attention" — a clean record carries nothing for a board to act on.
      .filter((a) => a.risk_level !== 'compliant');

    // Note on attribution: this pack does not use breaches.ts's
    // JOURNEY_AGENT_JOIN (wrap-up/closing agent) anywhere — nothing here
    // lists individual breaches by name, only aggregates. The one section
    // that needs adviser attribution (6, above) mirrors
    // GET /dashboard/adviser-risk's own evidenced-source-call attribution
    // instead, per the brief for that section, rather than introducing a
    // second attribution rule.

    // ── 7. Action taken ─────────────────────────────────────────────────
    const statusRows = await query<{ status: string; count: string }>(
      `SELECT b.status, COUNT(*)::text AS count
         FROM breaches b
        WHERE b.organization_id = $1
          AND b.detected_at >= $2::date AND b.detected_at < ($3::date + interval '1 day')
          ${breachProductClause}
        GROUP BY b.status`,
      [orgId, from, to, ...journeyProductParams]
    );
    const resolutionRow = await queryOne<{ n: string; median_hours: string | null; mean_hours: string | null }>(
      `SELECT
         COUNT(*)::text AS n,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (b.resolved_at - b.detected_at)) / 3600)::text AS median_hours,
         AVG(EXTRACT(EPOCH FROM (b.resolved_at - b.detected_at)) / 3600)::text AS mean_hours
         FROM breaches b
        WHERE b.organization_id = $1 AND b.status = 'resolved' AND b.resolved_at IS NOT NULL
          AND b.resolved_at >= $2::date AND b.resolved_at < ($3::date + interval '1 day')
          ${breachProductClause}`,
      [orgId, from, to, ...journeyProductParams]
    );

    // ── Methodology / limitations ───────────────────────────────────────
    const methodology: string[] = [
      "Findings are grouped under the firm's own scorecard sections (this scorecard's own headings, e.g. Disclosure, Suitability, Affordability) in findings_by_theme — not an FCA or Consumer Duty outcomes taxonomy, and CallGuard never renames or infers one onto these headings. A separate grouping, findings_by_consumer_duty, uses the Consumer Duty outcome (products and services; price and value; consumer understanding; consumer support) explicitly tagged on each checkpoint by an admin. That tagging is opt-in per checkpoint: any checkpoint nobody has tagged appears under an explicit \"Unmapped\" bucket there rather than being guessed at, dropped, or folded into an outcome it was not assigned.",
      "Vulnerability (vulnerability field below) counts findings on checkpoints a person has explicitly marked vulnerability_related. Vulnerability is a cross-cutting Consumer Duty consideration, not a fifth outcome, so it is tracked separately from findings_by_consumer_duty rather than as one more bucket within it. This remains scorecard-dependent: a scorecard with no vulnerability-tagged checkpoint will show zero here, which reflects a gap in the scorecard's tagging, not evidence that no vulnerable customers were served.",
      'The pass threshold in force at the time of scoring is not stored against each individual score. If the threshold has changed since a score was produced, that score\'s pass/fail cannot be re-derived at the old or the new threshold — the pass/fail shown is the one recorded at scoring time.',
      'Per-call scores are replaced on re-score, not versioned, so call-level figures reflect current verdicts, not necessarily the verdict a customer conversation or coaching session was originally based on. Sale (journey) scores keep a full run history and do not share this limitation.',
      "Reconciliation outcomes recorded as 'undetermined' mean the system could not establish an answer (most often redaction removing the words needed to identify a question) — deliberately not counted as a failure.",
      // TODO(partial-journey-coverage): once Phase 2 ships (false-positive
      // measurement approved per docs/partial-journey-detection.md §6), add a
      // limitations bullet here disclosing journeys.coverage — how many
      // scored sales in the period were judged 'partial' (evidence looks like
      // it starts mid-conversation, i.e. an earlier call was likely never
      // captured) vs 'unknown' vs 'complete'. Deliberately not surfaced
      // anywhere user-facing yet; see migration 100_journey_coverage.sql.
    ];

    const response: BoardPackResponse = {
      organization_name: org?.name || 'Organisation',
      period: { from, to },
      product,
      product_scope_note: product
        ? `Filtered to ${product.name}. Sale-level figures (sales scored, outcomes, findings, sale-side human oversight, action taken) are narrowed to sales that included this product. Calls carry no product attribution in CallGuard, so call-level figures — monitoring coverage's call counts and the calls side of human oversight — cover the whole organisation for the period rather than this product alone.`
        : null,
      generated_at: new Date().toISOString(),

      coverage: {
        calls_ingested: parseInt(callCoverageRow?.total || '0', 10),
        calls_scored: parseInt(callCoverageRow?.scored || '0', 10),
        calls_not_scored_by_status: callsNotScoredRows.map((r) => ({ status: r.status, count: parseInt(r.count, 10) })),
        sales_scored: salesScored,
        sales_not_scored_by_status: journeyStatusRows
          .filter((r) => r.status !== 'scored')
          .map((r) => ({ status: r.status, count: parseInt(r.count, 10) })),
      },

      outcomes: {
        current: buildWindow({ from, to }, currentOutcomesRow),
        previous: buildWindow(prev, previousOutcomesRow),
        distribution: currentOutcomesRow
          ? [
              { band: '90-100', count: parseInt(currentOutcomesRow.band_90, 10) },
              { band: '80-89', count: parseInt(currentOutcomesRow.band_80, 10) },
              { band: '70-79', count: parseInt(currentOutcomesRow.band_70, 10) },
              { band: '60-69', count: parseInt(currentOutcomesRow.band_60, 10) },
              { band: '<60', count: parseInt(currentOutcomesRow.band_below_60, 10) },
            ]
          : [],
      },

      findings_by_severity: severityRows.map((r) => ({ severity: r.severity, count: parseInt(r.count, 10) })),

      findings_by_theme: {
        note: "Grouped by this firm's own scorecard sections, not an FCA or Consumer Duty outcomes taxonomy.",
        sections: themeRows.map((r) => ({ section: r.section, count: parseInt(r.count, 10) })),
      },

      findings_by_consumer_duty: {
        note:
          'Grouped by the Consumer Duty outcome explicitly tagged on each checkpoint. "Unmapped" (outcome: null) is a checkpoint nobody has tagged yet, shown here rather than dropped or guessed at — it is not a fifth outcome.',
        outcomes: consumerDutyRows.map(
          (r): BoardPackConsumerDutyOutcomeCount => ({
            outcome: r.consumer_duty_outcome,
            count: parseInt(r.count, 10),
          })
        ),
      },

      vulnerability: {
        vulnerability_related_findings: parseInt(vulnerabilityRow?.vulnerability_related || '0', 10),
        total_findings: parseInt(vulnerabilityRow?.total || '0', 10),
        note:
          'Findings on checkpoints explicitly tagged vulnerability_related — a cross-cutting Consumer Duty consideration, not one of the four outcomes above. Scorecard-dependent: zero here means no tagged checkpoint fired, not that no vulnerable customers were served.',
      },

      human_oversight: {
        journeys: {
          total_resolved: parseInt(journeyOversightRow?.total || '0', 10),
          ai_declined: parseInt(journeyOversightRow?.ai_declined || '0', 10),
          human_overturned: parseInt(journeyOversightRow?.human_overturned || '0', 10),
        },
        calls: {
          ai_declined_resolved: parseInt(callDeclinedRow?.n || '0', 10),
          human_overturned: parseInt(callOverturnedRow?.n || '0', 10),
          note:
            "Call-level human review is recorded far less richly than sale-level review. Sales keep a calibration record (score_corrections) that distinguishes the AI declining to decide from a human overturning a confident verdict; for calls, only 'AI declined, human decided' is recoverable (from the review audit trail) and 'human overturned a confident verdict' is a separate, differently-sourced count. The two call figures are not additive into one total, and neither carries the reasoning detail the sale-level record does.",
        },
        breaches_confirmed_by_human: parseInt(confirmedRow?.n || '0', 10),
        asymmetry_note:
          'See calls.note above — this section is not symmetric between sale-scored and call-scored tenants, and should not be read as though it were.',
      },

      advisers_needing_attention: advisersNeedingAttention,

      action_taken: {
        by_status: statusRows.map((r) => ({ status: r.status, count: parseInt(r.count, 10) })),
        resolution_time: {
          n: parseInt(resolutionRow?.n || '0', 10),
          median_hours: resolutionRow?.median_hours != null ? parseFloat(resolutionRow.median_hours) : null,
          mean_hours: resolutionRow?.mean_hours != null ? parseFloat(resolutionRow.mean_hours) : null,
        },
      },

      methodology,
    };

    res.json(response);
  } catch (err) {
    next(err);
  }
});
