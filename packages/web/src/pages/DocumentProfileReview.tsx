import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import type { DocumentProfile, QuestionSetDrift, QuestionCheckMode } from '@callguard/shared';

interface ProfileDetail {
  profile: DocumentProfile;
  /** The question set currently in use, when this one would replace it. */
  incumbent: DocumentProfile | null;
  drift: QuestionSetDrift | null;
}

const STRATEGY_LABEL: Record<string, string> = {
  question_answer: 'Question, then answer',
  label_value: 'Label and value sheet',
  question_marker: 'Portal export with an answer history',
};

/**
 * How each field will be checked, in the reviewer's terms rather than the
 * schema's. Worded as what will HAPPEN to the field, because the consequence is
 * the thing being approved: two of the three switch off a compliance check.
 */
const CHECK_MODE_OPTIONS: Array<{
  value: QuestionCheckMode;
  label: string;
  detail: string;
}> = [
  {
    value: 'reconcile',
    label: 'Check against the call',
    detail: 'Compare the submitted answer with what the customer said. The normal setting.',
  },
  {
    value: 'presence',
    label: 'Only check it was filled in',
    detail:
      'For values that cannot be verified from a recording — account numbers, sort codes. ' +
      'A blank is reported; a completed one is not compared.',
  },
  {
    value: 'none',
    label: 'Do not check',
    detail:
      'For anything the insurer generates after the call, like a policy number. Recorded, never flagged.',
  },
];

/** Stroke icon (§icons) — plus in a circle. */
function AddedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" strokeWidth="1.8" aria-hidden="true">
      <path
        d="M12 8v8M8 12h8M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Stroke icon (§icons) — minus in a circle. */
function RemovedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" strokeWidth="1.8" aria-hidden="true">
      <path
        d="M8 12h8M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Review and confirm an insurer's question set.
 *
 * The whole screen exists for one decision, and the diff is that decision:
 * confirming a set with a question missing means that question stops being
 * checked on every future sale, silently. So removals are stated first and in
 * those terms, rather than left for someone to infer from two lists.
 */
export function DocumentProfileReview() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const { data, isLoading, isError } = useQuery({
    queryKey: ['reconciliation-profile', id],
    queryFn: () => api.get<ProfileDetail>(`/reconciliation/profiles/${id}`),
    enabled: !!id,
  });

  // Both are decisions only a person can make, and both are asked here because
  // this is the last screen before the format starts judging sales.
  const [insurer, setInsurer] = useState('');
  const [questionsVary, setQuestionsVary] = useState(false);

  // Overrides only — the questions the reviewer actually changed, keyed by
  // order. Sending the full set would mean a stale copy of the page could
  // silently rewrite modes somebody else had just corrected.
  const [modeOverrides, setModeOverrides] = useState<Record<number, QuestionCheckMode>>({});

  // Dismissing is behind a confirm step rather than a bare button. It is not
  // destructive — the sales still get read, by the model fallback — but it is a
  // decision another admin will see the consequences of, so it asks why.
  const [dismissing, setDismissing] = useState(false);
  const [dismissReason, setDismissReason] = useState('');

  const confirm = useMutation({
    mutationFn: () =>
      api.put<{ id: string; requeued?: number }>(`/reconciliation/profiles/${id}/confirm`, {
        ...(insurer.trim() ? { insurer: insurer.trim() } : {}),
        questions_vary: questionsVary,
        ...(Object.keys(modeOverrides).length > 0 ? { check_modes: modeOverrides } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reconciliation-profiles'] });
      queryClient.invalidateQueries({ queryKey: ['reconciliation-runs'] });
      queryClient.invalidateQueries({ queryKey: ['reconciliation-profile', id] });
      navigate('/data-forms');
    },
  });

  const dismiss = useMutation({
    mutationFn: () =>
      api.put<{ id: string; status: string }>(`/reconciliation/profiles/${id}/dismiss`, {
        ...(dismissReason.trim() ? { reason: dismissReason.trim() } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reconciliation-profiles'] });
      queryClient.invalidateQueries({ queryKey: ['reconciliation-profile', id] });
      navigate('/data-forms');
    },
  });

  if (isLoading) {
    return (
      <div className="px-5 py-12 flex items-center justify-center text-text-muted text-table-cell">
        <div className="w-6 h-6 border-2 border-border border-t-primary rounded-full animate-spin mr-3" />
        Loading…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div>
        <Link to="/data-forms" className="text-table-cell text-primary hover:underline">
          ← Data Forms
        </Link>
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mt-4 inline-block">
          Could not load this question set.
        </div>
      </div>
    );
  }

  const { profile, incumbent, drift } = data;
  const awaiting = profile.status === 'needs_confirmation';
  // A broker portal export names no insurer anywhere in it, because it is a
  // quotation request spanning several. The learner cannot invent one and the
  // profile cannot go live without one, so it is asked for here.
  const needsInsurer = /^\s*(<?unknown>?( (insurer|provider|product))?|n\/?a|none|unidentified|tbc)\s*$/i.test(
    profile.insurer ?? ''
  );
  const questions = profile.questions ?? [];
  const unverifiable = questions.filter((q) => !q.absence_meaningful).length;

  return (
    <div>
      <Link to="/data-forms" className="text-table-cell text-primary hover:underline">
        ← Data Forms
      </Link>

      <div className="mt-3 mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-page-title text-text-primary">
            {profile.insurer}
            {profile.product ? <span className="text-text-muted"> — {profile.product}</span> : null}
          </h2>
          <p className="text-page-sub text-text-subtle mt-1">
            {questions.length} question{questions.length === 1 ? '' : 's'} · version {profile.version} ·{' '}
            {STRATEGY_LABEL[profile.strategy] ?? profile.strategy}
          </p>
        </div>
        <span
          className={`px-2.5 py-[3px] rounded-full text-badge font-semibold ${
            profile.status === 'active'
              ? 'bg-pass-bg text-pass'
              : profile.status === 'needs_confirmation'
                ? 'bg-review-bg text-review'
                : 'bg-table-header text-text-secondary'
          }`}
        >
          {profile.status === 'active'
            ? 'In use'
            : profile.status === 'needs_confirmation'
              ? 'Awaiting confirmation'
              : 'Superseded'}
        </span>
      </div>

      {/* What confirming actually does */}
      {awaiting && (
        <div className="bg-card border border-review rounded-card p-5 mb-5">
          <h3 className="text-section-title text-text-primary">
            {incumbent ? 'This replaces the question set in use' : 'This is a new question set'}
          </h3>

          {drift && (drift.added.length > 0 || drift.removed.length > 0 || drift.reordered) ? (
            <div className="mt-3 space-y-4">
              {drift.removed.length > 0 && (
                <div>
                  <p className="text-table-cell text-fail font-semibold">
                    {drift.removed.length} question{drift.removed.length === 1 ? '' : 's'} would stop
                    being checked
                  </p>
                  <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
                    These are in the set currently in use but not in the new document. If the insurer
                    really has dropped them, that is fine. If the document was read wrongly,
                    confirming this hides a gap on every future sale.
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {drift.removed.map((q, i) => (
                      <li key={i} className="flex items-start gap-2 text-table-cell text-text-secondary">
                        <RemovedIcon className="w-4 h-4 text-fail flex-shrink-0 mt-0.5" />
                        <span>{q}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {drift.added.length > 0 && (
                <div>
                  <p className="text-table-cell text-text-primary font-semibold">
                    {drift.added.length} new question{drift.added.length === 1 ? '' : 's'}
                  </p>
                  <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
                    A newly added health question is the one most likely to cause a non-disclosure —
                    nobody has the habit of asking it yet.
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {drift.added.map((q, i) => (
                      <li key={i} className="flex items-start gap-2 text-table-cell text-text-secondary">
                        <AddedIcon className="w-4 h-4 text-pass flex-shrink-0 mt-0.5" />
                        <span>{q}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {drift.reordered && drift.added.length === 0 && drift.removed.length === 0 && (
                <p className="text-table-cell text-text-secondary">
                  The same questions, in a different order. Usually a redesign of the document rather
                  than a change to what is asked.
                </p>
              )}
            </div>
          ) : incumbent ? (
            <p className="text-table-cell text-text-secondary mt-2">
              The wording has changed but no question was added or removed.
            </p>
          ) : (
            <p className="text-table-cell text-text-secondary mt-2 leading-relaxed">
              Nothing is compared against these questions until you confirm them. Read them below and
              check they are the insurer&rsquo;s actual application questions — not headings, page
              furniture, or content from another document in the pack.
            </p>
          )}
        </div>
      )}

      {/* How the document is recognised — the part that decides whether the right
          file was read at all. */}
      <div className="bg-card border border-border rounded-card p-5 mb-5">
        <h3 className="text-section-title text-text-primary">How this document is recognised</h3>
        <p className="text-xs text-text-subtle mt-0.5 leading-relaxed">
          All of these must appear in a document for CallGuard to treat it as this insurer&rsquo;s
          application. Filenames are never used: the firm&rsquo;s own suitability report sits in the
          same pack and looks similar.
        </p>
        <div className="flex flex-wrap gap-1.5 mt-3">
          {(profile.detect_patterns ?? []).map((p, i) => (
            <code
              key={i}
              className="px-2 py-1 rounded-btn bg-table-header text-text-secondary text-xs break-all"
            >
              {p}
            </code>
          ))}
          {(profile.detect_patterns ?? []).length === 0 && (
            <span className="text-table-cell text-text-muted">None recorded.</span>
          )}
        </div>
      </div>

      {/* The questions */}
      <div className="bg-card border border-border rounded-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-section-title text-text-primary">
            The questions ({questions.length})
          </h3>
          {unverifiable > 0 && (
            <p className="text-xs text-text-subtle mt-0.5 leading-relaxed">
              {unverifiable} of these are marked as unverifiable by absence: the words identifying
              them are removed from stored transcripts, so not finding them in a call proves
              nothing. Those are reported as &ldquo;could not verify&rdquo; rather than
              &ldquo;not asked&rdquo;.
            </p>
          )}
        </div>
        {questions.length === 0 ? (
          <p className="px-5 py-8 text-center text-text-muted text-table-cell">
            No questions were parsed from this document.
          </p>
        ) : (
          <ol>
            {questions.map((q, i) => (
              <li
                key={`${q.order}-${i}`}
                className="px-5 py-3 border-b border-border-light last:border-0 flex items-start gap-3"
              >
                <span className="text-xs text-text-muted tabular-nums mt-0.5 w-6 flex-shrink-0">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <div className="text-table-cell text-text-primary">{q.question}</div>
                  {q.guidance && (
                    <p className="text-xs text-text-muted mt-0.5 leading-relaxed">{q.guidance}</p>
                  )}
                  {q.choices?.length > 0 && (
                    <p className="text-xs text-text-muted mt-0.5">
                      Options: {q.choices.join(' · ')}
                    </p>
                  )}
                  {!q.absence_meaningful && (
                    <span className="inline-block mt-1 px-2 py-[2px] rounded-full text-badge bg-table-header text-text-secondary">
                      Not verifiable by absence
                    </span>
                  )}
                  {/* How this field is checked. Editable only while the format
                      is awaiting confirmation and only by an admin — after it
                      goes live, changing it would alter what past findings
                      meant without re-deriving them. */}
                  {awaiting && isAdmin ? (
                    <div className="mt-2">
                      <label
                        htmlFor={`check-mode-${q.order}`}
                        className="block text-xs text-text-muted mb-1"
                      >
                        How to check this field
                      </label>
                      <select
                        id={`check-mode-${q.order}`}
                        value={modeOverrides[q.order] ?? q.check_mode ?? 'reconcile'}
                        onChange={(e) =>
                          setModeOverrides((prev) => ({
                            ...prev,
                            [q.order]: e.target.value as QuestionCheckMode,
                          }))
                        }
                        className="text-table-cell bg-card border border-border rounded-btn px-2 py-1
                                   text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
                      >
                        {CHECK_MODE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-text-subtle mt-1 leading-relaxed">
                        {
                          CHECK_MODE_OPTIONS.find(
                            (o) => o.value === (modeOverrides[q.order] ?? q.check_mode ?? 'reconcile')
                          )?.detail
                        }
                      </p>
                    </div>
                  ) : (
                    (q.check_mode ?? 'reconcile') !== 'reconcile' && (
                      <span className="inline-block mt-1 ml-1 px-2 py-[2px] rounded-full text-badge bg-table-header text-text-secondary">
                        {CHECK_MODE_OPTIONS.find((o) => o.value === q.check_mode)?.label}
                      </span>
                    )
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      {awaiting && isAdmin && (
        <div className="mt-5 bg-card border border-border rounded-card p-5 space-y-4">
          {needsInsurer && (
            <div>
              <label
                htmlFor="profile-insurer"
                className="block text-table-cell font-semibold text-text-primary"
              >
                Which insurer is this form from?
              </label>
              <p className="text-xs text-text-muted mt-1 leading-relaxed">
                This document does not name one anywhere in it. Formats are filed by insurer, so
                it needs a name before it can be used.
              </p>
              <input
                id="profile-insurer"
                type="text"
                value={insurer}
                onChange={(e) => setInsurer(e.target.value)}
                placeholder="e.g. Royal London"
                className="mt-2 w-full max-w-sm px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              />
            </div>
          )}

          <div className="flex items-start gap-2.5">
            <input
              id="questions-vary"
              type="checkbox"
              checked={questionsVary}
              onChange={(e) => setQuestionsVary(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
            <div>
              <label htmlFor="questions-vary" className="text-table-cell font-semibold text-text-primary">
                This form asks different questions depending on the answers
              </label>
              <p className="text-xs text-text-muted mt-1 leading-relaxed max-w-2xl">
                Tick this if the insurer asks follow-up questions only when they apply, so two
                customers get different question sets. CallGuard then checks that each sale&rsquo;s
                document still reads correctly, instead of expecting the exact list below every
                time. Leave it unticked for a fixed form, so a genuine change to the
                insurer&rsquo;s questions is still caught.
              </p>
            </div>
          </div>
        </div>
      )}

      {awaiting && (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          {isAdmin ? (
            <>
              <button
                onClick={() => confirm.mutate()}
                disabled={
                  confirm.isPending ||
                  questions.length === 0 ||
                  (needsInsurer && !insurer.trim())
                }
                className="px-4 py-2 rounded-btn text-table-cell font-semibold bg-primary text-white hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {confirm.isPending ? 'Confirming…' : 'Confirm this question set'}
              </button>
              <Link
                to="/data-forms"
                className="px-4 py-2 rounded-btn text-table-cell font-semibold border border-border text-text-secondary hover:bg-table-header focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Not now
              </Link>
              <button
                onClick={() => setDismissing(true)}
                disabled={dismiss.isPending}
                className="px-4 py-2 rounded-btn text-table-cell font-semibold border border-border text-text-secondary hover:bg-table-header disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Not a format we need
              </button>
              <span className="text-xs text-text-muted">
                Sales waiting on this question set are checked as soon as you confirm.
              </span>
            </>
          ) : (
            <p className="text-table-cell text-text-muted">
              An administrator needs to confirm this question set before it is used.
            </p>
          )}
        </div>
      )}

      {awaiting && isAdmin && dismissing && (
        <div className="mt-4 bg-card border border-border rounded-card p-5 max-w-2xl">
          <h3 className="text-table-cell font-semibold text-text-primary">
            Dismiss this proposed format?
          </h3>
          <p className="text-xs text-text-muted mt-2 leading-relaxed">
            It stops appearing in the review queue, and CallGuard will not propose it again when
            another sale arrives carrying the same document. Sales on this format are still
            checked &mdash; without a stored format they are read directly instead, which is what
            already happens for an insurer never seen before.
          </p>
          <p className="text-xs text-text-muted mt-2 leading-relaxed">
            Reversible: a dismissed format can be confirmed later if this turns out to be wrong.
          </p>
          <label
            htmlFor="dismiss-reason"
            className="block text-table-cell font-semibold text-text-primary mt-4"
          >
            Why? <span className="font-normal text-text-muted">(optional)</span>
          </label>
          <input
            id="dismiss-reason"
            type="text"
            value={dismissReason}
            onChange={(e) => setDismissReason(e.target.value)}
            placeholder="e.g. duplicate of the format already in use"
            className="mt-2 w-full px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={() => dismiss.mutate()}
              disabled={dismiss.isPending}
              className="px-4 py-2 rounded-btn text-table-cell font-semibold bg-primary text-white hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {dismiss.isPending ? 'Dismissing…' : 'Dismiss this format'}
            </button>
            <button
              onClick={() => setDismissing(false)}
              disabled={dismiss.isPending}
              className="px-4 py-2 rounded-btn text-table-cell font-semibold border border-border text-text-secondary hover:bg-table-header disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Keep it
            </button>
          </div>
        </div>
      )}

      {profile.status === 'dismissed' && (
        <div className="mt-4 bg-card border border-border rounded-card p-5 max-w-2xl">
          <p className="text-table-cell text-text-primary font-semibold">
            This format was dismissed.
          </p>
          {profile.dismissed_reason && (
            <p className="text-table-cell text-text-secondary mt-1">{profile.dismissed_reason}</p>
          )}
          <p className="text-xs text-text-muted mt-2 leading-relaxed">
            Sales carrying it are read directly rather than by a stored format. An administrator
            can still confirm it if it should be used after all.
          </p>
        </div>
      )}

      {(confirm.isError || dismiss.isError) && (
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mt-3 inline-block">
          {((confirm.error ?? dismiss.error) as Error).message}
        </div>
      )}
    </div>
  );
}
