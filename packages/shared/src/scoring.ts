import { PASS_THRESHOLD } from './constants.js';
import type { BreachSeverity } from './types/breaches.js';
import type { AppliesWhen, BranchConfig } from './types/scorecard.js';

/**
 * Whether a single scorecard item's normalized score (0-100) is a pass.
 * `threshold` defaults to the global PASS_THRESHOLD constant but should be
 * passed the org's per-tenant pass_threshold where one is available (see
 * services/tenant-settings.ts) — the parameter exists so this stays the
 * single source of truth for the comparison either way.
 */
export function isItemPass(normalizedScore: number, threshold: number = PASS_THRESHOLD): boolean {
  return normalizedScore >= threshold;
}

/**
 * Resolve which branch a scorecard's checkpoints should apply under, from
 * the call/journey transcript(s). Keyword detection: the first non-default
 * branch whose configured keywords/phrases appear (case-insensitive
 * substring match) anywhere in the combined transcript text wins; no match
 * falls back to `branches[0]` (the implicit default, e.g. "on_risk"). A null
 * branch_config (the common case — most scorecards have a single implicit
 * branch) returns null, and `itemAppliesToBranch` then only excludes items
 * that explicitly set `applies_when` anyway.
 */
export function resolveBranch(transcriptText: string, branchConfig: BranchConfig | null | undefined): string | null {
  if (!branchConfig || !branchConfig.branches?.length) return null;
  const haystack = transcriptText.toLowerCase();
  for (const branch of branchConfig.branches.slice(1)) {
    const keywords = branchConfig.keywords?.[branch] ?? [];
    if (keywords.some((kw) => haystack.includes(kw.toLowerCase()))) {
      return branch;
    }
  }
  return branchConfig.branches[0]!;
}

/**
 * Whether a scorecard item applies under the resolved branch. Absent
 * `applies_when` always applies. A resolved branch of null (no branch_config
 * on the scorecard) only matches items that also have no `applies_when`.
 */
export function itemAppliesToBranch(appliesWhen: AppliesWhen | null | undefined, branch: string | null): boolean {
  if (!appliesWhen) return true;
  if (branch === null) return false;
  const wanted = Array.isArray(appliesWhen.branch) ? appliesWhen.branch : [appliesWhen.branch];
  return wanted.includes(branch);
}

/**
 * Effective breach severity for a failing item: the explicit severity if it is
 * a valid value, otherwise derived from the item's weight. Single source of
 * truth for the weight -> severity mapping (used by scoring, breach creation,
 * the demo seed, and the pass gate).
 */
export function deriveSeverity(weight: number, explicitSeverity?: string | null): BreachSeverity {
  if (explicitSeverity && ['critical', 'high', 'medium', 'low'].includes(explicitSeverity)) {
    return explicitSeverity as BreachSeverity;
  }
  if (weight >= 2.0) return 'critical';
  if (weight >= 1.5) return 'high';
  return 'medium';
}

/**
 * Whether a whole call/journey passes: at or above the pass threshold AND
 * with no critical-severity breach. A critical failure fails it regardless
 * of the overall score, so a high percentage cannot mask a regulator-grade
 * miss. `threshold` defaults to PASS_THRESHOLD; pass the org's per-tenant
 * pass_threshold where available.
 */
export function callPasses(
  overallScore: number,
  failingSeverities: BreachSeverity[],
  threshold: number = PASS_THRESHOLD
): boolean {
  return overallScore >= threshold && !failingSeverities.includes('critical');
}
