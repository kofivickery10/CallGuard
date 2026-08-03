import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import type { DocumentProfile, QuestionSetDrift } from '@callguard/shared';

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

  const confirm = useMutation({
    mutationFn: () => api.put<{ id: string; requeued?: number }>(`/reconciliation/profiles/${id}/confirm`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reconciliation-profiles'] });
      queryClient.invalidateQueries({ queryKey: ['reconciliation-runs'] });
      queryClient.invalidateQueries({ queryKey: ['reconciliation-profile', id] });
      navigate('/application-checks');
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
        <Link to="/application-checks" className="text-table-cell text-primary hover:underline">
          ← Application Checks
        </Link>
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mt-4 inline-block">
          Could not load this question set.
        </div>
      </div>
    );
  }

  const { profile, incumbent, drift } = data;
  const awaiting = profile.status === 'needs_confirmation';
  const questions = profile.questions ?? [];
  const unverifiable = questions.filter((q) => !q.absence_meaningful).length;

  return (
    <div>
      <Link to="/application-checks" className="text-table-cell text-primary hover:underline">
        ← Application Checks
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
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      {awaiting && (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          {isAdmin ? (
            <>
              <button
                onClick={() => confirm.mutate()}
                disabled={confirm.isPending || questions.length === 0}
                className="px-4 py-2 rounded-btn text-table-cell font-semibold bg-primary text-white hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {confirm.isPending ? 'Confirming…' : 'Confirm this question set'}
              </button>
              <Link
                to="/application-checks"
                className="px-4 py-2 rounded-btn text-table-cell font-semibold border border-border text-text-secondary hover:bg-table-header focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Not now
              </Link>
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

      {confirm.isError && (
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mt-3 inline-block">
          {(confirm.error as Error).message}
        </div>
      )}
    </div>
  );
}
