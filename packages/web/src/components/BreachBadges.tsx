import {
  BREACH_SEVERITY_LABELS,
  BREACH_STATUS_LABELS,
  type BreachSeverity,
  type BreachStatus,
} from '@callguard/shared';

const severityClass: Record<BreachSeverity, string> = {
  critical: 'bg-fail-bg text-fail relative animate-breach-pulse',
  high: 'bg-fail-bg/80 text-fail',
  medium: 'bg-review-bg text-review',
  low: 'bg-table-header text-text-muted',
};

const statusClass: Record<BreachStatus, string> = {
  new: 'bg-processing-bg text-processing',
  acknowledged: 'bg-primary-light text-pass',
  coached: 'bg-primary-light text-pass',
  escalated: 'bg-fail-bg text-fail',
  resolved: 'bg-pass-bg text-pass',
  noted: 'bg-table-header text-text-muted',
};

// On the canonical pill recipe (DESIGN_SYSTEM §4): rounded-full + text-badge,
// replacing the squared, uppercase, bold variant this was. `critical` keeps the
// breach-pulse the brand reserves for a live critical breach.
// `count` turns the pill into a tally ("2 critical") for places that summarise
// several breaches at once, such as a customer's open findings.
export function SeverityBadge({ severity, count }: { severity: BreachSeverity; count?: number }) {
  return (
    <span
      className={`inline-block whitespace-nowrap px-2.5 py-[3px] rounded-full text-badge font-semibold ${severityClass[severity]}`}
    >
      {count === undefined
        ? BREACH_SEVERITY_LABELS[severity]
        : `${count} ${BREACH_SEVERITY_LABELS[severity].toLowerCase()}`}
    </span>
  );
}

export function StatusBadge({ status }: { status: BreachStatus }) {
  return (
    <span
      className={`px-2.5 py-[3px] rounded-full text-badge font-semibold ${statusClass[status]}`}
    >
      {BREACH_STATUS_LABELS[status]}
    </span>
  );
}
