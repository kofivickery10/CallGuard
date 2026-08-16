import { Router } from 'express';
import { authenticate, requireOrgView, requireActioner, requireAdmin } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { assembleJourney } from '../services/journey.js';
import { recordAuditEvent } from '../services/audit.js';
import { getScoringSettings } from '../services/tenant-settings.js';
import { pushJourneyScoreUpdate } from '../services/score-writeback.js';
import { deriveSeverity, isItemPass, callPasses } from '@callguard/shared';
import type { Journey, JourneyItemScore, JourneyWithDetail, JourneyListItem, JourneyStatus, JourneyProduct, JourneyScoreRun, BreachSeverity } from '@callguard/shared';

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

// GET /api/journeys — paginated list of journeys for the org, newest first,
// optionally filtered by status or customer. This is the primary discovery
// surface for journey-mode tenants (the default scoring_mode).
journeysRouter.get('/', requireOrgView, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = (page - 1) * limit;

    const parts = ['j.organization_id = $1'];
    const params: unknown[] = [req.user!.organizationId];
    const status = req.query.status as string | undefined;
    // 'skipped' included: NTU sales are a real, filterable state (migration
    // 071). Omitting it here made ?status=skipped silently return everything,
    // which reads as a broken filter rather than an unsupported one.
    // Recorded by index rather than baked in, so the per-status counts below
    // can rebuild the same WHERE without it — each tab should show how many
    // sales you would get by clicking it, which means every OTHER filter
    // applies but the status itself does not.
    let statusPartIndex = -1;
    if (status && ['pending', 'scoring', 'scored', 'failed', 'skipped'].includes(status)) {
      params.push(status as JourneyStatus);
      parts.push(`j.status = $${params.length}`);
      statusPartIndex = parts.length - 1;
    }
    if (typeof req.query.customer_id === 'string') {
      params.push(req.query.customer_id);
      parts.push(`j.customer_id = $${params.length}`);
    }
    // Branch, so a compliance manager can look at (say) every referred sale.
    // Validated against what is actually in use rather than a fixed list —
    // branches are per-tenant scorecard configuration, not a system enum.
    if (typeof req.query.branch === 'string' && req.query.branch.trim()) {
      params.push(req.query.branch.trim());
      parts.push(`j.branch = $${params.length}`);
    }
    // Pass/fail. Only meaningful on a scored sale — pass is NULL until then, so
    // this implicitly narrows to scored without needing both filters set.
    const result = typeof req.query.result === 'string' ? req.query.result : '';
    if (result === 'pass' || result === 'fail') {
      parts.push(`j.pass IS ${result === 'pass' ? 'TRUE' : 'FALSE'}`);
    }
    // Date range on when the SALE happened, not when it was scored. Filtering on
    // scored_at meant "sales in the first week of July" silently included an
    // April sale re-scored in July and excluded a July sale scored late, which
    // is the opposite of what the filter appears to promise.
    if (typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)) {
      params.push(req.query.from);
      parts.push(`${SALE_DATE_SQL} >= $${params.length}::date`);
    }
    if (typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
      params.push(req.query.to);
      parts.push(`${SALE_DATE_SQL} < ($${params.length}::date + INTERVAL '1 day')`);
    }
    // Filter by the sale's closing adviser. Matched on the RESOLVED name (the
    // linked user's name where the call is linked, else the raw dialler string)
    // rather than on agent_id: a large share of calls arrive unlinked because
    // the dialler sends a short display name, and an id filter would silently
    // drop every one of those sales. Matching what the column actually shows
    // keeps the filter and the list consistent with each other.
    const agent = typeof req.query.agent === 'string' ? req.query.agent.trim() : '';
    if (agent) {
      params.push(agent);
      parts.push(`(
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
      ) = $${params.length}`);
    }
    const whereSQL = parts.join(' AND ');
    const whereWithoutStatus = parts.filter((_, i) => i !== statusPartIndex).join(' AND ');

    const countRow = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM journeys j WHERE ${whereSQL}`,
      params
    );

    // One grouped scan rather than a query per tab. The status parameter is
    // still bound (params is shared) but unused by this statement, which
    // Postgres allows.
    const statusRows = await query<{ status: JourneyStatus; count: string }>(
      `SELECT j.status, COUNT(*)::text AS count FROM journeys j
        WHERE ${whereWithoutStatus} GROUP BY j.status`,
      params
    );
    const counts = statusRows.reduce<Record<string, number>>(
      (acc, r) => ({ ...acc, [r.status]: parseInt(r.count, 10) }),
      {}
    );
    counts.all = Object.values(counts).reduce((a, b) => a + b, 0);

    const rows = await query<JourneyListItem>(
      `SELECT j.*,
              ${SALE_DATE_SQL} AS sale_date,
              -- How many times this sale has been scored. >1 tells a reviewer
              -- the score they are looking at replaced an earlier one, which
              -- matters when the earlier one was already fed back to an adviser.
              (SELECT COUNT(*)::int FROM journey_score_runs jsr
                WHERE jsr.journey_id = j.id) AS score_runs,
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
        WHERE ${whereSQL}
        -- By when the sale happened, so a re-score never moves a row and a
        -- backfill lands in its own history rather than on top of today's.
        -- created_at breaks the tie for two sales closed on the same call.
        ORDER BY ${SALE_DATE_SQL} DESC, j.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    // SELECT j.* pulls the server-only trigger_context (raw Zoho payload, can
    // carry PII) — strip it from every row before responding.
    const data = (rows as Array<JourneyListItem & { trigger_context?: unknown }>).map(
      ({ trigger_context: _t, ...r }) => r as JourneyListItem
    );

    res.json({ data, total: parseInt(countRow?.count || '0'), page, limit, counts });
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

    const itemScores = await query<JourneyItemScore & { label: string; section: string | null; severity: string | null; applies_to_products: string[] | null }>(
      `SELECT jis.*, si.label, si.section, si.severity, si.applies_to_products
         FROM journey_item_scores jis
         JOIN scorecard_items si ON si.id = jis.scorecard_item_id
        WHERE jis.journey_id = $1
        ORDER BY si.sort_order`,
      [journey.id]
    );

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

    res.json({ message: 'Correction saved', overall_score: newOverall, pass: newPass });
  } catch (err) {
    next(err);
  }
});
