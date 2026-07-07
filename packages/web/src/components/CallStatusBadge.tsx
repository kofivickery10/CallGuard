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
    // Neutral default — the pass/fail override below decides the real label.
    // Never default a compliance result to "Pass": while the separate
    // /calls/:id/scores fetch is still loading (pass is undefined), or if it
    // errors, this must not read as a passing call.
    label: 'Scored',
    className: 'bg-table-header text-text-muted',
  },
  skipped: {
    label: 'Too short',
    className: 'bg-table-header text-text-muted',
  },
  failed: {
    label: 'Failed',
    className: 'bg-fail-bg text-fail',
  },
};

export function CallStatusBadge({ status, pass }: { status: CallStatus; pass?: boolean | null }) {
  let config = statusConfig[status];

  // Override scored status based on pass/fail. pass === undefined (still
  // loading, or the scores fetch errored) intentionally falls through to the
  // neutral 'Scored' default above rather than showing Pass or Fail.
  if (status === 'scored') {
    if (pass === true) {
      config = { label: 'Pass', className: 'bg-pass-bg text-pass' };
    } else if (pass === false) {
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
