import type { ReconciliationOutcome, AmendmentType } from '@callguard/shared';

// Single source of truth for how a reconciliation outcome renders.
//
// `undetermined` is deliberately neutral, not a failure. It means the system
// could not establish an answer — usually because health redaction removed the
// words identifying the question — and dressing that as a miss would put a false
// allegation against an adviser on screen.
const OUTCOME_STYLES: Record<ReconciliationOutcome, { label: string; className: string }> = {
  match: { label: 'Matches', className: 'bg-pass-bg text-pass' },
  mismatch: { label: 'Does not match', className: 'bg-fail-bg text-fail' },
  // Deliberately not the same red as a mismatch. The application declared MORE
  // than the customer said, which cannot void a policy — it makes the cover
  // dearer than it needed to be. Still needs correcting, so it is not neutral
  // either, and the label says which way round it is rather than relying on the
  // tone to carry it (§7).
  over_declaration: { label: 'More declared than said', className: 'bg-review-bg text-review' },
  not_asked: { label: 'Not asked', className: 'bg-fail-bg text-fail' },
  asked_no_answer: { label: 'No answer given', className: 'bg-review-bg text-review' },
  no_application_answer: { label: 'Not on application', className: 'bg-table-header text-text-muted' },
  // Presence-mode fields. 'recorded' reads as neutral rather than a pass on
  // purpose: it says the form carries a value, and claims nothing at all about
  // the call, so it must not wear the same green as a verified match.
  recorded: { label: 'On application', className: 'bg-table-header text-text-muted' },
  missing_from_application: { label: 'Left blank', className: 'bg-fail-bg text-fail' },
  undetermined: { label: 'Could not verify', className: 'bg-table-header text-text-muted' },
};

export function ReconciliationBadge({ outcome }: { outcome: ReconciliationOutcome }) {
  const s = OUTCOME_STYLES[outcome] ?? OUTCOME_STYLES.undetermined;
  return (
    <span className={`px-2.5 py-[3px] rounded-full text-badge font-semibold ${s.className}`}>
      {s.label}
    </span>
  );
}

// An amendment is orthogonal to the outcome: an answer can match and still have
// been changed on the way there. Only a withdrawal reads as a warning — an
// adviser capturing MORE as the conversation develops is the system working, and
// flagging it would train supervisors to ignore the queue.
const AMENDMENT_STYLES: Record<AmendmentType, { label: string; className: string }> = {
  disclosure_withdrawn: { label: 'Disclosure withdrawn', className: 'bg-fail-bg text-fail' },
  disclosure_added: { label: 'Disclosure added', className: 'bg-table-header text-text-muted' },
  value_changed: { label: 'Answer changed', className: 'bg-table-header text-text-muted' },
};

export function AmendmentBadge({ type }: { type: AmendmentType }) {
  const s = AMENDMENT_STYLES[type];
  if (!s) return null;
  return (
    <span className={`px-2.5 py-[3px] rounded-full text-badge font-semibold ${s.className}`}>
      {s.label}
    </span>
  );
}
