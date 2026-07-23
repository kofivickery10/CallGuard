import { describe, it, expect } from 'vitest';
import {
  isItemPass,
  resolveBranch,
  itemAppliesToBranch,
  productAppliesToItem,
  deriveSeverity,
  callPasses,
} from './scoring.js';
import type { BranchConfig } from './types/scorecard.js';

describe('isItemPass', () => {
  it('passes at or above the threshold', () => {
    expect(isItemPass(70, 70)).toBe(true);
    expect(isItemPass(100, 70)).toBe(true);
  });
  it('fails below the threshold', () => {
    expect(isItemPass(69, 70)).toBe(false);
  });
  it('honours a per-tenant threshold', () => {
    expect(isItemPass(75, 80)).toBe(false);
    expect(isItemPass(85, 80)).toBe(true);
  });
});

describe('resolveBranch', () => {
  const cfg: BranchConfig = {
    branches: ['on_risk', 'referred'],
    detect: 'keyword',
    keywords: { referred: ['referred for underwriting', 'not active yet'] },
  };

  it('returns null when there is no branch config', () => {
    expect(resolveBranch('anything', null)).toBeNull();
    expect(resolveBranch('anything', undefined)).toBeNull();
  });

  it('matches a non-default branch by keyword (case-insensitive)', () => {
    expect(resolveBranch('the policy is REFERRED FOR UNDERWRITING now', cfg)).toBe('referred');
    expect(resolveBranch('it is not active yet', cfg)).toBe('referred');
  });

  it('falls back to the first (default) branch when nothing matches', () => {
    expect(resolveBranch('all accepted on standard terms', cfg)).toBe('on_risk');
  });
});

describe('itemAppliesToBranch', () => {
  it('applies when the item has no branch condition', () => {
    expect(itemAppliesToBranch(null, 'on_risk')).toBe(true);
    expect(itemAppliesToBranch(undefined, null)).toBe(true);
  });
  it('a conditioned item does not apply when no branch resolved', () => {
    expect(itemAppliesToBranch({ branch: 'referred' }, null)).toBe(false);
  });
  it('matches a single or multi-branch condition', () => {
    expect(itemAppliesToBranch({ branch: 'referred' }, 'referred')).toBe(true);
    expect(itemAppliesToBranch({ branch: 'referred' }, 'on_risk')).toBe(false);
    expect(itemAppliesToBranch({ branch: ['on_risk', 'referred'] }, 'on_risk')).toBe(true);
  });
});

describe('productAppliesToItem', () => {
  it('an unscoped item (null/empty) applies to every product', () => {
    expect(productAppliesToItem(null, ['p1'])).toBe(true);
    expect(productAppliesToItem(undefined, [])).toBe(true);
    expect(productAppliesToItem([], ['p1', 'p2'])).toBe(true);
  });
  it('applies when the sale intersects the item scope', () => {
    expect(productAppliesToItem(['p1'], ['p1'])).toBe(true);
    expect(productAppliesToItem(['p1', 'p2'], ['p2', 'p3'])).toBe(true);
  });
  it('does not apply when the sale misses the item scope', () => {
    expect(productAppliesToItem(['p1'], ['p2'])).toBe(false);
    expect(productAppliesToItem(['p1', 'p2'], ['p3'])).toBe(false);
  });
  it('scores a scoped item conservatively when the product is unknown', () => {
    // Empty sale set = product couldn't be resolved — score it rather than
    // silently dropping a compliance checkpoint.
    expect(productAppliesToItem(['p1'], [])).toBe(true);
  });
});

describe('deriveSeverity', () => {
  it('uses a valid explicit severity', () => {
    expect(deriveSeverity(1, 'critical')).toBe('critical');
    expect(deriveSeverity(3, 'low')).toBe('low');
  });
  it('derives from weight when no valid explicit severity', () => {
    expect(deriveSeverity(2.0)).toBe('critical');
    expect(deriveSeverity(1.5)).toBe('high');
    expect(deriveSeverity(1)).toBe('medium');
    expect(deriveSeverity(1, 'bogus')).toBe('medium');
  });
});

describe('callPasses', () => {
  it('passes above threshold with no critical breach', () => {
    expect(callPasses(85, ['medium', 'high'], 70)).toBe(true);
  });
  it('fails when below threshold', () => {
    expect(callPasses(69, [], 70)).toBe(false);
  });
  it('a critical breach fails regardless of a high score', () => {
    expect(callPasses(99, ['critical'], 70)).toBe(false);
  });
});
