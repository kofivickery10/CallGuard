import { describe, it, expect } from 'vitest';
import { mergeBranchConfig } from './branch-config.js';
import type { BranchConfig } from '@callguard/shared';

// Trust Point's live config, as the branch-map script writes it.
const stored: BranchConfig = {
  branches: ['on_risk', 'referred'],
  detect: 'crm_field',
  keywords: { referred: ['referred for underwriting'] },
  crm_values: { on_risk: ['On Risk'], referred: ['Referred', 'Referred - Decision Back'] },
  no_score_crm_values: ['Referred - NTU', 'Referred - Decision Back - NTU'],
};

// What the scorecard editor sends: branches + keywords only, detect hardcoded.
const fromEditor = {
  branches: ['on_risk', 'referred'],
  detect: 'keyword' as const,
  keywords: { referred: ['referred for underwriting', 'with the underwriters'] },
};

describe('mergeBranchConfig', () => {
  it('preserves the CRM stage map when the editor omits it', () => {
    // The regression: saving an unrelated keyword edit wiped crm_values, and
    // every sale afterwards fell back to a guessed branch.
    const merged = mergeBranchConfig(stored, fromEditor) as BranchConfig;
    expect(merged.crm_values).toEqual(stored.crm_values);
    expect(merged.no_score_crm_values).toEqual(stored.no_score_crm_values);
  });

  it('keeps crm_field detection alive alongside the preserved map', () => {
    // Preserving crm_values under detect='keyword' would leave the map in the
    // row but never consulted — intact and dead.
    const merged = mergeBranchConfig(stored, fromEditor) as BranchConfig;
    expect(merged.detect).toBe('crm_field');
  });

  it('takes the caller edits it did send', () => {
    const merged = mergeBranchConfig(stored, fromEditor) as BranchConfig;
    expect(merged.keywords).toEqual(fromEditor.keywords);
  });

  it('lets a CRM-aware caller replace the map', () => {
    const incoming = { ...fromEditor, detect: 'crm_field' as const, crm_values: { on_risk: ['Active'] } };
    const merged = mergeBranchConfig(stored, incoming) as BranchConfig;
    expect(merged.crm_values).toEqual({ on_risk: ['Active'] });
    // no_score_crm_values was still omitted, so it survives independently.
    expect(merged.no_score_crm_values).toEqual(stored.no_score_crm_values);
  });

  it('lets an explicit null clear a map deliberately', () => {
    const incoming = { ...fromEditor, crm_values: null, no_score_crm_values: null };
    const merged = mergeBranchConfig(stored, incoming) as BranchConfig;
    expect(merged.crm_values).toBeNull();
    expect(merged.no_score_crm_values).toBeNull();
    // Nothing was preserved, so the caller's detect stands.
    expect(merged.detect).toBe('keyword');
  });

  it('leaves branch_config untouched when the key is absent from the update', () => {
    expect(mergeBranchConfig(stored, undefined)).toBeUndefined();
  });

  it('removes branching outright on an explicit null', () => {
    expect(mergeBranchConfig(stored, null)).toBeNull();
  });

  it('is a no-op for a scorecard that never had a CRM map', () => {
    const keywordOnly: BranchConfig = {
      branches: ['on_risk', 'referred'],
      detect: 'keyword',
      keywords: { referred: ['referred for underwriting'] },
    };
    expect(mergeBranchConfig(keywordOnly, fromEditor)).toEqual(fromEditor);
  });

  it('does not invent a map for a brand new scorecard', () => {
    expect(mergeBranchConfig(null, fromEditor)).toEqual(fromEditor);
  });

  it('carries the map through a branch rename so validation can reject it', () => {
    // Pruning silently here would read downstream as "CRM branching was never
    // configured". The route's validator is what must reject this.
    const renamed = { ...fromEditor, branches: ['on_risk', 'refer'] };
    const merged = mergeBranchConfig(stored, renamed) as BranchConfig;
    expect(Object.keys(merged.crm_values!)).toContain('referred');
  });
});
