import type { ItemResult } from '@callguard/shared';

// Single source of truth for how a checkpoint result renders across call and
// journey views. Critically, `na` and `manual_review` must NOT render as a red
// "Fail" — they were never AI-scored and are excluded from the score.
//
// Each result carries a drawn glyph as well as its label, so a verdict is
// recognisable at a glance down a column of forty checkpoints, and readable
// without relying on the colour (DESIGN_SYSTEM §7).
const STYLES: Record<ItemResult, { label: string; className: string; path: string }> = {
  pass: { label: 'Pass', className: 'bg-pass-bg text-pass', path: 'M20 6 9 17l-5-5' },
  fail: { label: 'Fail', className: 'bg-fail-bg text-fail', path: 'M18 6 6 18M6 6l12 12' },
  na: { label: 'N/A', className: 'bg-table-header text-text-muted', path: 'M5 12h14' },
  manual_review: {
    label: 'Needs review',
    className: 'bg-review-bg text-review',
    path: 'M12 8v5M12 16.5v.5M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  },
};

export function ItemResultBadge({ result }: { result: ItemResult }) {
  const s = STYLES[result] ?? STYLES.na;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-[3px] rounded-full text-badge font-semibold ${s.className}`}
    >
      <svg
        className="w-3.5 h-3.5 flex-none"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={s.path} />
      </svg>
      {s.label}
    </span>
  );
}
