import { PASS_THRESHOLD } from './constants.js';
import type { BreachSeverity } from './types/breaches.js';

/** Whether a single scorecard item's normalized score (0-100) is a pass. */
export function isItemPass(normalizedScore: number): boolean {
  return normalizedScore >= PASS_THRESHOLD;
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
 * Whether a whole call passes: at or above the overall pass threshold AND with
 * no critical-severity breach. A critical failure fails the call regardless of
 * the overall score, so a high percentage cannot mask a regulator-grade miss.
 */
export function callPasses(overallScore: number, failingSeverities: BreachSeverity[]): boolean {
  return overallScore >= PASS_THRESHOLD && !failingSeverities.includes('critical');
}
