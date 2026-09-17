import { describe, it, expect } from 'vitest';
import { summariseCustomerCompliance, severityBreakdown } from './customer.js';
import type { CustomerCompliance } from './customer.js';

// The customer profile used to say "Clean — No breaches recorded" whenever a
// customer had no breaches, which on a firm where 93% of customers have never
// had a sale scored was a green tick on thousands of people nobody had looked
// at. These pin the three states that replaced it.

const NONE = { critical: 0, high: 0, medium: 0, low: 0 };

function counts(overrides: Partial<CustomerCompliance> = {}): CustomerCompliance {
  return {
    scored_sales: 0,
    scored_calls: 0,
    open: { ...NONE },
    closed: { ...NONE },
    resolved: 0,
    noted: 0,
    ...overrides,
  };
}

describe('summariseCustomerCompliance — not yet assessed', () => {
  it('is neutral, not clean, when nothing about the customer has been scored', () => {
    const s = summariseCustomerCompliance(counts(), 'sales');
    expect(s.state).toBe('not_assessed');
    expect(s.tone).toBe('neutral');
    expect(s.headline).toBe('Not yet assessed');
    expect(s.headline).not.toMatch(/clean/i);
    expect(s.detail).toBe('No sale has been scored yet');
  });

  it('speaks about calls for a firm that scores calls', () => {
    expect(summariseCustomerCompliance(counts(), 'calls').detail).toBe('No call has been scored yet');
  });
});

describe('summariseCustomerCompliance — no open findings', () => {
  it('says how many were resolved when every breach is closed', () => {
    const s = summariseCustomerCompliance(
      counts({ scored_sales: 2, closed: { ...NONE, critical: 7, medium: 20 }, resolved: 27 }),
      'sales'
    );
    expect(s.state).toBe('no_open');
    expect(s.tone).toBe('pass');
    expect(s.headline).toBe('No open findings');
    expect(s.detail).toBe('27 resolved');
    expect(s.open_total).toBe(0);
    expect(s.closed_total).toBe(27);
  });

  it('counts noted breaches as closed, and says so', () => {
    const s = summariseCustomerCompliance(
      counts({ scored_sales: 1, closed: { ...NONE, low: 3 }, resolved: 2, noted: 1 }),
      'sales'
    );
    expect(s.state).toBe('no_open');
    expect(s.detail).toBe('2 resolved · 1 noted');
  });

  it('says nothing was found when a scored customer has no breaches at all', () => {
    const s = summariseCustomerCompliance(counts({ scored_calls: 1 }), 'calls');
    expect(s.state).toBe('no_open');
    expect(s.detail).toBe('Nothing found on 1 scored call');
  });
});

describe('summariseCustomerCompliance — open findings', () => {
  it('is fail-toned when a critical or high breach is open', () => {
    const s = summariseCustomerCompliance(
      counts({ scored_sales: 1, open: { ...NONE, critical: 2, high: 1 } }),
      'sales'
    );
    expect(s.state).toBe('open');
    expect(s.tone).toBe('fail');
    expect(s.headline).toBe('3 open');
    expect(s.detail).toBe('2 critical · 1 high');
  });

  it('is review-toned when only medium or low breaches are open', () => {
    const s = summariseCustomerCompliance(
      counts({ scored_sales: 1, open: { ...NONE, medium: 1, low: 4 }, closed: { ...NONE, critical: 5 }, resolved: 5 }),
      'sales'
    );
    expect(s.state).toBe('open');
    expect(s.tone).toBe('review');
    expect(s.detail).toBe('1 medium · 4 low');
  });

  // Closed critical breaches must not colour an open count, and no zero count
  // is ever drawn in the fail tone.
  it('never renders "0 open" in any tone', () => {
    const s = summariseCustomerCompliance(
      counts({ scored_sales: 1, closed: { ...NONE, critical: 3 }, resolved: 3 }),
      'sales'
    );
    expect(s.state).not.toBe('open');
    expect(s.tone).not.toBe('fail');
    expect(s.headline).not.toMatch(/^0 /);
  });
});

describe('severityBreakdown', () => {
  it('omits empty severities and keeps severity order', () => {
    expect(severityBreakdown({ critical: 0, high: 2, medium: 0, low: 1 })).toBe('2 high · 1 low');
    expect(severityBreakdown(NONE)).toBe('');
  });
});
