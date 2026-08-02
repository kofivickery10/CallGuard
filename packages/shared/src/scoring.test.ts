import { describe, it, expect } from 'vitest';
import {
  isItemPass,
  resolveBranch,
  resolveBranchWithSource,
  resolveBranchFromCrmStage,
  isNoScoreCrmStage,
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

describe('resolveBranchFromCrmStage', () => {
  const cfg: BranchConfig = {
    branches: ['on_risk', 'referred'],
    detect: 'crm_field',
    crm_values: {
      on_risk: ['On Risk', 'Active'],
      referred: ['Referred', 'Referred to Underwriting'],
    },
  };

  it('maps a stage value to its branch, case- and whitespace-insensitively', () => {
    expect(resolveBranchFromCrmStage('Referred', cfg)).toBe('referred');
    expect(resolveBranchFromCrmStage('  referred  ', cfg)).toBe('referred');
    expect(resolveBranchFromCrmStage('ON RISK', cfg)).toBe('on_risk');
  });

  it('returns null for an unmapped or empty stage', () => {
    expect(resolveBranchFromCrmStage('Awaiting Documents', cfg)).toBeNull();
    expect(resolveBranchFromCrmStage('', cfg)).toBeNull();
    expect(resolveBranchFromCrmStage(null, cfg)).toBeNull();
  });

  it('matches exactly, so overlapping picklist values cannot collide', () => {
    // "Referred" is a substring of "Referred to Underwriting"; a substring
    // match would make the first configured branch win for both.
    expect(resolveBranchFromCrmStage('Referred to Underwriting', cfg)).toBe('referred');
    expect(resolveBranchFromCrmStage('Not Referred', cfg)).toBeNull();
  });

  it('returns null when the config has no crm_values', () => {
    expect(resolveBranchFromCrmStage('Referred', { branches: ['a', 'b'], detect: 'keyword' })).toBeNull();
  });
});

describe('isNoScoreCrmStage', () => {
  const cfg: BranchConfig = {
    branches: ['on_risk', 'referred'],
    detect: 'crm_field',
    crm_values: { on_risk: ['On Risk'], referred: ['Referred', 'Referred - Decision Back'] },
    no_score_crm_values: ['Referred - NTU', 'Referred - Decision Back - NTU'],
  };

  it('identifies a not-taken-up sale', () => {
    expect(isNoScoreCrmStage('Referred - NTU', cfg)).toBe(true);
    expect(isNoScoreCrmStage('referred - decision back - ntu', cfg)).toBe(true);
  });

  it('does not catch the scoreable stages those values contain', () => {
    // "Referred" and "Referred - Decision Back" are substrings of the NTU
    // values; a loose match would stop scoring real sales.
    expect(isNoScoreCrmStage('Referred', cfg)).toBe(false);
    expect(isNoScoreCrmStage('Referred - Decision Back', cfg)).toBe(false);
    expect(isNoScoreCrmStage('On Risk', cfg)).toBe(false);
  });

  it('is inert when unconfigured', () => {
    expect(isNoScoreCrmStage('Referred - NTU', { branches: ['a'], detect: 'keyword' })).toBe(false);
    expect(isNoScoreCrmStage(null, cfg)).toBe(false);
  });
});

describe('resolveBranchWithSource', () => {
  const cfg: BranchConfig = {
    branches: ['on_risk', 'referred'],
    detect: 'crm_field',
    keywords: { referred: ['referred for underwriting'] },
    crm_values: { on_risk: ['On Risk'], referred: ['Referred'] },
  };

  it('prefers the CRM stage over the transcript', () => {
    // The transcript keyword says on_risk (no match -> default), the CRM says
    // referred. The CRM is the system of record and must win.
    expect(resolveBranchWithSource('all sorted, policy starts today', cfg, 'Referred')).toEqual({
      branch: 'referred',
      source: 'crm',
      unmappedCrmStage: false,
    });
  });

  it('overrides a contradicting keyword match with the CRM stage', () => {
    expect(
      resolveBranchWithSource('this is referred for underwriting', cfg, 'On Risk')
    ).toEqual({ branch: 'on_risk', source: 'crm', unmappedCrmStage: false });
  });

  it('falls back to keywords when the stage is missing', () => {
    expect(resolveBranchWithSource('referred for underwriting', cfg, null)).toEqual({
      branch: 'referred',
      source: 'keyword',
      unmappedCrmStage: false,
    });
  });

  it('flags a stage the CRM reported but no branch claims', () => {
    // Picklists grow. "Referred - Decision Back - NTU" appearing after the map
    // was written must not quietly become the default branch.
    expect(resolveBranchWithSource('referred for underwriting', cfg, 'Awaiting Docs')).toEqual({
      branch: 'referred',
      source: 'keyword',
      unmappedCrmStage: true,
    });
    expect(resolveBranchWithSource('nothing matches here', cfg, 'Awaiting Docs')).toEqual({
      branch: 'on_risk',
      source: 'default',
      unmappedCrmStage: true,
    });
  });

  it('does not flag an unmapped stage when the scorecard has no crm_values at all', () => {
    // An org that never configured CRM branching isn't misconfigured.
    const keywordOnly: BranchConfig = {
      branches: ['on_risk', 'referred'],
      detect: 'keyword',
      keywords: { referred: ['referred for underwriting'] },
    };
    expect(resolveBranchWithSource('all good', keywordOnly, 'Whatever')).toEqual({
      branch: 'on_risk',
      source: 'default',
      unmappedCrmStage: false,
    });
  });

  it('flags a scorecard that claims crm_field detection but carries no map', () => {
    // What an edit that drops crm_values leaves behind. The CRM reported a real
    // stage, the scorecard says to resolve branches from it, and there is nothing
    // to resolve it with — so every sale is scored on the default branch. Distinct
    // from the keyword-only case above, which is a valid configuration.
    const mapDropped: BranchConfig = {
      branches: ['on_risk', 'referred'],
      detect: 'crm_field',
      keywords: { referred: ['referred for underwriting'] },
    };
    expect(resolveBranchWithSource('all good', mapDropped, 'On Risk')).toEqual({
      branch: 'on_risk',
      source: 'default',
      unmappedCrmStage: true,
    });
  });

  it('reports source=default when nothing matched, so a guess is never silent', () => {
    // The regression this exists for: an adviser who says "we'll leave it to
    // the medical underwriter now" matches no configured keyword, and the
    // journey was silently scored under on_risk.
    expect(
      resolveBranchWithSource('we leave it to the medical underwriter now', cfg, null)
    ).toEqual({ branch: 'on_risk', source: 'default', unmappedCrmStage: false });
  });

  it('returns a null source alongside a null branch when unconfigured', () => {
    expect(resolveBranchWithSource('anything', null)).toEqual({
      branch: null,
      source: null,
      unmappedCrmStage: false,
    });
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
