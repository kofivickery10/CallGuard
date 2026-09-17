import { describe, it, expect, vi } from 'vitest';
import { queryOne } from '../db/client.js';
import {
  SALE_ARRIVAL_ATTENTION_DAYS,
  getSaleArrival,
  saleArrivalNeedsAttention,
  saleArrivalResponse,
  type SaleArrival,
} from './sale-arrival.js';
import { LINKED_TO_ANY_JOURNEY } from './stuck.js';

// The safety net that replaced the silent fallback. A sales_only firm scores
// nothing until a sale arrives; when sales stop arriving, the firm is told
// instead of quietly getting no scores. Too eager and every firm with a quiet
// week sees a warning it learns to ignore; too shy and a broken CRM webhook
// goes unnoticed for a month. These pin the rule at its edges.

vi.mock('../db/client.js', () => ({ queryOne: vi.fn() }));

const NOW = new Date('2026-09-17T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

function arrival(overrides: Partial<SaleArrival> = {}): SaleArrival {
  return {
    scoringScope: 'sales_only',
    waitingCalls: 12,
    oldestWaitingAt: daysAgo(10),
    lastSaleAt: null,
    ...overrides,
  };
}

describe('saleArrivalNeedsAttention', () => {
  it('flags a sales_only firm whose calls have waited over a week with no sale ever', () => {
    expect(saleArrivalNeedsAttention(arrival(), NOW)).toBe(true);
  });

  it('flags it when the last sale is also more than a week old', () => {
    expect(saleArrivalNeedsAttention(arrival({ lastSaleAt: daysAgo(8) }), NOW)).toBe(true);
  });

  it('is quiet with no waiting calls', () => {
    expect(saleArrivalNeedsAttention(arrival({ waitingCalls: 0, oldestWaitingAt: null }), NOW)).toBe(false);
  });

  it('is quiet while the oldest call has waited less than the threshold', () => {
    expect(saleArrivalNeedsAttention(arrival({ oldestWaitingAt: daysAgo(6) }), NOW)).toBe(false);
  });

  it('is quiet at exactly the threshold — it must be MORE than a week', () => {
    expect(
      saleArrivalNeedsAttention(arrival({ oldestWaitingAt: daysAgo(SALE_ARRIVAL_ATTENTION_DAYS) }), NOW)
    ).toBe(false);
  });

  it('is quiet when a sale arrived within the threshold, however long calls have waited', () => {
    // A firm still receiving sales has a working sale source; its waiting calls
    // are customers who have not bought, which is normal.
    expect(
      saleArrivalNeedsAttention(arrival({ oldestWaitingAt: daysAgo(60), lastSaleAt: daysAgo(2) }), NOW)
    ).toBe(false);
  });

  it('is quiet when the last sale was exactly at the threshold', () => {
    expect(
      saleArrivalNeedsAttention(arrival({ lastSaleAt: daysAgo(SALE_ARRIVAL_ATTENTION_DAYS) }), NOW)
    ).toBe(false);
  });

  it.each(['everything', 'over_threshold'] as const)('never flags a firm at %s', (scope) => {
    // Calls there are scored on their own; nothing is waiting for a sale.
    expect(saleArrivalNeedsAttention(arrival({ scoringScope: scope }), NOW)).toBe(false);
  });

  it('is quiet on an unreadable timestamp rather than warning on bad data', () => {
    expect(saleArrivalNeedsAttention(arrival({ oldestWaitingAt: 'not a date' }), NOW)).toBe(false);
  });

  it('uses a week', () => {
    expect(SALE_ARRIVAL_ATTENTION_DAYS).toBe(7);
  });
});

describe('getSaleArrival', () => {
  it('counts transcribed calls not linked to any sale, by the stuck-work membership rule', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      scoring_scope: 'sales_only',
      waiting_calls: '3',
      oldest_waiting_at: new Date('2026-09-01T09:00:00.000Z'),
      last_sale_at: null,
    } as never);

    const result = await getSaleArrival('org-1');

    expect(result).toEqual({
      scoringScope: 'sales_only',
      waitingCalls: 3,
      oldestWaitingAt: '2026-09-01T09:00:00.000Z',
      lastSaleAt: null,
    });
    const [sql, params] = vi.mocked(queryOne).mock.calls[0]!;
    expect(sql).toContain("c.status = 'transcribed'");
    expect(sql).toContain(`NOT ${LINKED_TO_ANY_JOURNEY}`);
    expect(sql).toContain('MAX(j.created_at) FROM journeys j');
    expect(sql).not.toContain('zoho_connections');
    expect(params).toEqual(['org-1']);
  });

  it('returns null for an organisation that does not exist', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null as never);
    expect(await getSaleArrival('missing')).toBeNull();
  });
});

describe('saleArrivalResponse', () => {
  it('carries the figures, the verdict and the threshold the banner words', () => {
    expect(saleArrivalResponse(arrival({ lastSaleAt: daysAgo(30) }), NOW)).toEqual({
      scoring_scope: 'sales_only',
      waiting_calls: 12,
      oldest_waiting_at: daysAgo(10),
      last_sale_at: daysAgo(30),
      needs_attention: true,
      attention_after_days: 7,
    });
  });
});
