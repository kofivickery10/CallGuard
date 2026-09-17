import type { BreachSeverity } from './breaches.js';
import type { CallStatus } from './call.js';
import type { FeedbackStatus, JourneyStatus } from './journey.js';
import type { ReconciliationRunStatus } from './reconciliation.js';

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

// ── GET /api/customers/:id — the profile ─────────────────────────────────────
//
// For an adviser, `compliance`, `sales` and every call's result are null: they
// describe the firm's findings across every adviser's calls, and an adviser is
// scoped to their own.
export interface CustomerRecord {
  id: string;
  phone_normalized: string;
  name: string | null;
  external_crm_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

// The calls behind the header's "calls 27 Jul – 16 Sept · 6 advisers". An
// adviser's figures are their own calls only.
export interface CustomerCallStats {
  call_count: number;
  first_call_at: string | null;
  last_call_at: string | null;
  adviser_count: number;
}

export interface CustomerCall {
  id: string;
  called_at: string;
  adviser_name: string | null;
  duration_seconds: number | null;
  status: CallStatus;
  // Whether any sale includes this call (journey_calls).
  in_sale: boolean;
  // A calls firm's per-call result. Null for a sales firm, for an adviser, and
  // for a call that has not been scored.
  score: { overall_score: number | null; pass: boolean | null } | null;
  // Breaches on this call by severity. Null for a sales firm (its breaches sit
  // on the sale) and for an adviser.
  open: SeverityCounts | null;
  closed: SeverityCounts | null;
  // Only for a scored call not in a sale, at a firm that scores calls: the only
  // calls that are fed back on their own.
  feedback_status: FeedbackStatus | null;
  feedback_sent_at: string | null;
}

export interface CustomerSaleCall {
  id: string;
  called_at: string;
  adviser_name: string | null;
  duration_seconds: number | null;
  status: CallStatus;
  // 'wrap_up' is the closing call.
  role: 'wrap_up' | 'context';
}

export interface CustomerSale {
  id: string;
  status: JourneyStatus;
  sale_date: string;
  scored_at: string | null;
  overall_score: number | null;
  // Null under score_only.
  pass: boolean | null;
  // Null until the sale is scored.
  feedback_status: FeedbackStatus | null;
  feedback_sent_at: string | null;
  oldest_remediation_days: number | null;
  closing_adviser_name: string | null;
  adviser_count: number;
  open: SeverityCounts;
  closed: SeverityCounts;
  // The latest reconciliation run's status. Null when the firm does not use
  // reconciliation, or the sale has no run.
  reconciliation_status: ReconciliationRunStatus | null;
  // Oldest first.
  calls: CustomerSaleCall[];
}

// What "Score calls as a sale" would do if pressed now: the same call
// selection, in-flight check and already-scored check as the trigger itself
// (services/journey.ts), so the confirmation lists what will actually happen.
export interface CustomerSalePreviewCall {
  id: string;
  called_at: string;
  adviser_name: string | null;
  duration_seconds: number | null;
  status: CallStatus;
  // Set when the call is currently credited to a sale.
  sale_id: string | null;
  // True for a call from another number linked to this person.
  from_linked_number: boolean;
}

export interface CustomerSalePreview {
  window_days: number;
  // Oldest first.
  calls: CustomerSalePreviewCall[];
  // A sale already being assembled or scored; pressing would return it.
  in_flight_sale_id: string | null;
  // The latest scored sale already covers exactly these calls; pressing would
  // score nothing.
  covered_by_sale_id: string | null;
}

export interface CustomerProfileResponse {
  customer: CustomerRecord;
  mode: CustomerScoringMode;
  score_only: boolean;
  reconciliation_enabled: boolean;
  stats: CustomerCallStats;
  // Null for an adviser.
  compliance: CustomerCompliance | null;
  // Newest first. Null for an adviser, who cannot open a sale.
  sales: CustomerSale[] | null;
  // Every call, newest first (an adviser's own only, for an adviser).
  calls: CustomerCall[];
  // Admin and supervisor at a firm that scores sales; null otherwise.
  sale_preview: CustomerSalePreview | null;
}

// ── GET /api/customers — the list ────────────────────────────────────────────

// The tabs each kind of firm works along, keyed as the `tab` query param and the
// `counts` response. A firm that scores sales asks whether a customer has one; a
// firm that scores calls asks whether any of their calls has been assessed.
export const CUSTOMER_SALES_TABS = ['all', 'scored', 'open_findings', 'not_fed_back', 'no_sale'] as const;
export const CUSTOMER_CALLS_TABS = ['all', 'assessed', 'open_findings', 'not_fed_back', 'not_assessed'] as const;
export type CustomerListTab =
  | (typeof CUSTOMER_SALES_TABS)[number]
  | (typeof CUSTOMER_CALLS_TABS)[number];

export const CUSTOMER_LIST_SORTS = ['last_contact', 'most_calls', 'lowest_score'] as const;
export type CustomerListSort = (typeof CUSTOMER_LIST_SORTS)[number];

// A row's latest result. For a firm that scores sales: its latest sale, in any
// status (so a sale still being scored reads as that, not as "not assessed").
// For a firm that scores calls: its latest scored call.
export interface CustomerLatestResult {
  kind: 'sale' | 'call';
  id: string;
  // A JourneyStatus for a sale; always 'scored' for a call.
  status: JourneyStatus;
  overall_score: number | null;
  // Null under score_only: the verdict is not shipped.
  pass: boolean | null;
  // The sale's date (its last call) or the call's date.
  date: string;
}

export interface CustomerListRow {
  id: string;
  name: string | null;
  phone_normalized: string;
  external_crm_id: string | null;
  // Non-failed calls; an adviser's own calls only, for an adviser.
  call_count: number;
  last_call_at: string | null;
  last_adviser_name: string | null;
  // Null for an adviser, like the two below: the firm's assessment of a
  // customer covers every adviser's calls.
  latest: CustomerLatestResult | null;
  // Open breaches by severity, across the customer's sales and calls.
  open_findings: SeverityCounts | null;
  // Of the latest scored sale (sales firm) or the latest scored call not in a
  // sale (calls firm). Null when there is none.
  feedback_status: FeedbackStatus | null;
}

export interface CustomerListResponse {
  data: CustomerListRow[];
  // The current tab's count: every filter that shapes the page also shapes it.
  total: number;
  page: number;
  limit: number;
  mode: CustomerScoringMode;
  sort: CustomerListSort;
  // The tabs this caller may use. An adviser gets 'all' only: the others count
  // the firm's findings and feedback.
  tabs: CustomerListTab[];
  // One entry per tab in `tabs`, under the current search.
  counts: Partial<Record<CustomerListTab, number>>;
}
