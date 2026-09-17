import { describe, it, expect, vi } from 'vitest';
import { queryOne } from '../db/client.js';
import {
  SALE_ARRIVAL_ATTENTION_DAYS,
  getSaleArrival,
  saleArrivalNeedsAttention,
  saleArrivalResponse,
  saleArrivalWindowStart,
  type SaleArrival,
} from './sale-arrival.js';
import { LINKED_TO_ANY_JOURNEY } from './stuck.js';

// The safety net that replaced the silent fallback. A sales_only firm scores
// nothing until a sale arrives; when calls keep coming in and sales do not, the
// firm is told instead of quietly getting no scores.
//
// The rule is about ARRIVAL over one recent window, not the age of unsold
// calls. Most calls never become sales, so a healthy sales_only firm always has
// old unsold calls — a firm that fetches recordings on sale keeps thousands at
// 'captured' by design. An age rule would warn there forever. These pin the
// window rule at its edges.

vi.mock('../db/client.js', () => ({ queryOne: vi.fn() }));

const NOW = new Date('2026-09-17T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

// Defaults: calls received in the window, not in a sale, and no sale ever.
function arrival(overrides: Partial<SaleArrival> = {}): SaleArrival {
  return {
    scoringScope: 'sales_only',
    waitingCalls: 12,
    oldestWaitingAt: daysAgo(6),
    lastSaleAt: null,
    ...overrides,
  };
}

describe('saleArrivalNeedsAttention', () => {
  it('flags recent calls with no sale ever', () => {
    expect(saleArrivalNeedsAttention(arrival(), NOW)).toBe(true);
  });

  it('flags recent calls when the last sale is older than the window', () => {
    expect(saleArrivalNeedsAttention(arrival({ lastSaleAt: daysAgo(8) }), NOW)).toBe(true);
  });

  it('is quiet with no recent calls, however old the last sale', () => {
    // A firm whose unsold calls are all older than the window — e.g. thousands
    // of captured calls that never became sales — is not flagged for them.
    expect(
      saleArrivalNeedsAttention(arrival({ waitingCalls: 0, oldestWaitingAt: null, lastSaleAt: daysAgo(90) }), NOW)
    ).toBe(false);
  });

  it('is quiet with recent calls and a recent sale', () => {
    // Sales are arriving; the unsold calls are customers who have not bought.
    expect(saleArrivalNeedsAttention(arrival({ lastSaleAt: daysAgo(2) }), NOW)).toBe(false);
  });

  it('counts a sale exactly at the start of the window as recent', () => {
    expect(
      saleArrivalNeedsAttention(arrival({ lastSaleAt: daysAgo(SALE_ARRIVAL_ATTENTION_DAYS) }), NOW)
    ).toBe(false);
  });

  it('flags a sale just before the window', () => {
    const justBefore = new Date(saleArrivalWindowStart(NOW).getTime() - 1000).toISOString();
    expect(saleArrivalNeedsAttention(arrival({ lastSaleAt: justBefore }), NOW)).toBe(true);
  });

  it.each(['everything', 'over_threshold'] as const)('never flags a firm at %s', (scope) => {
    // Calls there are scored on their own; nothing is waiting for a sale.
    expect(saleArrivalNeedsAttention(arrival({ scoringScope: scope }), NOW)).toBe(false);
  });

  it('is quiet on an unreadable last-sale timestamp rather than warning on bad data', () => {
    expect(saleArrivalNeedsAttention(arrival({ lastSaleAt: 'not a date' }), NOW)).toBe(false);
  });

  it('uses a week', () => {
    expect(SALE_ARRIVAL_ATTENTION_DAYS).toBe(7);
  });
});

describe('getSaleArrival', () => {
  it('counts calls received in the window, captured or transcribed, not in any sale', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      scoring_scope: 'sales_only',
      waiting_calls: '3',
      oldest_waiting_at: new Date('2026-09-11T09:00:00.000Z'),
      last_sale_at: null,
    } as never);

    const result = await getSaleArrival('org-1', NOW);

    expect(result).toEqual({
      scoringScope: 'sales_only',
      waitingCalls: 3,
      oldestWaitingAt: '2026-09-11T09:00:00.000Z',
      lastSaleAt: null,
    });
    const [sql, params] = vi.mocked(queryOne).mock.calls[0]!;
    expect(sql).toContain('c.created_at >= $2');
    expect(sql).toContain("c.status IN ('captured', 'transcribed')");
    expect(sql).toContain(`NOT ${LINKED_TO_ANY_JOURNEY}`);
    expect(sql).toContain('MAX(j.created_at) FROM journeys j');
    expect(sql).not.toContain('zoho_connections');
    // The window starts from the same clock the last-sale test uses.
    expect(params).toEqual(['org-1', daysAgo(SALE_ARRIVAL_ATTENTION_DAYS)]);
  });

  it('returns null for an organisation that does not exist', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null as never);
    expect(await getSaleArrival('missing', NOW)).toBeNull();
  });
});

describe('saleArrivalResponse', () => {
  it('carries the figures, the verdict and the window the banner words', () => {
    expect(saleArrivalResponse(arrival({ lastSaleAt: daysAgo(30) }), NOW)).toEqual({
      scoring_scope: 'sales_only',
      waiting_calls: 12,
      oldest_waiting_at: daysAgo(6),
      last_sale_at: daysAgo(30),
      needs_attention: true,
      attention_after_days: 7,
    });
  });
});
