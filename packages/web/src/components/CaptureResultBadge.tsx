import type { CaptureAnswerResult } from '@callguard/shared';

// Single source of truth for how a captured answer's result renders.
// `confirmed_only` is a success state (the answer WAS given — its value is
// suppressed because it's personal data), so it must not read as a failure.
const STYLES: Record<CaptureAnswerResult, { label: string; className: string }> = {
  captured: { label: 'Captured', className: 'bg-pass-bg text-pass' },
  confirmed_only: { label: 'Confirmed', className: 'bg-processing-bg text-processing' },
  missed: { label: 'Missed', className: 'bg-fail-bg text-fail' },
  na: { label: 'N/A', className: 'bg-table-header text-text-muted' },
  manual_review: { label: 'Needs review', className: 'bg-review-bg text-review' },
};

export function CaptureResultBadge({ result }: { result: CaptureAnswerResult }) {
  const s = STYLES[result] ?? STYLES.na;
  return (
    <span className={`px-2.5 py-[3px] rounded-full text-badge font-semibold ${s.className}`}>
      {s.label}
    </span>
  );
}
