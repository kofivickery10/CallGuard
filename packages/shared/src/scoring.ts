import { PASS_THRESHOLD } from './constants.js';
import type { BreachSeverity } from './types/breaches.js';
import type { AppliesWhen, BranchConfig, BranchSource } from './types/scorecard.js';

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
 * Map a CRM stage value (e.g. a Zoho Deal's "Stage") onto a configured branch.
 * Case-insensitive exact match after trimming — deliberately not a substring
 * match, since stage picklists routinely contain values that contain each
 * other ("Referred" / "Referred - Declined"), and a loose match would silently
 * pick the wrong one. Returns null when there is no mapping or no match, and
 * the caller then falls back to keywords.
 */
export function resolveBranchFromCrmStage(
  crmStage: string | null | undefined,
  branchConfig: BranchConfig | null | undefined
): string | null {
  if (!crmStage?.trim() || !branchConfig?.crm_values) return null;
  const needle = crmStage.trim().toLowerCase();
  for (const branch of branchConfig.branches ?? []) {
    const values = branchConfig.crm_values[branch] ?? [];
    if (values.some((v) => v.trim().toLowerCase() === needle)) return branch;
  }
  return null;
}

/**
 * Whether a CRM stage marks a sale that should not be scored at all (e.g. an
 * NTU / "not taken up" state, where the customer walked away). Exact match,
 * case- and whitespace-insensitive, for the same reason as crm_values: these
 * picklist values contain one another.
 *
 * Checked before branch resolution — a non-sale has no branch.
 */
export function isNoScoreCrmStage(
  crmStage: string | null | undefined,
  branchConfig: BranchConfig | null | undefined
): boolean {
  if (!crmStage?.trim() || !branchConfig?.no_score_crm_values?.length) return false;
  const needle = crmStage.trim().toLowerCase();
  return branchConfig.no_score_crm_values.some((v) => v.trim().toLowerCase() === needle);
}

/**
 * Resolve which branch a scorecard's checkpoints should apply under, and say
 * how that was decided.
 *
 * Precedence, strongest evidence first:
 *  1. `crm` — the sale's CRM stage mapped through `branch_config.crm_values`.
 *     The CRM is the system of record for whether a policy went on risk; the
 *     transcript only ever paraphrases it.
 *  2. `keyword` — the first non-default branch whose configured phrases appear
 *     (case-insensitive substring) in the transcript.
 *  3. `default` — `branches[0]`. A guess, and flagged as such: it decides which
 *     checkpoints apply, so a silently-defaulted branch both mutes the real
 *     branch's items and raises breaches for items that never applied.
 *
 * A null branch_config (most scorecards have a single implicit branch) returns
 * a null branch; `itemAppliesToBranch` then only excludes items that set
 * `applies_when` anyway.
 */
export function resolveBranchWithSource(
  transcriptText: string,
  branchConfig: BranchConfig | null | undefined,
  crmStage?: string | null
): {
  branch: string | null;
  source: BranchSource | null;
  // True when the CRM DID report a stage but no branch claims it. This is a
  // configuration gap, not a missing signal: the sale's real status is known
  // and we threw it away, then fell back to guessing. A picklist grows over
  // time ("Referred - Decision Back - NTU" appearing after the map was written),
  // so this must be loud rather than degrade quietly into the default branch —
  // that silent degradation is the exact failure this whole path exists to stop.
  unmappedCrmStage: boolean;
} {
  if (!branchConfig || !branchConfig.branches?.length) {
    return { branch: null, source: null, unmappedCrmStage: false };
  }

  const fromCrm = resolveBranchFromCrmStage(crmStage, branchConfig);
  if (fromCrm) return { branch: fromCrm, source: 'crm', unmappedCrmStage: false };

  // A stage was reported, a mapping exists, and nothing matched it.
  const unmappedCrmStage = !!crmStage?.trim() && !!branchConfig.crm_values;

  const haystack = transcriptText.toLowerCase();
  for (const branch of branchConfig.branches.slice(1)) {
    const keywords = branchConfig.keywords?.[branch] ?? [];
    if (keywords.some((kw) => haystack.includes(kw.toLowerCase()))) {
      return { branch, source: 'keyword', unmappedCrmStage };
    }
  }
  return { branch: branchConfig.branches[0]!, source: 'default', unmappedCrmStage };
}

/**
 * Branch only, for callers that don't record provenance (per-call scoring).
 * Prefer `resolveBranchWithSource` anywhere the result is persisted.
 */
export function resolveBranch(transcriptText: string, branchConfig: BranchConfig | null | undefined): string | null {
  return resolveBranchWithSource(transcriptText, branchConfig).branch;
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
 * Whether a scorecard item applies to the sale's product set. An item with no
 * `applies_to_products` (null/empty) applies to every product — the default,
 * so an org not using product-aware scoring is unaffected. Otherwise the item
 * applies only if the sale covered at least one of its products. A sale whose
 * products couldn't be determined (`journeyProductIds` empty) still scores
 * product-restricted items — the conservative choice, so an unresolved product
 * never silently drops a compliance checkpoint.
 */
export function productAppliesToItem(
  appliesToProducts: string[] | null | undefined,
  journeyProductIds: string[]
): boolean {
  if (!appliesToProducts || appliesToProducts.length === 0) return true;
  if (journeyProductIds.length === 0) return true;
  return appliesToProducts.some((id) => journeyProductIds.includes(id));
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
