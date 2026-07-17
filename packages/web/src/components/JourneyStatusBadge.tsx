import type { JourneyStatus } from '@callguard/shared';

// Canonical journey-status pill (DESIGN_SYSTEM §4) — mirrors CallStatusBadge's
// shape. In-flight states pulse, matching the motion language used for call
// processing states. Pass/fail overrides for 'scored' are handled by the
// caller where the verdict is known (list rows show score + pass separately).
const statusConfig: Record<JourneyStatus, { label: string; className: string }> = {
  pending: {
    label: 'Pending',
    className: 'bg-table-header text-text-muted',
  },
  scoring: {
    label: 'Scoring',
    className: 'bg-processing-bg text-processing animate-pulse',
  },
  scored: {
    label: 'Scored',
    className: 'bg-pass-bg text-pass',
  },
  failed: {
    label: 'Failed',
    className: 'bg-fail-bg text-fail',
  },
};

export function JourneyStatusBadge({ status }: { status: JourneyStatus }) {
  const config = statusConfig[status] ?? statusConfig.pending;
  return (
    <span className={`inline-block px-2.5 py-[3px] rounded-full text-badge font-semibold ${config.className}`}>
      {config.label}
    </span>
  );
}
