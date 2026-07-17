import type { ItemResult } from '@callguard/shared';

// Single source of truth for how a checkpoint result renders across call and
// journey views. Critically, `na` and `manual_review` must NOT render as a red
// "Fail" — they were never AI-scored and are excluded from the score.
const STYLES: Record<ItemResult, { label: string; className: string }> = {
  pass: { label: 'Pass', className: 'bg-pass-bg text-pass' },
  fail: { label: 'Fail', className: 'bg-fail-bg text-fail' },
  na: { label: 'N/A', className: 'bg-table-header text-text-muted' },
  manual_review: { label: 'Needs review', className: 'bg-review-bg text-review' },
};

export function ItemResultBadge({ result }: { result: ItemResult }) {
  const s = STYLES[result] ?? STYLES.na;
  return (
    <span className={`px-2.5 py-[3px] rounded-full text-badge font-semibold ${s.className}`}>
      {s.label}
    </span>
  );
}
