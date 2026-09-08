import type { FeedbackStatus } from '@callguard/shared';
import { FEEDBACK_STATUS_LABELS } from '@callguard/shared';

// Where a sale sits in the acknowledgement loop (CG-11). Same pill shape as
// JourneyStatusBadge (DESIGN_SYSTEM §4).
//
// None of the three is a bad outcome, so none uses fail styling. "Not fed back"
// in particular is the normal state of a sale nobody has got to yet — colouring
// it red would read as a breach against the adviser rather than a queue
// position. Waiting is the one state that ages, so it carries the warn tone
// that the review queue already uses for "needs a person".
const config: Record<FeedbackStatus, string> = {
  not_fed_back: 'bg-table-header text-text-muted',
  awaiting: 'bg-review-bg text-review',
  acknowledged: 'bg-pass-bg text-pass',
};

export function FeedbackStatusBadge({
  status,
  // Whole days the sale has been waiting. Rendered only for 'awaiting', where
  // it is the number a supervisor is actually managing — "fed back 9 days ago,
  // still not confirmed". Omitted at 0 days, where "today" is what a reader
  // wants and a "0d" pill reads like a bug.
  waitingDays,
}: {
  status: FeedbackStatus;
  waitingDays?: number | null;
}) {
  const showAge = status === 'awaiting' && typeof waitingDays === 'number' && waitingDays > 0;
  return (
    <span
      // nowrap: "Awaiting confirmation" is wide enough to break mid-phrase in a
      // table column, which turns a pill into two stacked fragments. The table
      // already scrolls horizontally, so let the column carry the width.
      className={`inline-block whitespace-nowrap px-2.5 py-[3px] rounded-full text-badge font-semibold ${config[status]}`}
      // The age is part of the meaning, not decoration, so it belongs in the
      // accessible name rather than only in the visible suffix.
      title={showAge ? `${FEEDBACK_STATUS_LABELS[status]} — ${waitingDays} days` : undefined}
    >
      {FEEDBACK_STATUS_LABELS[status]}
      {showAge && <span className="ml-1 font-normal opacity-80">{waitingDays}d</span>}
    </span>
  );
}
