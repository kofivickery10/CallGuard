import { describe, it, expect } from 'vitest';
import { SEAT_PRICING } from '@callguard/shared';
import { seatPrice, aggregateByOrg, mrrFromRows, type BillableSeatRow } from './billing.js';

describe('seatPrice', () => {
  it('prices by the org tier when there is no override', () => {
    expect(seatPrice('core', null, null)).toBe(SEAT_PRICING.core);
    expect(seatPrice('professional', null, null)).toBe(SEAT_PRICING.professional);
    expect(seatPrice('enterprise', null, null)).toBe(SEAT_PRICING.enterprise);
  });

  it('a negotiated flat override wins over tier pricing', () => {
    expect(seatPrice('enterprise', 150, null)).toBe(150);
    expect(seatPrice('core', 0, null)).toBe(0);
  });

  it("a per-user plan_override bumps the seat's tier up, never down", () => {
    expect(seatPrice('core', null, 'enterprise')).toBe(SEAT_PRICING.enterprise);
    expect(seatPrice('enterprise', null, 'core')).toBe(SEAT_PRICING.enterprise);
  });
});

describe('aggregateByOrg / mrrFromRows', () => {
  const rows: BillableSeatRow[] = [
    { org_id: 'a', org_plan: 'core', seat_price_override: null, plan_override: null },
    { org_id: 'a', org_plan: 'core', seat_price_override: null, plan_override: null },
    { org_id: 'a', org_plan: 'core', seat_price_override: null, plan_override: 'professional' },
    { org_id: 'b', org_plan: 'enterprise', seat_price_override: '100', plan_override: null },
    { org_id: 'b', org_plan: 'enterprise', seat_price_override: '100', plan_override: null },
  ];

  it('counts seats and totals per org, respecting overrides and per-user bumps', () => {
    const byOrg = aggregateByOrg(rows);
    expect(byOrg.get('a')).toEqual({
      seatCount: 3,
      total: SEAT_PRICING.core * 2 + SEAT_PRICING.professional,
      orgPlan: 'core',
      seatPriceOverride: null,
    });
    expect(byOrg.get('b')).toEqual({
      seatCount: 2,
      total: 200, // flat override applies to every seat
      orgPlan: 'enterprise',
      seatPriceOverride: 100,
    });
  });

  it('MRR is the sum of every org total', () => {
    expect(mrrFromRows(rows)).toBe(SEAT_PRICING.core * 2 + SEAT_PRICING.professional + 200);
  });
});
