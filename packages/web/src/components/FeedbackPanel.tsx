import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

// Feeding a reviewed sale back to its adviser, and showing whether they have
// acknowledged it.
//
// Sits below the score on a sale, because it is the last step of the review: go
// through the findings, overturn what is wrong, then tell the adviser what stands.

interface FeedbackState {
  adviser: { name: string; email: string | null; problem: 'no_adviser' | 'no_email' | null };
  breach_count: number;
  breaches: Array<{ label: string; severity: string }>;
  open_reviews: number;
  feedback: {
    id: string;
    adviser_name: string;
    adviser_email: string;
    sent_at: string;
    message: string | null;
    confirmed_at: string | null;
  } | null;
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
 * what state the sale is in. React Query dedupes on the key — one request.
 */
function useFeedbackState(journeyId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['journey-feedback', journeyId],
    queryFn: () => api.get<FeedbackState>(`/journeys/${journeyId}/feedback`),
    enabled,
  });
}

/**
 * The compact control that sits with Re-score at the top of a sale.
 *
 * Deliberately not a second copy of the send form. The panel below owns that,
 * along with the findings list and the open-review warning — a supervisor should
 * see what they are about to send before they send it, and duplicating the flow
 * into a header button would make it possible to skip that. This shows the state
 * and takes you there.
 */
export function FeedbackHeaderAction({
  journeyId,
  canAction,
  onOpen,
}: {
  journeyId: string;
  canAction: boolean;
  onOpen: () => void;
}) {
  const { data } = useFeedbackState(journeyId, canAction);
  if (!canAction || !data) return null;

  const fb = data.feedback;
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

  if (data.adviser.problem) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={`${base} bg-card border border-border text-text-muted hover:border-primary`}
        title={
          data.adviser.problem === 'no_adviser'
            ? 'No adviser is attributed to this sale'
            : `${data.adviser.name} has no email address`
        }
      >
        Feed back
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`${base} bg-card border border-border text-text-primary hover:border-primary`}
      title={`Feed this sale back to ${data.adviser.name}`}
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
  journeyId,
  canAction,
  composeSignal = 0,
}: {
  journeyId: string;
  canAction: boolean;
  /** Increments when the header action is clicked; opens the compose box. */
  composeSignal?: number;
}) {
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isError } = useFeedbackState(journeyId, canAction);

  // Opened from the header. Only meaningful before anything has been sent —
  // afterwards the header just scrolls here to show the state.
  useEffect(() => {
    if (composeSignal > 0 && !data?.feedback && !data?.adviser.problem) setComposing(true);
  }, [composeSignal, data?.feedback, data?.adviser.problem]);

  const send = useMutation({
    mutationFn: () =>
      api.post<{ id: string; item_count: number }>(`/journeys/${journeyId}/feedback`, {
        message: message.trim() || null,
      }),
    onSuccess: () => {
      setComposing(false);
      setMessage('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['journey-feedback', journeyId] });
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not send the feedback.');
    },
  });

  // Advisers do not see this at all: it is a record of what was said to them,
  // not a surface for them to act on.
  if (!canAction) return null;

  const shell = (children: React.ReactNode) => (
    // id + scroll-mt: the header action scrolls here rather than duplicating the
    // send form, so the findings and any warning are always seen before sending.
    <div
      id="adviser-feedback"
      className="bg-card border border-border rounded-card overflow-hidden mt-4 scroll-mt-6"
    >
      <div className="px-5 py-4 border-b border-border">
        <h3 className="text-section-title text-text-primary">Adviser feedback</h3>
        <p className="text-xs text-text-subtle mt-0.5">
          The record that this sale was discussed with the adviser, and that they confirmed it.
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

  const fb = data.feedback;

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
        <button
          onClick={() => send.mutate()}
          disabled={send.isPending}
          className="mt-3 text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded disabled:opacity-50"
        >
          {send.isPending ? 'Sending…' : 'Send it again'}
        </button>
        {error && <p className="text-xs text-fail mt-2">{error}</p>}
      </div>
    );
  }

  // Not yet fed back.
  const blocked = data.adviser.problem !== null;

  return shell(
    <div className="px-5 py-5">
      {blocked ? (
        <div>
          <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell inline-block">
            {data.adviser.problem === 'no_adviser'
              ? 'No adviser is attributed to this sale'
              : `${data.adviser.name} has no email address`}
          </div>
          <p className="text-xs text-text-muted mt-2 leading-relaxed">
            {data.adviser.problem === 'no_adviser'
              ? 'Feedback is sent to the adviser who closed the sale. None of its calls are attributed to anyone, so there is nobody to send it to.'
              : 'Feedback is delivered by email, so an adviser without one cannot be sent it or confirm it. Add an address on their account in Settings → Team.'}
          </p>
        </div>
      ) : (
        <>
          <p className="text-table-cell text-text-secondary">
            {data.breach_count === 0 ? (
              <>Nothing was flagged on this sale. Feeding back still records that you reviewed it with{' '}
                <span className="text-text-primary font-medium">{data.adviser.name}</span>.</>
            ) : (
              <>
                <span className="text-text-primary font-medium">{data.breach_count}</span> finding
                {data.breach_count === 1 ? '' : 's'} will be sent to{' '}
                <span className="text-text-primary font-medium">{data.adviser.name}</span>.
              </>
            )}
          </p>

          {data.breaches.length > 0 && (
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
          )}

          {/* Visible, never blocking: the supervisor may have good reason, but
              telling an adviser about a breach that is overturned an hour later
              costs more trust than it saves time. */}
          {data.open_reviews > 0 && (
            <div className="bg-review-bg text-review px-3 py-2 rounded-btn text-table-cell mt-3">
              {data.open_reviews} checkpoint{data.open_reviews === 1 ? '' : 's'} on this sale
              {data.open_reviews === 1 ? ' is' : ' are'} still waiting for a human ruling. You can
              still send this, but anything overturned afterwards will already have been sent.
            </div>
          )}

          {composing ? (
            <div className="mt-3">
              <label htmlFor="feedback-message" className="text-xs text-text-secondary block mb-1">
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
                  disabled={send.isPending}
                  className="bg-primary text-white px-4 py-2 rounded-btn text-table-cell font-medium hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
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
              className="mt-3 bg-primary text-white px-4 py-2 rounded-btn text-table-cell font-medium hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
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
