import type { Call, CallStatus } from '@callguard/shared';
import { useScoreOnly } from '../context/AuthContext';

const statusConfig: Record<CallStatus, { label: string; className: string }> = {
  captured: {
    label: 'Awaiting sale',
    className: 'bg-table-header text-text-muted',
  },
  uploaded: {
    label: 'Uploaded',
    className: 'bg-processing-bg text-processing',
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

export function CallStatusBadge({
  status,
  pass,
  ingestionSource,
}: {
  status: CallStatus;
  pass?: boolean | null;
  /**
   * Where the call came from. Only consulted for 'captured': a dialler capture
   * rests there until a sale arrives, but a bulk-imported recording is
   * 'captured' only until its own job downloads it (services/ingestion.ts
   * importRemoteCall), so "Awaiting sale" would be the wrong thing to say.
   */
  ingestionSource?: Call['ingestion_source'];
}) {
  const scoreOnly = useScoreOnly();
  let config = statusConfig[status];

  if (status === 'captured' && ingestionSource && ingestionSource !== 'dialer_webhook') {
    config = { label: 'Fetching recording', className: 'bg-processing-bg text-processing' };
  }

  // Override scored status based on pass/fail. pass === undefined (still
  // loading, or the scores fetch errored) intentionally falls through to the
  // neutral 'Scored' default above rather than showing Pass or Fail. In
  // score-only mode we never surface the verdict — the neutral 'Scored' pill
  // stands in for pass/fail/review.
  if (status === 'scored' && !scoreOnly) {
    if (pass === true) {
      config = { label: 'Pass', className: 'bg-pass-bg text-pass' };
    } else if (pass === false) {
      config = { label: 'Fail', className: 'bg-fail-bg text-fail' };
    } else if (pass === null) {
      config = { label: 'Review', className: 'bg-review-bg text-review' };
    }
  }

  return (
    <span className={`inline-block px-2.5 py-[3px] rounded-full text-badge font-semibold ${config.className}`}>
      {config.label}
    </span>
  );
}
