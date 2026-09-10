import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  REMEDIATION_OUTCOMES,
  REMEDIATION_OUTCOME_LABELS,
  REMEDIATION_NOTE_MAX,
} from '@callguard/shared';
import type { RemediationOutcome } from '@callguard/shared';

// The adviser's landing page from the email: it checks the link (GET), asks for
// a deliberate click to confirm (POST), and then asks what they did about each
// finding (CG-25).
//
// UNAUTHENTICATED and outside the app shell on purpose: the recipient may have no
// login at all (no-login advisers), so anything requiring a session would make
// the link useless to exactly the people it exists for.
//
// WHAT THIS PAGE DISCLOSES, AND WHAT IT STILL MUST NOT
//
// It shows the findings the adviser was already emailed, the firm's own
// instruction about each one, and whatever outcome they have recorded. That is a
// deliberate widening of what it used to show (a name and a count) and it is
// the point of the page: an adviser cannot honestly confirm they have seen
// feedback on a page that will not tell them what it was, and cannot record an
// outcome against a finding it will not name.
//
// It still names no customer, states no client name, shows no score, links to
// no sale, and carries no transcript or quoted evidence. The model's reasoning
// appears only where it already travelled in the email — on a tenant that keeps
// health unredacted the server withholds it here too (DPIA R5), and the page
// says so rather than showing a list with silent gaps in it.
//
// A page load alone must never record anything: mail-security gateways
// routinely prefetch links in emails.

type Status = 'loading' | 'pending' | 'confirmed' | 'already_confirmed' | 'expired' | 'not_found' | 'error';

interface Finding {
  id: string;
  label: string;
  severity: string;
  reasoning: string | null;
  remediationGuidance: string | null;
  outcome: RemediationOutcome | null;
  note: string | null;
  recordedAt: string | null;
}

interface LookupResponse {
  status: 'pending' | 'confirmed' | 'already_confirmed' | 'expired' | 'not_found';
  adviserName?: string;
  itemCount?: number;
  items?: Finding[];
  reasoningWithheld?: boolean;
  canRecordOutcome?: boolean;
}

interface OutcomeResponse {
  status: 'recorded' | 'not_confirmed' | 'expired' | 'not_found' | 'invalid_outcome';
  item?: Finding;
}

const SEVERITY_CLASS: Record<string, string> = {
  critical: 'bg-fail-bg text-fail',
  high: 'bg-fail-bg text-fail',
  medium: 'bg-review-bg text-review',
  low: 'bg-table-header text-text-secondary',
};

/** Per-outcome icon, so the chosen answer is never carried by colour alone. */
const OUTCOME_ICON: Record<RemediationOutcome, string> = {
  done: 'M20 6 9 17l-5-5',
  not_needed: 'M5 12h14',
  customer_unreachable: 'M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 6.18 2 2 0 0 1 4.11 4h3a2 2 0 0 1 2 1.72M22 2 2 22',
};

function TickIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" strokeWidth="1.8" aria-hidden="true">
      <path
        d="M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" strokeWidth="1.8" aria-hidden="true">
      <path
        d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" strokeWidth="1.8" aria-hidden="true">
      <path
        d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function OutcomeIcon({ outcome, className }: { outcome: RemediationOutcome; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" strokeWidth="1.8" aria-hidden="true">
      <path d={OUTCOME_ICON[outcome]} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Per-finding request state. Keyed by item id so one slow request cannot make
 *  another finding look like it is saving.
 *
 *  Deliberately carries no `saved` flag. Whether an answer is stored is a
 *  property of the server row the card is rendering, so it is derived from that
 *  row and cannot survive the row being replaced or re-read. */
type SaveState = { saving: boolean; error: string | null };

const IDLE: SaveState = { saving: false, error: null };

/**
 * One finding, with the firm's instruction and the adviser's answer.
 *
 * `editable` is false before the feedback has been acknowledged. The controls
 * are hidden rather than disabled in that state because there is nothing to
 * explain yet — the confirm button is directly below and the answer is "press
 * that first", which the copy says.
 *
 * THE ANSWER IS A DRAFT UNTIL IT IS SAVED, ON PURPOSE
 *
 * The outcome buttons and the note box only touch local state; one explicit
 * Save writes both in a single request. Autosaving each control separately is
 * what an earlier version did and it was wrong in three ways at once. Picking an
 * outcome after typing a note fired the note's save first, which disabled the
 * outcome buttons mid-gesture — a disabled button receives no click, so the
 * adviser's new answer was silently dropped while the page said "Saved". Where
 * the click did land, two requests raced and the older outcome could be written
 * last. And one answer produced two `remediation_recorded` events, the first
 * asserting the outcome the adviser was moving away from — noise in a trail
 * whose whole purpose is evidential.
 *
 * A draft can be abandoned unsaved, so the unsaved state is stated rather than
 * left to be inferred.
 */
function FindingCard({
  finding,
  editable,
  save,
  state,
}: {
  finding: Finding;
  editable: boolean;
  save: (id: string, outcome: RemediationOutcome, note: string) => void;
  state: SaveState;
}) {
  // Seeded from the server row on mount. No re-sync effect: after a save the
  // parent swaps in the row that came back, which already equals this draft,
  // and a full refetch unmounts these cards (the page goes through 'loading')
  // so they re-seed naturally. An effect that copied props into state on every
  // change would instead overwrite whatever the adviser is part-way through
  // typing.
  const [chosen, setChosen] = useState<RemediationOutcome | null>(finding.outcome);
  const [note, setNote] = useState(finding.note ?? '');

  const dirty = chosen !== finding.outcome || note !== (finding.note ?? '');

  return (
    <li className="border-t border-border-light pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <p className="text-table-cell font-semibold text-text-primary">{finding.label}</p>
        <span
          className={`shrink-0 px-2.5 py-[3px] rounded-full text-badge font-semibold ${
            SEVERITY_CLASS[finding.severity] ?? SEVERITY_CLASS.low
          }`}
        >
          {finding.severity}
        </span>
      </div>

      {finding.reasoning && (
        <p className="text-table-cell text-text-secondary mt-1.5 leading-relaxed">{finding.reasoning}</p>
      )}

      {finding.remediationGuidance ? (
        <p className="text-table-cell text-text-primary mt-2 leading-relaxed">
          <span className="font-semibold">What to do: </span>
          {finding.remediationGuidance}
        </p>
      ) : (
        <p className="text-table-cell text-text-muted mt-2">
          Your firm has not set a step for this one.
        </p>
      )}

      {editable && (
        <div className="mt-3">
          <div
            role="radiogroup"
            aria-label={`What did you do about: ${finding.label}`}
            className="flex flex-wrap gap-2"
          >
            {REMEDIATION_OUTCOMES.map((o) => {
              const active = chosen === o;
              return (
                <button
                  key={o}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  // Never disabled: these only set local state, so there is no
                  // in-flight request for them to be dropped by.
                  onClick={() => setChosen(o)}
                  className={`inline-flex items-center gap-1.5 px-3 py-[7px] rounded-btn text-table-cell font-semibold border transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                    active
                      ? 'bg-primary-light border-primary text-primary'
                      : 'bg-card border-border text-text-secondary hover:bg-table-header'
                  }`}
                >
                  <OutcomeIcon outcome={o} className="w-4 h-4" />
                  {REMEDIATION_OUTCOME_LABELS[o]}
                </button>
              );
            })}
          </div>

          {/* Only once an answer is chosen. An empty note box against an
              unanswered finding invites a written explanation in place of the
              answer, which is the one thing this record cannot use. */}
          {chosen && (
            <div className="mt-2.5">
              <label
                htmlFor={`note-${finding.id}`}
                className="block text-table-header uppercase text-text-muted"
              >
                {chosen === 'customer_unreachable'
                  ? 'When did you try? (helps us show you tried)'
                  : 'Anything to add? (optional)'}
              </label>
              <textarea
                id={`note-${finding.id}`}
                value={note}
                maxLength={REMEDIATION_NOTE_MAX}
                rows={2}
                onChange={(e) => setNote(e.target.value)}
                placeholder={
                  chosen === 'customer_unreachable'
                    ? 'Called 2, 4 and 8 September, no answer. Left a voicemail.'
                    : 'Called the client and re-sent the paperwork.'
                }
                className="mt-1 w-full px-3 py-2 rounded-btn bg-card border border-border text-table-cell text-text-primary placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              />
            </div>
          )}

          {/* One write for the pair. Shown only once there is something to
              write, so an untouched finding carries no call to action. */}
          {chosen && (
            <div className="flex items-center gap-3 mt-2.5">
              <button
                type="button"
                disabled={state.saving || !dirty}
                onClick={() => save(finding.id, chosen, note)}
                aria-label={`Save what you did about: ${finding.label}`}
                className="px-[14px] py-[7px] rounded-btn text-table-cell font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {state.saving ? 'Saving…' : 'Save this answer'}
              </button>

              <div aria-live="polite" className="min-h-[18px]">
                {state.error && (
                  <span className="text-badge text-fail" role="alert">
                    {state.error}
                  </span>
                )}
                {/* Unsaved beats saved: a draft edited after a successful write
                    must not keep showing "Saved" over the newer, unsaved
                    answer. */}
                {!state.error && dirty && (
                  <span className="text-badge text-review">Not saved yet</span>
                )}
                {!state.error && !dirty && finding.outcome && (
                  <span className="text-badge text-pass">Saved</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {!editable && chosen && (
        <p className="text-table-cell text-text-secondary mt-2">
          You answered: {REMEDIATION_OUTCOME_LABELS[chosen]}
        </p>
      )}
    </li>
  );
}

export function FeedbackConfirm() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<Status>('loading');
  const [name, setName] = useState<string | null>(null);
  const [itemCount, setItemCount] = useState<number | null>(null);
  const [items, setItems] = useState<Finding[]>([]);
  const [reasoningWithheld, setReasoningWithheld] = useState(false);
  const [canRecordOutcome, setCanRecordOutcome] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});

  const applyLookup = (data: LookupResponse) => {
    // Cleared with the data it described. A "couldn't save that" left over from
    // a previous round would otherwise sit beside a freshly re-read row that
    // may well hold the answer it claims was lost.
    setSaveState({});
    setName(data.adviserName ?? null);
    setItemCount(data.itemCount ?? null);
    setItems(data.items ?? []);
    setReasoningWithheld(!!data.reasoningWithheld);
    setCanRecordOutcome(!!data.canRecordOutcome);
    setStatus(data.status);
  };

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        const res = await fetch(`/api/feedback/${token}`);
        if (!res.ok) throw new Error(String(res.status));
        const data: LookupResponse = await res.json();
        if (cancelled) return;
        applyLookup(data);
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  // The adviser's deliberate click. Kept separate from the GET on mount so that
  // a mail-security gateway prefetching the emailed link — which only ever
  // loads the page — can never confirm anything on the adviser's behalf.
  //
  // Re-reads through the GET afterwards rather than trusting the POST's own
  // body: confirmation is what unlocks outcome capture, so the page needs the
  // full post-confirmation state, and one source of truth for it is cheaper to
  // reason about than two.
  const handleConfirm = async () => {
    setConfirming(true);
    setConfirmError(null);
    try {
      const res = await fetch(`/api/feedback/${token}/confirm`, { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      const data: LookupResponse = await res.json();
      if (data.status === 'confirmed' || data.status === 'already_confirmed') {
        setAttempt((n) => n + 1);
        return;
      }
      applyLookup(data);
    } catch {
      // Stay on the 'pending' branch and offer a retry inline, rather than
      // dropping to the full-page 'error' branch — the link itself is fine,
      // only the confirm attempt failed, and the button should stay usable.
      setConfirmError("We couldn't record that just now. Please try again.");
    } finally {
      setConfirming(false);
    }
  };

  /**
   * Record one outcome. Optimistic in the state it shows, never in the record:
   * the row the server returns replaces the local one, so a truncated note or a
   * rejected write is visible immediately rather than at the next page load.
   */
  const saveOutcome = async (id: string, outcome: RemediationOutcome, note: string) => {
    setSaveState((s) => ({ ...s, [id]: { saving: true, error: null } }));
    try {
      const res = await fetch(`/api/feedback/${token}/items/${id}/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome, note }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data: OutcomeResponse = await res.json();

      if (data.status === 'recorded' && data.item) {
        const saved = data.item;
        setItems((list) => list.map((f) => (f.id === saved.id ? saved : f)));
        setSaveState((s) => ({ ...s, [id]: { saving: false, error: null } }));
        return;
      }

      // The link's own state has moved on under them — expired, or the
      // supervisor re-sent and this feedback is no longer the open one. Re-read
      // rather than leave a page that will keep failing silently.
      if (data.status === 'expired' || data.status === 'not_found' || data.status === 'not_confirmed') {
        setAttempt((n) => n + 1);
        return;
      }
      throw new Error(data.status);
    } catch {
      setSaveState((s) => ({
        ...s,
        [id]: { saving: false, error: "Couldn't save that. Try again." },
      }));
    }
  };

  const findingsList = (editable: boolean) => {
    if (items.length === 0) {
      return (
        <p className="text-table-cell text-text-muted text-center mt-4">
          There are no findings on this one.
        </p>
      );
    }
    return (
      <>
        {reasoningWithheld && (
          <div className="mt-4 px-3 py-2.5 rounded-btn bg-review-bg">
            <p className="text-table-cell text-text-primary leading-relaxed">
              The detail behind these findings is not shown here. Your supervisor has it and can talk
              you through it.
            </p>
          </div>
        )}
        <ul className="mt-4 space-y-4 text-left">
          {items.map((f) => (
            <FindingCard
              key={f.id}
              finding={f}
              editable={editable}
              save={saveOutcome}
              state={saveState[f.id] ?? IDLE}
            />
          ))}
        </ul>
      </>
    );
  };

  const content = () => {
    switch (status) {
      case 'loading':
        return (
          <div className="flex items-center justify-center gap-3 text-text-muted text-table-cell py-4">
            <div className="w-5 h-5 border-2 border-border border-t-primary rounded-full animate-spin" />
            Checking this link…
          </div>
        );
      case 'pending':
        return (
          <div>
            <div className="text-center">
              <InfoIcon className="w-12 h-12 text-text-muted mx-auto" />
              <h1 className="text-page-title text-text-primary mt-4">Feedback on a reviewed sale</h1>
              <p className="text-table-cell text-text-secondary mt-2 leading-relaxed">
                {name ? `${name}, your` : 'Your'} supervisor has reviewed a sale and would like you to
                confirm you have seen the feedback
                {typeof itemCount === 'number'
                  ? ` on ${itemCount} ${itemCount === 1 ? 'finding' : 'findings'}`
                  : ''}
                .
              </p>
            </div>

            {findingsList(false)}

            <div className="text-center mt-6">
              {items.length > 0 && (
                <p className="text-table-cell text-text-secondary mb-3">
                  Confirm below, then you can tell us what you did about each one.
                </p>
              )}
              <button
                type="button"
                onClick={handleConfirm}
                disabled={confirming}
                aria-label="Confirm I have seen this feedback"
                className="px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {confirming ? 'Confirming…' : 'Confirm I have seen this'}
              </button>
              {confirmError && (
                <p className="text-table-cell text-fail mt-3" role="alert">
                  {confirmError}
                </p>
              )}
            </div>
          </div>
        );
      case 'confirmed':
      case 'already_confirmed': {
        const answered = items.filter((f) => !!f.outcome).length;
        const outstanding = items.length - answered;
        return (
          <div>
            <div className="text-center">
              <TickIcon className="w-12 h-12 text-pass mx-auto" />
              <h1 className="text-page-title text-text-primary mt-4">
                {name ? `Thank you, ${name}` : 'Thank you'}
              </h1>
              <p className="text-table-cell text-text-secondary mt-2 leading-relaxed">
                {items.length === 0
                  ? 'We have recorded that you received this feedback.'
                  : outstanding === 0
                    ? 'You have answered everything here. You can change an answer any time.'
                    : `We have recorded that you received this feedback. ${outstanding} of ${items.length} still to answer — you can come back to this page any time.`}
              </p>
            </div>

            {canRecordOutcome ? (
              findingsList(true)
            ) : (
              <>
                {/* Confirmed, but the link has since expired. The findings still
                    read — they were already emailed — and only the writing
                    stops, which the copy says rather than showing dead
                    controls. */}
                <div className="mt-4 px-3 py-2.5 rounded-btn bg-review-bg">
                  <p className="text-table-cell text-text-primary leading-relaxed">
                    This link is too old to add to now. Ask your supervisor to send it again if you
                    still need to record what you did.
                  </p>
                </div>
                {findingsList(false)}
              </>
            )}

            <p className="text-xs text-text-muted mt-6 text-center">
              You can close this page — anything you have answered is saved.
            </p>
          </div>
        );
      }
      case 'expired':
        return (
          <div className="text-center">
            <InfoIcon className="w-12 h-12 text-review mx-auto" />
            <h1 className="text-page-title text-text-primary mt-4">This link has expired</h1>
            <p className="text-table-cell text-text-secondary mt-2 leading-relaxed">
              Confirmation links are valid for 30 days. Ask your supervisor to send it again.
            </p>
          </div>
        );
      case 'error':
        // A transport failure (network error, non-2xx, rate limit) — NOT the
        // same thing as 'not_found'. Blaming the token for a fetch failure is
        // exactly the bug this page used to hide: don't leak the status code
        // or any server message here, just offer a retry.
        return (
          <div className="text-center">
            <AlertIcon className="w-12 h-12 text-fail mx-auto" />
            <h1 className="text-page-title text-text-primary mt-4">We couldn&apos;t check this link</h1>
            <p className="text-table-cell text-text-secondary mt-2 leading-relaxed">
              Something went wrong on our end. The link itself is probably fine — please try again in
              a moment.
            </p>
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              aria-label="Try checking this link again"
              className="mt-4 px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary text-white hover:bg-primary-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Try again
            </button>
          </div>
        );
      default:
        // 'not_found' lands here. Not merging it with a real network/HTTP
        // failure ('error', handled above) is deliberate probing-resistance:
        // an unknown token and a mistyped/reused one must look identical, so
        // someone guessing URLs can't learn which tokens exist from the copy.
        return (
          <div className="text-center">
            <InfoIcon className="w-12 h-12 text-text-muted mx-auto" />
            <h1 className="text-page-title text-text-primary mt-4">This link is not valid</h1>
            <p className="text-table-cell text-text-secondary mt-2 leading-relaxed">
              It may have been mistyped or replaced by a newer one. Ask your supervisor to send it
              again.
            </p>
          </div>
        );
    }
  };

  return (
    <div className="min-h-screen bg-page flex items-center justify-center px-4 py-10">
      {/* Wider than the single-button page it grew out of, because it now
          carries a list. Still one column: this is read on a phone at least as
          often as on a desk. */}
      <div className="w-full max-w-xl">
        <div className="bg-card border border-border rounded-card px-6 py-8">{content()}</div>
        <p className="text-center text-xs text-text-muted mt-4">CallGuard</p>
      </div>
    </div>
  );
}
