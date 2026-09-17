import { queryOne } from '../db/client.js';
import { LINKED_TO_ANY_JOURNEY } from './stuck.js';
import type { ScoringScope, SaleArrivalStatus } from '@callguard/shared';

// ============================================================
// Are sales reaching a firm that scores sales?
//
// A sales_only firm never scores a call on its own: each call rests at
// 'transcribed' until a sale for that customer arrives, and the sale is scored
// as one unit (jobs/processors/transcribe.ts). Sales arrive from a CRM webhook,
// "Score sale" on the customer, or the upload "this call is a sale" flag.
//
// If none of those is working, nothing is ever scored, and until now nothing
// said so. The old answer was to guess from the firm's Zoho connection and
// quietly score every call on its own when there was none. That guess is gone
// (migration 119): scoring_scope alone decides. What replaces it is this —
// counting the calls left waiting and saying so, to the firm on the Calls page
// and to CallGuard staff on the tenant view, so a firm with no working sale
// source finds out instead of silently getting no scores.
// ============================================================

/**
 * How long calls may wait, with no sale arriving either, before the firm is
 * told. A week: long enough that a quiet few days, a bank holiday or a normal
 * gap between a first call and the sale does not raise it, short enough that a
 * broken CRM webhook is caught well inside a month's compliance reporting.
 */
export const SALE_ARRIVAL_ATTENTION_DAYS = 7;

export interface SaleArrival {
  scoringScope: ScoringScope;
  /** Transcribed calls not yet part of any sale. */
  waitingCalls: number;
  /** When the oldest of those calls reached CallGuard, or null if none wait. */
  oldestWaitingAt: string | null;
  /** When the firm's most recent sale (journey) was created, or null if never. */
  lastSaleAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the firm needs telling that sales are not arriving. All four must
 * hold:
 *  - it scores sales (at any other scope, calls are scored on their own);
 *  - calls are waiting for a sale;
 *  - the oldest has waited more than SALE_ARRIVAL_ATTENTION_DAYS;
 *  - no sale has been created in that time either. A firm still receiving
 *    sales has a working sale source; its waiting calls are just customers who
 *    have not bought, which is normal.
 */
export function saleArrivalNeedsAttention(arrival: SaleArrival, now: Date = new Date()): boolean {
  if (arrival.scoringScope !== 'sales_only') return false;
  if (arrival.waitingCalls <= 0 || !arrival.oldestWaitingAt) return false;

  const cutoff = now.getTime() - SALE_ARRIVAL_ATTENTION_DAYS * DAY_MS;
  const oldest = new Date(arrival.oldestWaitingAt).getTime();
  if (!Number.isFinite(oldest) || oldest >= cutoff) return false;

  if (arrival.lastSaleAt) {
    const lastSale = new Date(arrival.lastSaleAt).getTime();
    if (Number.isFinite(lastSale) && lastSale >= cutoff) return false;
  }
  return true;
}

/**
 * The figures behind saleArrivalNeedsAttention for one firm. Null when the
 * organisation does not exist.
 *
 * Counted whatever the firm's scope, so staff can see the numbers either side
 * of a scope change; only the needs-attention rule is limited to sales_only.
 */
export async function getSaleArrival(organizationId: string): Promise<SaleArrival | null> {
  const row = await queryOne<{
    scoring_scope: ScoringScope;
    waiting_calls: string;
    oldest_waiting_at: Date | string | null;
    last_sale_at: Date | string | null;
  }>(
    `SELECT o.scoring_scope,
            waiting.count::text AS waiting_calls,
            waiting.oldest      AS oldest_waiting_at,
            (SELECT MAX(j.created_at) FROM journeys j
              WHERE j.organization_id = o.id) AS last_sale_at
       FROM organizations o
       CROSS JOIN LATERAL (
         SELECT COUNT(*) AS count, MIN(c.created_at) AS oldest
           FROM calls c
          WHERE c.organization_id = o.id
            AND c.status = 'transcribed'
            AND NOT ${LINKED_TO_ANY_JOURNEY}
       ) waiting
      WHERE o.id = $1`,
    [organizationId]
  );
  if (!row) return null;
  return {
    scoringScope: row.scoring_scope,
    waitingCalls: Number(row.waiting_calls) || 0,
    oldestWaitingAt: toIso(row.oldest_waiting_at),
    lastSaleAt: toIso(row.last_sale_at),
  };
}

function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The shape both the tenant and superadmin routes return. */
export function saleArrivalResponse(arrival: SaleArrival, now: Date = new Date()): SaleArrivalStatus {
  return {
    scoring_scope: arrival.scoringScope,
    waiting_calls: arrival.waitingCalls,
    oldest_waiting_at: arrival.oldestWaitingAt,
    last_sale_at: arrival.lastSaleAt,
    needs_attention: saleArrivalNeedsAttention(arrival, now),
    attention_after_days: SALE_ARRIVAL_ATTENTION_DAYS,
  };
}
