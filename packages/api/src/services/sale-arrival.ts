import { queryOne } from '../db/client.js';
import { LINKED_TO_ANY_JOURNEY } from './stuck.js';
import type { ScoringScope, SaleArrivalStatus } from '@callguard/shared';

// ============================================================
// Are sales reaching a firm that scores sales?
//
// A sales_only firm never scores a call on its own: each call rests until a
// sale for that customer arrives, and the sale is scored as one unit
// (jobs/processors/transcribe.ts). Sales arrive from a CRM webhook, "Score
// sale" on the customer, or the upload "this call is a sale" flag.
//
// If none of those is working, nothing is ever scored, and until now nothing
// said so. The old answer was to guess from the firm's Zoho connection and
// quietly score every call on its own when there was none. That guess is gone
// (migration 119): scoring_scope alone decides. What replaces it is this —
// saying so, to the firm on the Calls page and to CallGuard staff on the tenant
// view, so a firm with no working sale source finds out instead of silently
// getting no scores.
//
// WHY ARRIVAL, NOT AGE. The question is "are calls still coming in while sales
// are not?", asked over one recent window. An earlier draft asked instead how
// long the oldest unsold call had waited, which is the wrong question twice
// over. Most calls never become sales, so at any healthy sales_only firm there
// is always an old unsold call: a firm that fetches recordings on sale keeps
// thousands of them at 'captured' by design (Trust Point holds ~8,100), and an
// age rule would warn there forever. And a rule that only looked at
// 'transcribed' calls could never see such a firm at all, so its sale webhook
// could break unnoticed. Looking only at the window fixes both: old unsold
// calls drop out of it, and captured calls count alongside transcribed ones.
// ============================================================

/**
 * The window, in days, over which calls arriving with no sale arriving means a
 * firm needs telling. A week: long enough that a quiet few days or a bank
 * holiday without a sale does not raise it, short enough that a broken CRM
 * webhook is caught well inside a month's compliance reporting.
 */
export const SALE_ARRIVAL_ATTENTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SaleArrival {
  scoringScope: ScoringScope;
  /**
   * Calls received in the last SALE_ARRIVAL_ATTENTION_DAYS days that are not
   * part of any sale — captured (metadata only, recording fetched on sale) or
   * transcribed.
   */
  waitingCalls: number;
  /** When the earliest of those calls was received, or null if there are none. */
  oldestWaitingAt: string | null;
  /** When the firm's most recent sale (journey) was created, or null if never. */
  lastSaleAt: string | null;
}

/** The start of the window, for `now`. */
export function saleArrivalWindowStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - SALE_ARRIVAL_ATTENTION_DAYS * DAY_MS);
}

/**
 * Whether the firm needs telling that sales are not arriving. All three must
 * hold:
 *  - it scores sales (at any other scope, calls are scored on their own);
 *  - calls came in during the window and are not part of a sale. Counting the
 *    unsold ones rather than every call received is deliberate: if every
 *    recent call already belongs to a sale, sales are plainly arriving, and a
 *    banner reading "0 calls" would be nonsense;
 *  - no sale was created in the window. A firm still receiving sales has a
 *    working sale source; its unsold calls are customers who have not bought,
 *    which is normal.
 */
export function saleArrivalNeedsAttention(arrival: SaleArrival, now: Date = new Date()): boolean {
  if (arrival.scoringScope !== 'sales_only') return false;
  if (arrival.waitingCalls <= 0) return false;

  if (arrival.lastSaleAt) {
    const lastSale = new Date(arrival.lastSaleAt).getTime();
    // An unreadable timestamp is read as "a sale may have arrived": staying
    // quiet on bad data beats a warning nobody can explain.
    if (!Number.isFinite(lastSale) || lastSale >= saleArrivalWindowStart(now).getTime()) return false;
  }
  return true;
}

/**
 * The figures behind saleArrivalNeedsAttention for one firm. Null when the
 * organisation does not exist.
 *
 * Counted whatever the firm's scope, so staff can see the numbers either side
 * of a scope change; only the needs-attention rule is limited to sales_only.
 * The window starts from `now` in JavaScript, not the database's now(), so the
 * calls counted and the last-sale test in saleArrivalNeedsAttention share one
 * clock. calls(organization_id, created_at DESC) serves the window.
 */
export async function getSaleArrival(
  organizationId: string,
  now: Date = new Date()
): Promise<SaleArrival | null> {
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
            AND c.created_at >= $2
            AND c.status IN ('captured', 'transcribed')
            AND NOT ${LINKED_TO_ANY_JOURNEY}
       ) waiting
      WHERE o.id = $1`,
    [organizationId, saleArrivalWindowStart(now).toISOString()]
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
