import type { CallStatus } from '@callguard/shared';

const statusConfig: Record<CallStatus, { label: string; className: string }> = {
  uploaded: {
    label: 'Uploaded',
    className: 'bg-primary-light text-text-secondary',
  },
  transcribing: {
    label: 'Processing',
    className: 'bg-processing-bg text-processing animate-pulse',
  },
  transcribed: {
    label: 'Transcribed',
    className: 'bg-processing-bg text-processing',
  },
  scoring: {
    label: 'Scoring',
    className: 'bg-processing-bg text-processing animate-pulse',
  },
  scored: {
    label: 'Pass',
    className: 'bg-pass-bg text-pass',
  },
  failed: {
    label: 'Failed',
    className: 'bg-fail-bg text-fail',
  },
};

export function CallStatusBadge({ status, pass }: { status: CallStatus; pass?: boolean | null }) {
  let config = statusConfig[status];

  // Override scored status based on pass/fail
  if (status === 'scored') {
    if (pass === false) {
      config = { label: 'Fail', className: 'bg-fail-bg text-fail' };
    } else if (pass === null) {
      config = { label: 'Review', className: 'bg-review-bg text-review' };
    }
  }

  return (
    <span className={`inline-block px-2.5 py-[3px] rounded-[20px] text-badge font-semibold ${config.className}`}>
      {config.label}
    </span>
  );
}
