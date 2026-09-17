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
  // Deliberately not scored — the CRM stage marks the sale as not taken up.
  // Neutral styling, not fail styling: nothing went wrong and there is no
  // breach here, so it must not read as a bad outcome for the adviser.
  skipped: {
    label: 'Not taken up',
    className: 'bg-table-header text-text-muted',
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

// The same three in-pipeline states as they read on the sales list, where the
// column they sit in is where a score would otherwise be.
//
// 'failed' is deliberately NOT the red "Failed" above. On a register of
// compliance results, a red Failed against a sale reads as "this sale failed" —
// it means scoring broke, which is the firm's problem to retry and says nothing
// at all about the adviser. All three therefore carry processing tones, and the
// wording says what happened: nothing was scored.
const processingConfig: Record<'pending' | 'scoring' | 'failed', { label: string; className: string }> = {
  pending: { label: 'Waiting to score', className: 'bg-processing-bg text-processing' },
  scoring: { label: 'Scoring', className: 'bg-processing-bg text-processing animate-pulse' },
  failed: { label: 'Not scored', className: 'bg-processing-bg text-processing' },
};

export function ProcessingStateBadge({ status }: { status: 'pending' | 'scoring' | 'failed' }) {
  const config = processingConfig[status] ?? processingConfig.pending;
  return (
    <span className={`inline-block px-2.5 py-[3px] rounded-full text-badge font-semibold ${config.className}`}>
      {config.label}
    </span>
  );
}
