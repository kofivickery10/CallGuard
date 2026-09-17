import type { BreachSeverity } from './breaches.js';

// What a firm scores, as the customer screens read it. Decided on the server by
// scoresCallsIndividually (services/tenant-settings.ts) — the firm's own
// scoring setting and nothing else, never whether a CRM is connected.
export type CustomerScoringMode = 'sales' | 'calls';

export type SeverityCounts = Record<BreachSeverity, number>;

// Everything the profile needs to say, honestly, where one customer stands on
// compliance. Counts only: the sentence is built by
// summariseCustomerCompliance below, so the page and its tests agree on it.
export interface CustomerCompliance {
  // Sales for this customer with status 'scored'.
  scored_sales: number;
  // Calls for this customer with at least one call_scores row.
  scored_calls: number;
  // Breaches still being worked: any status but 'resolved' or 'noted' — the
  // same definition as the breaches summary (routes/breaches.ts).
  open: SeverityCounts;
  // Breaches a supervisor has closed, as 'resolved' or 'noted'.
  closed: SeverityCounts;
  resolved: number;
  noted: number;
}

// Three states, because "no breaches" meant two different things and the page
// used to say "Clean" for both. A customer nobody has assessed has no findings
// because nothing was looked at, which is not the same fact as an assessed
// customer whose findings are all closed.
export type CustomerComplianceState = 'not_assessed' | 'no_open' | 'open';

// Tone only ever adds to the words; it never carries the state alone.
export type CustomerComplianceTone = 'neutral' | 'pass' | 'review' | 'fail';

export interface CustomerComplianceSummary {
  state: CustomerComplianceState;
  tone: CustomerComplianceTone;
  headline: string;
  detail: string;
  open_total: number;
  closed_total: number;
}

export function sumSeverities(counts: SeverityCounts): number {
  return counts.critical + counts.high + counts.medium + counts.low;
}

/** "2 critical · 1 high", omitting severities with nothing in them. */
export function severityBreakdown(counts: SeverityCounts): string {
  return (['critical', 'high', 'medium', 'low'] as const)
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`)
    .join(' · ');
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Where one customer stands, as a headline, a line of detail and a tone.
 *
 * - open: at least one breach is still open. Coloured by the worst open
 *   severity — fail for critical or high, review for medium or low. The count
 *   is never zero in this state, so "0 open" can never be drawn in red.
 * - no_open: something about the customer has been scored (or a closed breach
 *   exists), and nothing is open.
 * - not_assessed: nothing has been scored, and there are no breaches at all.
 *   Neutral: the absence of findings here says nothing about the customer.
 */
export function summariseCustomerCompliance(
  c: CustomerCompliance,
  mode: CustomerScoringMode
): CustomerComplianceSummary {
  const openTotal = sumSeverities(c.open);
  const closedTotal = sumSeverities(c.closed);

  if (openTotal > 0) {
    return {
      state: 'open',
      tone: c.open.critical > 0 || c.open.high > 0 ? 'fail' : 'review',
      headline: `${openTotal} open`,
      detail: severityBreakdown(c.open),
      open_total: openTotal,
      closed_total: closedTotal,
    };
  }

  const assessed = c.scored_sales + c.scored_calls > 0 || closedTotal > 0;
  if (!assessed) {
    return {
      state: 'not_assessed',
      tone: 'neutral',
      headline: 'Not yet assessed',
      detail: mode === 'sales' ? 'No sale has been scored yet' : 'No call has been scored yet',
      open_total: 0,
      closed_total: 0,
    };
  }

  const closedParts = [
    c.resolved > 0 ? `${c.resolved} resolved` : null,
    c.noted > 0 ? `${c.noted} noted` : null,
  ].filter(Boolean);
  const scoredLabel =
    mode === 'sales'
      ? plural(c.scored_sales, 'scored sale')
      : plural(c.scored_calls, 'scored call');

  return {
    state: 'no_open',
    tone: 'pass',
    headline: 'No open findings',
    detail: closedParts.length > 0 ? closedParts.join(' · ') : `Nothing found on ${scoredLabel}`,
    open_total: 0,
    closed_total: closedTotal,
  };
}

// GET /api/customers/:id — one customer. For an adviser, the sale fields are
// null and `compliance` is null: those describe the firm's findings across
// every adviser's calls, and an adviser is scoped to their own.
export interface CustomerRecord {
  id: string;
  phone_normalized: string;
  name: string | null;
  external_crm_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  // Non-failed calls; an adviser's own calls only, for an adviser.
  call_count: number;
  journey_count: number | null;
  last_journey_score: string | null;
  last_journey_pass: boolean | null;
  last_journey_at: string | null;
}

export interface CustomerProfileResponse {
  customer: CustomerRecord;
  mode: CustomerScoringMode;
  compliance: CustomerCompliance | null;
}
