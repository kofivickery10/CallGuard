import { query } from '../db/client.js';
import { SEAT_PRICING, effectivePlan } from '@callguard/shared';
import type { Plan } from '@callguard/shared';

// Billing is headcount-based: a billable seat is any tenant user who isn't
// billing_exempt (every role except the platform superadmin), in an active org.
// The seat bills on presence — whether or not that user handled any calls.

// Monthly revenue for one billable seat. A negotiated per-tenant override bills
// every seat at that flat rate; otherwise the seat's effective tier (org plan,
// bumped by any per-user plan_override) sets the price.
export function seatPrice(
  orgPlan: string,
  override: number | null,
  planOverride: string | null
): number {
  if (override != null) return Number(override);
  const tier = effectivePlan(orgPlan as Plan, (planOverride ?? null) as Plan | null);
  return SEAT_PRICING[tier] ?? 0;
}

export interface BillableSeatRow {
  org_id: string;
  org_plan: string;
  seat_price_override: string | null;
  plan_override: string | null;
}

// One row per billable seat across all active orgs.
export async function billableSeatRows(): Promise<BillableSeatRow[]> {
  return query<BillableSeatRow>(
    `SELECT o.id AS org_id, o.plan AS org_plan, o.seat_price_override, u.plan_override
       FROM organizations o
       JOIN users u ON u.organization_id = o.id
      WHERE o.status = 'active'
        AND u.role != 'superadmin'
        AND NOT u.billing_exempt`
  );
}

export interface OrgBilling {
  seatCount: number;
  total: number;
  orgPlan: string;
  seatPriceOverride: number | null;
}

// Aggregate seat rows into per-org { seatCount, total }. Pure — unit-tested.
export function aggregateByOrg(rows: BillableSeatRow[]): Map<string, OrgBilling> {
  const byOrg = new Map<string, OrgBilling>();
  for (const r of rows) {
    const override = r.seat_price_override == null ? null : Number(r.seat_price_override);
    const price = seatPrice(r.org_plan, override, r.plan_override);
    const cur =
      byOrg.get(r.org_id) ??
      { seatCount: 0, total: 0, orgPlan: r.org_plan, seatPriceOverride: override };
    cur.seatCount += 1;
    cur.total += price;
    byOrg.set(r.org_id, cur);
  }
  return byOrg;
}

// Total platform MRR from current headcount.
export function mrrFromRows(rows: BillableSeatRow[]): number {
  let mrr = 0;
  for (const b of aggregateByOrg(rows).values()) mrr += b.total;
  return mrr;
}

export interface MonthBilling {
  seatCount: number;
  total: number;
}

// Live billing per org from current headcount (used for the current month and
// as a fallback for a just-ended month not yet frozen).
async function liveBillingByOrg(): Promise<Map<string, MonthBilling>> {
  const out = new Map<string, MonthBilling>();
  for (const [orgId, b] of aggregateByOrg(await billableSeatRows())) {
    out.set(orgId, { seatCount: b.seatCount, total: b.total });
  }
  return out;
}

// Billing for a given month, per org. The current (not-yet-frozen) month is
// computed live from current headcount; a past month is read from the frozen
// ledger (billing_periods) so re-scores/purges/plan-changes can't rewrite
// history. `monthStart` is 'YYYY-MM-DD' (first of month). `live` forces the
// current-headcount path; `liveFallback` uses it only when the ledger has no
// rows yet — i.e. the just-ended month before the daily snapshot has frozen it,
// so it doesn't read as £0 for up to a day after month close.
export async function billingForMonth(
  monthStart: string,
  opts: { live: boolean; liveFallback?: boolean }
): Promise<Map<string, MonthBilling>> {
  if (opts.live) return liveBillingByOrg();
  const rows = await query<{ organization_id: string; seat_count: number; total: string }>(
    `SELECT organization_id, seat_count, total FROM billing_periods WHERE period_month = $1`,
    [monthStart]
  );
  if (rows.length === 0 && opts.liveFallback) return liveBillingByOrg();
  const out = new Map<string, MonthBilling>();
  for (const r of rows) out.set(r.organization_id, { seatCount: r.seat_count, total: Number(r.total) });
  return out;
}

// One org's frozen monthly billing history (last 12 months), keyed by 'YYYY-MM'.
// The current month is not included here (it isn't frozen yet) — callers append
// it live.
export async function billingHistoryForOrg(orgId: string): Promise<Map<string, MonthBilling>> {
  const rows = await query<{ month: string; seat_count: number; total: string }>(
    `SELECT to_char(period_month, 'YYYY-MM') AS month, seat_count, total
       FROM billing_periods
      WHERE organization_id = $1
        AND period_month >= date_trunc('month', now()) - interval '12 months'`,
    [orgId]
  );
  const out = new Map<string, MonthBilling>();
  for (const r of rows) out.set(r.month, { seatCount: r.seat_count, total: Number(r.total) });
  return out;
}

// Current-month billing for a single org (live headcount).
export async function currentBillingForOrg(orgId: string): Promise<MonthBilling> {
  const rows = await billableSeatRows();
  const b = aggregateByOrg(rows.filter((r) => r.org_id === orgId)).get(orgId);
  return b ? { seatCount: b.seatCount, total: b.total } : { seatCount: 0, total: 0 };
}

// Freeze billing for one calendar month for every active org. Idempotent: the
// UNIQUE(organization_id, period_month) constraint plus ON CONFLICT DO NOTHING
// means re-running never overwrites an already-frozen month. `monthStart` is
// the first day of the month (UTC), 'YYYY-MM-DD'. Returns rows newly frozen.
//
// Writes a row for every active org, including zero-seat ones, so the ledger
// unambiguously records "billed £0" rather than leaving a tenant absent.
//
// Known limitation: it uses *current* headcount, so it's meant to run at (or
// just after) month close. Past headcount isn't reconstructable — if the job's
// first run for a month is much later (e.g. the worker was down across the
// boundary), the frozen seat_count reflects run-time headcount, not month-end.
export async function snapshotBillingMonth(monthStart: string): Promise<number> {
  const byOrg = aggregateByOrg(await billableSeatRows());
  const activeOrgs = await query<{ id: string; plan: string; seat_price_override: string | null }>(
    `SELECT id, plan, seat_price_override FROM organizations WHERE status = 'active'`
  );
  let written = 0;
  for (const org of activeOrgs) {
    const b = byOrg.get(org.id);
    const override = org.seat_price_override == null ? null : Number(org.seat_price_override);
    const inserted = await query<{ id: string }>(
      `INSERT INTO billing_periods
         (organization_id, period_month, plan, seat_count, seat_price_override, total)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, period_month) DO NOTHING
       RETURNING id`,
      [org.id, monthStart, org.plan, b?.seatCount ?? 0, override, (b?.total ?? 0).toFixed(2)]
    );
    if (inserted.length) written++;
  }
  return written;
}
