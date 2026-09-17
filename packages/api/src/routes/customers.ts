import { Router } from 'express';
import { authenticate, requireOrgView, requireAdmin, requireActioner } from '../middleware/auth.js';
import { query, queryOne, withTransaction } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { normalizePhone } from '../services/ingestion.js';
import { recordAuditEvent } from '../services/audit.js';
import { getScoringSettings, scoresCallsIndividually } from '../services/tenant-settings.js';
import { hasFeature, effectivePlan } from '@callguard/shared';
import type {
  Plan,
  CustomerCompliance,
  CustomerProfileResponse,
  CustomerRecord,
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

// ── List customers ────────────────────────────────────────────────────────────
// Advisers see only customers from calls attributed to them.
// Supervisors/admins/viewers see all.

customersRouter.get('/', async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const role  = req.user!.role;
    const userId = req.user!.userId;

    const { search, page = '1', limit = '50' } = req.query as Record<string, string>;
    const offset = (Number(page) - 1) * Number(limit);

    const isAdviser = role === 'adviser';

    const params: unknown[] = [orgId];
    const conditions: string[] = ['c.organization_id = $1'];

    if (isAdviser) {
      params.push(userId);
      conditions.push(`c.id IN (
        SELECT DISTINCT customer_id FROM calls
        WHERE organization_id = $1 AND agent_id = $${params.length} AND customer_id IS NOT NULL
      )`);
    }

    if (search) {
      // Phone-ish input ("07700 900123", "+44 7700…") is normalised to match
      // the stored E.164 form — a raw ILIKE on "07700" would never match
      // "+447700…". Name searches pass through untouched.
      const digits = search.replace(/[\s()-]/g, '');
      const phoneSearch = /^\+?\d[\d\s()-]*$/.test(search.trim())
        ? (normalizePhone(digits) ?? digits)
        : search;
      params.push(`%${search}%`, `%${phoneSearch}%`);
      conditions.push(`(c.name ILIKE $${params.length - 1} OR c.phone_normalized ILIKE $${params.length})`);
    }

    const where = conditions.join(' AND ');

    const customers = await query<{
      id: string;
      phone_normalized: string;
      name: string | null;
      external_crm_id: string | null;
      first_seen_at: string;
      last_seen_at: string;
      call_count: number;
      journey_count: number;
      last_journey_score: string | null;
      last_journey_pass: boolean | null;
      last_journey_at: string | null;
    }>(
      // call_count is computed live rather than read from the denormalised
      // customers.call_count column: under the capture/journey model calls stay
      // 'captured'/'transcribed' (never per-call 'scored'), and that column is
      // only ever recomputed by the per-call scorer — so it reads 0 for
      // sales-only tenants. Count every real (non-failed) call instead.
      // Likewise customers.avg_score is dead under the journey model (scores
      // live on journeys) — surface the latest scored journey instead.
      `SELECT c.id, c.phone_normalized, c.name, c.external_crm_id,
              c.first_seen_at, c.last_seen_at,
              (SELECT COUNT(*) FROM calls ca
                WHERE ca.customer_id = c.id AND ca.status <> 'failed')::int AS call_count,
              (SELECT COUNT(*) FROM journeys j
                WHERE j.customer_id = c.id AND j.status = 'scored')::int AS journey_count,
              lj.overall_score AS last_journey_score,
              lj.pass          AS last_journey_pass,
              lj.scored_at     AS last_journey_at
         FROM customers c
         LEFT JOIN LATERAL (
           SELECT overall_score, pass, scored_at FROM journeys
            WHERE customer_id = c.id AND status = 'scored'
            ORDER BY scored_at DESC LIMIT 1
         ) lj ON true
        WHERE ${where}
        ORDER BY c.last_seen_at DESC
        LIMIT $${params.push(Number(limit))} OFFSET $${params.push(offset)}`,
      params
    );

    const countRow = await queryOne<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM customers c WHERE ${where}`,
      params.slice(0, params.length - 2)
    );

    res.json({
      customers,
      total: Number(countRow?.total ?? 0),
      page: Number(page),
      limit: Number(limit),
    });
  } catch (err) {
    next(err);
  }
});

// ── Customer profile ──────────────────────────────────────────────────────────

interface ComplianceRow {
  scored_sales: number;
  scored_calls: number;
  open_critical: number;
  open_high: number;
  open_medium: number;
  open_low: number;
  closed_critical: number;
  closed_high: number;
  closed_medium: number;
  closed_low: number;
  resolved: number;
  noted: number;
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
       COUNT(b.id) FILTER (WHERE b.status NOT IN ('resolved', 'noted') AND b.severity = 'critical')::int AS open_critical,
       COUNT(b.id) FILTER (WHERE b.status NOT IN ('resolved', 'noted') AND b.severity = 'high')::int AS open_high,
       COUNT(b.id) FILTER (WHERE b.status NOT IN ('resolved', 'noted') AND b.severity = 'medium')::int AS open_medium,
       COUNT(b.id) FILTER (WHERE b.status NOT IN ('resolved', 'noted') AND b.severity = 'low')::int AS open_low,
       COUNT(b.id) FILTER (WHERE b.status IN ('resolved', 'noted') AND b.severity = 'critical')::int AS closed_critical,
       COUNT(b.id) FILTER (WHERE b.status IN ('resolved', 'noted') AND b.severity = 'high')::int AS closed_high,
       COUNT(b.id) FILTER (WHERE b.status IN ('resolved', 'noted') AND b.severity = 'medium')::int AS closed_medium,
       COUNT(b.id) FILTER (WHERE b.status IN ('resolved', 'noted') AND b.severity = 'low')::int AS closed_low,
       COUNT(b.id) FILTER (WHERE b.status = 'resolved')::int AS resolved,
       COUNT(b.id) FILTER (WHERE b.status = 'noted')::int AS noted
     FROM breaches b
     LEFT JOIN calls c ON c.id = b.call_id
     LEFT JOIN journeys j ON j.id = b.journey_id
     WHERE b.organization_id = $2
       AND (c.customer_id = $1 OR j.customer_id = $1)`,
    [customerId, organizationId]
  );
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return {
    scored_sales: n(row?.scored_sales),
    scored_calls: n(row?.scored_calls),
    open: {
      critical: n(row?.open_critical),
      high: n(row?.open_high),
      medium: n(row?.open_medium),
      low: n(row?.open_low),
    },
    closed: {
      critical: n(row?.closed_critical),
      high: n(row?.closed_high),
      medium: n(row?.closed_medium),
      low: n(row?.closed_low),
    },
    resolved: n(row?.resolved),
    noted: n(row?.noted),
  };
}

customersRouter.get('/:id', async (req, res, next) => {
  try {
    const orgId  = req.user!.organizationId;
    const role   = req.user!.role;
    const userId = req.user!.userId;
    const isAdviser = role === 'adviser';

    const customer = await queryOne<CustomerRecord>(
      // Live call_count + journey outcomes (see the list query above for why
      // the denormalised call_count/avg_score columns are unreliable under the
      // capture/journey model). An adviser's call count is their own calls
      // with this customer ($3), not everyone's.
      `SELECT c.id, c.phone_normalized, c.name, c.external_crm_id,
              c.first_seen_at, c.last_seen_at,
              (SELECT COUNT(*) FROM calls ca
                WHERE ca.customer_id = c.id AND ca.status <> 'failed'
                  AND ($3::uuid IS NULL OR ca.agent_id = $3::uuid))::int AS call_count,
              (SELECT COUNT(*) FROM journeys j
                WHERE j.customer_id = c.id AND j.status = 'scored')::int AS journey_count,
              lj.overall_score AS last_journey_score,
              lj.pass          AS last_journey_pass,
              lj.scored_at     AS last_journey_at
         FROM customers c
         LEFT JOIN LATERAL (
           SELECT overall_score, pass, scored_at FROM journeys
            WHERE customer_id = c.id AND status = 'scored'
            ORDER BY scored_at DESC LIMIT 1
         ) lj ON true
        WHERE c.id = $1 AND c.organization_id = $2`,
      [req.params.id, orgId, isAdviser ? userId : null]
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

    const settings = await getScoringSettings(orgId);
    const mode: CustomerScoringMode = scoresCallsIndividually(settings) ? 'calls' : 'sales';

    // An adviser gets no findings and no sale result. Both describe the firm's
    // assessment of this customer across every adviser's calls — a sale is
    // credited to whoever closed it, and its breaches with it — and an adviser
    // is scoped to their own calls everywhere else (the sales list and the sale
    // page are closed to them). Withheld from the payload, not just hidden on
    // the page.
    const response: CustomerProfileResponse = isAdviser
      ? {
          customer: {
            ...customer,
            journey_count: null,
            last_journey_score: null,
            last_journey_pass: null,
            last_journey_at: null,
          },
          mode,
          compliance: null,
        }
      : { customer, mode, compliance: await loadCustomerCompliance(orgId, customer.id) };

    res.json(response);
  } catch (err) {
    next(err);
  }
});

// ── Customer journey (all calls chronologically) ──────────────────────────────

customersRouter.get('/:id/journey', requireOrgView, async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;

    const customer = await queryOne<{ id: string }>(
      'SELECT id FROM customers WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    );
    if (!customer) throw new AppError(404, 'Customer not found');

    const calls = await query<{
      id: string;
      call_date: string | null;
      created_at: string;
      agent_name: string | null;
      overall_score: number | null;
      pass: boolean | null;
      coaching_summary: string | null;
      breach_count: string;
    }>(
      `SELECT
         ca.id,
         ca.call_date,
         ca.created_at,
         ca.agent_name,
         ca.status,
         ca.duration_seconds,
         cs.overall_score,
         cs.pass,
         cs.coaching->>'summary' AS coaching_summary,
         COUNT(b.id)::text       AS breach_count
       FROM calls ca
       LEFT JOIN call_scores cs ON cs.call_id = ca.id
       LEFT JOIN breaches b     ON b.call_id = ca.id
       WHERE ca.customer_id = $1
         AND ca.organization_id = $2
       GROUP BY ca.id, ca.call_date, ca.created_at, ca.agent_name, ca.status,
                ca.duration_seconds, cs.overall_score, cs.pass, cs.coaching
       ORDER BY COALESCE(ca.call_date::timestamptz, ca.created_at) ASC`,
      [req.params.id, orgId]
    );

    res.json({ customer_id: req.params.id, calls });
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
