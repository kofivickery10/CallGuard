import {
  BREACH_SEVERITY_LABELS,
  BREACH_STATUS_LABELS,
  type BreachSeverity,
  type BreachStatus,
} from '@callguard/shared';

const severityClass: Record<BreachSeverity, string> = {
  critical: 'bg-fail-bg text-fail',
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

export function SeverityBadge({ severity }: { severity: BreachSeverity }) {
  return (
    <span
      className={`px-2 py-[2px] rounded text-[11px] font-bold uppercase tracking-wider ${severityClass[severity]}`}
    >
      {BREACH_SEVERITY_LABELS[severity]}
    </span>
  );
}

export function StatusBadge({ status }: { status: BreachStatus }) {
  return (
    <span
      className={`px-2.5 py-[3px] rounded-[20px] text-badge font-semibold ${statusClass[status]}`}
    >
      {BREACH_STATUS_LABELS[status]}
    </span>
  );
}
