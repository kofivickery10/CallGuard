import { REMEDIATION_OUTCOME_REPORT_LABELS, type RemediationOutcome } from '@callguard/shared';

// What an adviser said they did about a finding, as it appears in a document
// somebody outside the conversation reads (CG-26) — the claims-defence pack and
// the board pack.
//
// The report labels, not the adviser-facing ones: "Sorted" is how the answer is
// offered to the person answering, and is not how it should read to an insurer,
// the Ombudsman or a board.
//
// 'not_needed' is deliberately neutral rather than green. It is a legitimate
// answer, but it is the adviser declining to act, and colouring it as a good
// outcome would put a thumb on the scale in the one document where that matters
// most. 'customer_unreachable' carries the review tone for the same reason in
// the other direction: nothing is wrong with it, but it is unfinished.
const outcomeClass: Record<RemediationOutcome, string> = {
  done: 'bg-pass-bg text-pass',
  not_needed: 'bg-table-header text-text-muted',
  customer_unreachable: 'bg-review-bg text-review',
};

export function RemediationOutcomeBadge({ outcome }: { outcome: RemediationOutcome }) {
  return (
    <span className={`px-2.5 py-[3px] rounded-full text-badge font-semibold ${outcomeClass[outcome]}`}>
      {REMEDIATION_OUTCOME_REPORT_LABELS[outcome]}
    </span>
  );
}

// No answer yet. Its own component rather than a fourth badge variant, because
// it is not a fourth answer: nobody has said anything, and a badge sitting in
// the row with the other three would read as though somebody had.
export function AwaitingOutcomeBadge() {
  return (
    <span className="px-2.5 py-[3px] rounded-full text-badge font-semibold bg-processing-bg text-processing">
      No answer recorded
    </span>
  );
}
