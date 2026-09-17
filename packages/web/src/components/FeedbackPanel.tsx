import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

// Feeding a reviewed sale — or, for a firm that scores calls on their own, a
// single call — back to its adviser, and showing whether they have
// acknowledged it.
//
// Sits below the score, because it is the last step of the review: go through
// the findings, overturn what is wrong, then tell the adviser what stands.

/** What the feedback is about, and the id that names it in the API path. */
export interface FeedbackSubject {
  kind: 'journey' | 'call';
  id: string;
}

const subjectPath = (subject: FeedbackSubject) =>
  subject.kind === 'journey' ? `/journeys/${subject.id}/feedback` : `/calls/${subject.id}/feedback`;

// A sale and a call round never share a cache entry: sending feedback on one
// must not be mistaken, by React Query, for the same request as the other.
const subjectQueryKey = (subject: FeedbackSubject) =>
  subject.kind === 'journey' ? ['journey-feedback', subject.id] : ['call-feedback', subject.id];

/** "sale" or "call", for copy that has to name what this feedback is about. */
const subjectNoun = (subject: FeedbackSubject) => (subject.kind === 'journey' ? 'sale' : 'call');

interface FeedbackRecipient {
  id: string;
  name: string;
  email: string | null;
  role: string;
  /** False when there is no address to deliver to — listed, but not selectable. */
  eligible: boolean;
}

interface FeedbackState {
  adviser: {
    user_id: string | null;
    name: string;
    email: string | null;
    problem: 'no_adviser' | 'no_email' | null;
  };
  recipients: FeedbackRecipient[];
  breach_count: number;
  breaches: Array<{ label: string; severity: string; remediation_guidance?: string | null }>;
  reasoning_withheld?: boolean;
  guidance_included?: boolean;
  open_reviews: number;
  /** The subject's client as it will be named in the email, or null where it has no name. */
  client_name: string | null;
  /** Whether the AI's reason travels with each finding, or stays behind the link. */
  reasoning_included: boolean;
  feedback: {
    id: string;
    adviser_name: string;
    adviser_email: string;
    sent_at: string;
    message: string | null;
    confirmed_at: string | null;
    /** False when it went to someone the sale is no longer credited to. Absent on an older API. */
    reached_adviser?: boolean;
  } | null;
  /**
   * Whether a new round may be sent, and if not, the sentence saying why. A
   * round already sent stays readable when sending no longer is — the firm
   * changed its scoring setting, or the call has since joined a sale — so the
   * history is shown and only the send is withheld. Optional: an API that has
   * not restarted yet omits both, which means sending is allowed as before.
   */
  can_send?: boolean;
  cannot_send_reason?: string | null;
}

const SEVERITY_CLASS: Record<string, string> = {
  critical: 'bg-fail-bg text-fail',
  high: 'bg-fail-bg text-fail',
  medium: 'bg-review-bg text-review',
  low: 'bg-table-header text-text-secondary',
};

/** Stroke icon — a person with a tick. No emoji (brand guidelines §icons). */
function AdviserConfirmedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" strokeWidth="1.8" aria-hidden="true">
      <path
        d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3.13a4 4 0 0 1 0 7.75M16 11l2 2 4-4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Shared by the panel and the header action, so the two never disagree about
 * what state the sale or call is in. React Query dedupes on the key — one
 * request.
 */
export function useFeedbackState(subject: FeedbackSubject, enabled: boolean) {
  return useQuery({
    queryKey: subjectQueryKey(subject),
    queryFn: () => api.get<FeedbackState>(subjectPath(subject)),
    enabled,
  });
}

/**
 * The compact control that sits at the top of a sale or a call.
 *
 * Deliberately not a second copy of the send form. The panel below owns that,
 * along with the findings list and the open-review warning — a supervisor should
 * see what they are about to send before they send it, and duplicating the flow
 * into a header button would make it possible to skip that. This shows the state
 * and takes you there.
 */
export function FeedbackHeaderAction({
  subject,
  canAction,
  onOpen,
}: {
  subject: FeedbackSubject;
  canAction: boolean;
  onOpen: () => void;
}) {
  const { data } = useFeedbackState(subject, canAction);
  if (!canAction || !data) return null;
  const noun = subjectNoun(subject);

  // Feedback to someone the sale is no longer credited to does not settle it
  // (see FeedbackPanel), so the action offers to feed back again.
  const fb = data.feedback?.reached_adviser === false ? null : data.feedback;
  // Nothing settled and nothing that can be sent: no header control at all,
  // rather than a button that opens onto a refusal.
  if (!fb && data.can_send === false) return null;
  const base =
    'inline-flex items-center gap-1.5 px-[18px] py-[9px] rounded-btn text-table-cell font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';

  if (fb?.confirmed_at) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={`${base} bg-pass-bg text-pass border border-pass/30 hover:border-pass`}
        title={`${fb.adviser_name} confirmed on ${new Date(fb.confirmed_at).toLocaleDateString('en-GB')}`}
      >
        <TickIcon className="w-4 h-4" />
        Fed back
      </button>
    );
  }

  if (fb) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={`${base} bg-review-bg text-review border border-review/30 hover:border-review`}
        title={`Sent to ${fb.adviser_name}, not yet confirmed`}
      >
        Awaiting confirmation
      </button>
    );
  }

  // A sale or call whose adviser cannot be resolved is still sendable — the
  // panel offers a recipient picker — so this must not read as "you cannot do
  // this". It says what is missing and still takes you there.
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`${base} bg-card border border-border text-text-primary hover:border-primary`}
      title={
        data.adviser.problem === 'no_adviser'
          ? `No adviser is attributed to this ${noun} — choose who to feed it back to`
          : data.adviser.problem === 'no_email'
            ? `${data.adviser.name} has no email address — choose someone else to feed it back to`
            : `Feed this ${noun} back to ${data.adviser.name}`
      }
    >
      Feed back
    </button>
  );
}

/** Stroke icon — a tick in a circle. No emoji (brand guidelines §icons). */
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

export function FeedbackPanel({
  subject,
  canAction,
  composeSignal = 0,
  embedded = false,
}: {
  subject: FeedbackSubject;
  canAction: boolean;
  /** Increments when the header action is clicked; opens the compose box. */
  composeSignal?: number;
  /** Rendered inside a section that already carries the heading (and the id). */
  embedded?: boolean;
}) {
  const qc = useQueryClient();
  const noun = subjectNoun(subject);
  const [message, setMessage] = useState('');
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whatever the supervisor picked, tagged with the subject it was picked for.
  // Selection is DERIVED from this rather than seeded into state by an effect:
  // a stale pick surviving into a different sale or call is the silent
  // wrong-recipient failure this whole feature exists to prevent, and deriving
  // it makes that unrepresentable instead of merely unlikely.
  const subjectKey = `${subject.kind}:${subject.id}`;
  const [picked, setPicked] = useState<{ forSubject: string; id: string | null } | null>(null);

  const { data, isLoading, isError } = useFeedbackState(subject, canAction);

  // problem === null is exactly "resolved, and deliverable". An adviser with no
  // address is never pre-selected: it would leave the form looking ready to send
  // and failing on submit, which is the same wrong-looking-right the recipient
  // picker exists to remove.
  const suggestedId = data?.adviser.problem === null ? data.adviser.user_id : null;
  const recipientId = picked?.forSubject === subjectKey ? picked.id : suggestedId;

  // Opened from the header. Only meaningful before anything has been sent —
  // afterwards the header just scrolls here to show the state. An unattributed
  // sale or call no longer blocks this: choosing a recipient is how it gets sent.
  useEffect(() => {
    const settled = !!data?.feedback && data.feedback.reached_adviser !== false;
    if (composeSignal > 0 && !settled) setComposing(true);
  }, [composeSignal, data?.feedback]);

  const send = useMutation({
    mutationFn: () =>
      api.post<{ id: string; item_count: number }>(subjectPath(subject), {
        message: message.trim() || null,
        adviser_user_id: recipientId,
      }),
    onSuccess: () => {
      setComposing(false);
      setMessage('');
      setError(null);
      setPicked(null);
      void qc.invalidateQueries({ queryKey: subjectQueryKey(subject) });
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not send the feedback.');
    },
  });

  // Advisers do not see this at all: it is a record of what was said to them,
  // not a surface for them to act on.
  if (!canAction) return null;

  const shell = (children: React.ReactNode) => embedded ? (
    <div>{children}</div>
  ) : (
    // id + scroll-mt: the header action scrolls here rather than duplicating the
    // send form, so the findings and any warning are always seen before sending.
    <div
      id="adviser-feedback"
      className="bg-card border border-border rounded-card overflow-hidden mt-4 scroll-mt-6"
    >
      <div className="px-5 py-4 border-b border-border">
        <h3 className="text-section-title text-text-primary">Adviser feedback</h3>
        <p className="text-xs text-text-subtle mt-0.5">
          The record that this {noun} was discussed with the adviser, and that they confirmed it.
        </p>
      </div>
      {children}
    </div>
  );

  if (isLoading) {
    return shell(
      <div className="px-5 py-6 flex items-center gap-3 text-text-muted text-table-cell">
        <div className="w-5 h-5 border-2 border-border border-t-primary rounded-full animate-spin" />
        Loading…
      </div>
    );
  }

  if (isError || !data) {
    return shell(
      <div className="px-5 py-4">
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell inline-block">
          Could not load the feedback status.
        </div>
      </div>
    );
  }

  // Feedback that went to somebody the sale is no longer credited to — sent by
  // default before the sale's wrap-up call moved. It stays on the record and is
  // named here, but it does not settle this sale: the panel reads as not fed
  // back and offers to feed back to the adviser credited now. A recipient a
  // supervisor chose always counts (decided server-side).
  const earlier = data.feedback?.reached_adviser === false ? data.feedback : null;
  const fb = earlier ? null : data.feedback;

  // Already acknowledged — the terminal, good state.
  if (fb?.confirmed_at) {
    return shell(
      <div className="px-5 py-5">
        <div className="flex items-start gap-3">
          <AdviserConfirmedIcon className="w-5 h-5 text-pass flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-table-cell text-text-primary font-medium">
              {fb.adviser_name} confirmed they received this feedback
            </p>
            <p className="text-xs text-text-muted mt-1">
              Sent {formatDate(fb.sent_at)} · confirmed {formatDate(fb.confirmed_at)}
            </p>
            {fb.message && (
              <p className="text-xs text-text-secondary mt-2 leading-relaxed whitespace-pre-wrap border-l-2 border-border pl-2.5">
                {fb.message}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Sent, waiting on the adviser.
  if (fb) {
    return shell(
      <div className="px-5 py-5">
        <div className="bg-review-bg text-review px-3 py-2 rounded-btn text-table-cell inline-block">
          Waiting for {fb.adviser_name} to confirm
        </div>
        <p className="text-xs text-text-muted mt-2 leading-relaxed">
          Sent {formatDate(fb.sent_at)} to {fb.adviser_email}. They confirm with one click from the
          email — no sign-in needed.
        </p>
        {data.can_send === false ? (
          data.cannot_send_reason && (
            <p className="text-xs text-text-secondary mt-3 leading-relaxed">{data.cannot_send_reason}</p>
          )
        ) : (
          <button
            onClick={() => send.mutate()}
            disabled={send.isPending}
            className="mt-3 text-xs text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded disabled:opacity-50"
          >
            {send.isPending ? 'Sending…' : 'Send it again'}
          </button>
        )}
        {error && <p className="text-xs text-fail mt-2">{error}</p>}
      </div>
    );
  }

  // A round that went to someone this subject is no longer credited to: kept on
  // the record and shown, but not counted as fed back.
  const earlierNote = earlier && (
    <div className="mb-4 border-l-2 border-review pl-2.5">
      <p className="text-table-cell text-text-primary">
        Fed back to {earlier.adviser_name} on {formatDate(earlier.sent_at)}
        {earlier.confirmed_at ? ', who confirmed it' : ', not yet confirmed'}
      </p>
      <p className="text-xs text-text-muted mt-1 leading-relaxed">
        This {subjectNoun(subject)} is now credited to {data.adviser.name}, who has not been fed back.
        The earlier feedback stays on the record, but it does not count as this{' '}
        {subjectNoun(subject)} being fed back.
      </p>
    </div>
  );

  // Not yet fed back, and not allowed to be: say why instead of offering a
  // compose box the API would refuse.
  if (data.can_send === false) {
    return shell(
      <div className="px-5 py-5">
        {earlierNote}
        <p className="text-table-cell text-text-secondary leading-relaxed">
          {data.cannot_send_reason ?? `Feedback can't be sent on this ${subjectNoun(subject)}.`}
        </p>
      </div>
    );
  }

  // Not yet fed back.
  //
  // A sale with no attributed adviser, or one whose adviser has no address, is
  // no longer a dead end — it is the case the picker exists for. The only true
  // block left is having nobody deliverable in the organisation at all, because
  // then there is no choice to offer.
  // Defaulted, not assumed: a bundle that reaches an API which has not restarted
  // yet gets a 200 with no recipients key, and an unguarded .filter would throw
  // during render and blank the whole sale page rather than this one panel.
  const recipients = data.recipients ?? [];
  const blocked = recipients.filter((r) => r.eligible).length === 0;
  const chosen = recipients.find((r) => r.id === recipientId) ?? null;
  const recipientName = chosen?.name ?? null;
  const overridden = recipientId !== null && recipientId !== data.adviser.user_id;

  return shell(
    <div className="px-5 py-5">
      {earlierNote}
      {blocked ? (
        <div>
          <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell inline-block">
            Nobody on this team has an email address
          </div>
          <p className="text-xs text-text-muted mt-2 leading-relaxed">
            Feedback is delivered by email, and confirmed from a link in it, so it cannot be sent
            to an account without an address. Add one in Settings → Team.
          </p>
        </div>
      ) : (
        <>
          <p className="text-table-cell text-text-secondary">
            {data.breach_count === 0 ? (
              <>Nothing was flagged on this {noun}. Feeding back still records that you reviewed it
                {recipientName ? (
                  <> with <span className="text-text-primary font-medium">{recipientName}</span>.</>
                ) : (
                  <>.</>
                )}
              </>
            ) : (
              <>
                <span className="text-text-primary font-medium">{data.breach_count}</span> finding
                {data.breach_count === 1 ? '' : 's'} will be sent
                {recipientName ? (
                  <> to <span className="text-text-primary font-medium">{recipientName}</span>.</>
                ) : (
                  <>.</>
                )}
              </>
            )}
          </p>

          {data.adviser.problem === 'no_adviser' && (
            <p className="text-xs text-text-muted mt-1.5 leading-relaxed">
              {subject.kind === 'journey'
                ? "Feedback normally goes to the adviser who closed the sale. None of these calls are attributed to anyone, so choose who to send it to."
                : "Feedback normally goes to the adviser on the call. This call isn't attributed to anyone, so choose who to send it to."}
            </p>
          )}
          {data.adviser.problem === 'no_email' && (
            <p className="text-xs text-text-muted mt-1.5 leading-relaxed">
              {data.adviser.name}{' '}
              {subject.kind === 'journey' ? 'closed this sale' : 'is the adviser on this call'} but has
              no email address, so it cannot be delivered or confirmed. Add one in Settings → Team, or
              choose someone else.
            </p>
          )}

          {data.breaches.length > 0 && (
            // Findings that carry guidance are listed rather than tiled: the
            // guidance is a sentence, and a sentence inside a pill is
            // unreadable. Those without it keep the compact pill, so a
            // scorecard with no guidance anywhere looks exactly as it did.
            data.breaches.some((b) => b.remediation_guidance) ? (
              <ul className="mt-2.5 space-y-2">
                {data.breaches.map((b, i) => (
                  <li key={i}>
                    <span
                      className={`inline-block px-2.5 py-[3px] rounded-full text-badge font-semibold ${SEVERITY_CLASS[b.severity] ?? SEVERITY_CLASS.low}`}
                    >
                      {b.label}
                    </span>
                    {b.remediation_guidance && (
                      // Labelled, matching the email, so the supervisor is
                      // checking the same words the adviser will read.
                      <p className="mt-1 text-table-cell text-text-secondary">
                        <span className="font-semibold text-text-primary">What to do:</span>{' '}
                        {b.remediation_guidance}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {data.breaches.map((b, i) => (
                  <span
                    key={i}
                    className={`px-2.5 py-[3px] rounded-full text-badge font-semibold ${SEVERITY_CLASS[b.severity] ?? SEVERITY_CLASS.low}`}
                  >
                    {b.label}
                  </span>
                ))}
              </div>
            )
          )}

          {/* What the supervisor is actually authorising. They are sending a
              client's name out of the platform next to compliance findings, and
              on a tenant that keeps health unredacted the AI's reasons stay
              behind the link — which they would otherwise have no way of
              knowing, having pressed a button labelled "Send". */}
          {data.breach_count > 0 && (
            <p className="text-table-cell text-text-secondary mt-2.5">
              {data.client_name ? (
                <>
                  The email names{' '}
                  <span className="text-text-primary font-medium">{data.client_name}</span> and
                  lists the findings above
                </>
              ) : (
                <>The email lists the findings above</>
              )}
              {data.reasoning_included && ", with the AI's reason under each one."}
              {/* Not "behind the link": the tokenised confirm page shows a name,
                  a status and a button, never the findings — and the adviser
                  may have no login at all. The email now tells them to come to
                  you, so the panel must say the same thing. */}
              {data.reasoning_withheld &&
                ". The AI's reasons are held back, because your firm keeps health disclosures unredacted — the adviser is told to ask you for them."}
              {!data.reasoning_included && !data.reasoning_withheld && '.'}
              {data.guidance_included &&
                ' Findings with remediation guidance also carry what to do about them.'}
            </p>
          )}

          {/* Visible, never blocking: the supervisor may have good reason, but
              telling an adviser about a breach that is overturned an hour later
              costs more trust than it saves time. */}
          {data.open_reviews > 0 && (
            <div className="bg-review-bg text-review px-3 py-2 rounded-btn text-table-cell mt-3">
              {data.open_reviews} checkpoint{data.open_reviews === 1 ? '' : 's'} on this {noun}
              {data.open_reviews === 1 ? ' is' : ' are'} still waiting for a human ruling. You can
              still send this, but anything overturned afterwards will already have been sent.
            </div>
          )}

          {composing ? (
            <div className="mt-3">
              <label htmlFor="feedback-recipient" className="text-xs text-text-secondary block mb-1">
                Send to
              </label>
              <select
                id="feedback-recipient"
                aria-label="Who to send this feedback to"
                value={recipientId ?? ''}
                onChange={(e) => setPicked({ forSubject: subjectKey, id: e.target.value || null })}
                className="w-full bg-input border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                <option value="">Choose an adviser…</option>
                {recipients.map((r) => (
                  // Undeliverable people are shown disabled rather than removed:
                  // a supervisor who cannot find someone needs to know they have
                  // no address, not be left guessing whether they still exist.
                  <option key={r.id} value={r.id} disabled={!r.eligible}>
                    {r.eligible ? r.name : `${r.name} — no email address`}
                  </option>
                ))}
              </select>
              {overridden && data.adviser.user_id !== null && (
                <p className="text-xs text-text-muted mt-1">
                  The adviser on this {noun} is {data.adviser.name}.
                </p>
              )}

              <label
                htmlFor="feedback-message"
                className="text-xs text-text-secondary block mb-1 mt-3"
              >
                Anything to add? (optional, included in the email)
              </label>
              <textarea
                id="feedback-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                maxLength={2000}
                className="w-full bg-input border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
                placeholder="e.g. We went through the consent wording on Tuesday — this is the written record."
              />
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => send.mutate()}
                  disabled={send.isPending || recipientId === null}
                  className="bg-primary-ink text-on-solid px-4 py-2 rounded-btn text-table-cell font-medium hover:bg-primary-ink-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
                >
                  {send.isPending ? 'Sending…' : 'Send to adviser'}
                </button>
                <button
                  onClick={() => setComposing(false)}
                  className="text-text-secondary px-3 py-2 rounded-btn text-table-cell hover:bg-table-header focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setComposing(true)}
              className="mt-3 bg-primary-ink text-on-solid px-4 py-2 rounded-btn text-table-cell font-medium hover:bg-primary-ink-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Feed back to adviser
            </button>
          )}
          {error && <p className="text-xs text-fail mt-2">{error}</p>}
        </>
      )}
    </div>
  );
}
