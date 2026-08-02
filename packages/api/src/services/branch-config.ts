import type { BranchConfig } from '@callguard/shared';

/**
 * Merge an incoming branch_config over the stored one, preserving the CRM
 * mapping fields when the caller omits them.
 *
 * The scorecard editor exposes only `branches` and `keywords`, so it rebuilds
 * branch_config from those two — and a PUT that replaced the column outright
 * therefore deleted `crm_values` / `no_score_crm_values` every time an admin
 * saved an unrelated change. That map is the authoritative signal for whether a
 * policy went on risk, so losing it silently downgrades every subsequent sale to
 * a guessed branch and stops "not taken up" stages being skipped at all.
 *
 * Omission (the key absent) preserves; an explicit `null` clears. That keeps
 * deliberate removal possible without making it the accidental default. A
 * preserved mapping that no longer matches `branches` is not quietly pruned —
 * validateBranchConfig rejects it, so a branch rename that would orphan the map
 * fails loudly instead of scoring later sales on a guess.
 */
export function mergeBranchConfig(
  stored: BranchConfig | null,
  incoming: unknown
): BranchConfig | null | undefined {
  if (incoming === undefined) return undefined; // not part of this update
  if (incoming === null) return null; // branching removed outright
  if (typeof incoming !== 'object') return incoming as BranchConfig;

  const next = { ...(incoming as Partial<BranchConfig>) } as BranchConfig;
  let preservedMap = false;
  if (!('crm_values' in next) && stored?.crm_values) {
    next.crm_values = stored.crm_values;
    preservedMap = true;
  }
  if (!('no_score_crm_values' in next) && stored?.no_score_crm_values) {
    next.no_score_crm_values = stored.no_score_crm_values;
    preservedMap = true;
  }
  // `detect` belongs to the same mapping: preserved crm_values that came back
  // under detect='keyword' would still never be consulted, so the map would be
  // intact in the row and dead in practice. A caller that didn't send crm_values
  // isn't CRM-aware, which makes its `detect` a default rather than a decision —
  // so the stored mode wins here, not the payload's.
  if (preservedMap && stored?.detect) {
    next.detect = stored.detect;
  }
  return next;
}
