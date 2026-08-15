import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ReconciliationRunStatus, DocumentProfileStatus } from '@callguard/shared';

interface RunRow {
  id: string;
  journey_id: string;
  status: ReconciliationRunStatus;
  attachment_name: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  customer_name: string | null;
  insurer: string | null;
  product: string | null;
  mismatches: number;
  not_asked: number;
  no_answer: number;
  /** Presence-mode fields left blank where the application required one. */
  missing: number;
  undetermined: number;
  withdrawn: number;
  total_questions: number;
}

interface ProfileRow {
  id: string;
  insurer: string;
  product: string | null;
  strategy: string;
  status: DocumentProfileStatus;
  version: number;
  question_count: number;
  confirmed_at: string | null;
  dismissed_at: string | null;
  dismissed_reason: string | null;
  created_at: string;
}

const RUN_STATUS: Record<ReconciliationRunStatus, { label: string; className: string }> = {
  completed: { label: 'Checked', className: 'bg-pass-bg text-pass' },
  running: { label: 'Running', className: 'bg-processing-bg text-processing' },
  pending: { label: 'Queued', className: 'bg-processing-bg text-processing' },
  needs_document: { label: 'Waiting for document', className: 'bg-review-bg text-review' },
  needs_profile: { label: 'Needs review', className: 'bg-review-bg text-review' },
  summary_only: { label: 'No questions', className: 'bg-table-header text-text-secondary' },
  failed: { label: 'Failed', className: 'bg-fail-bg text-fail' },
  abandoned: { label: 'Never checked', className: 'bg-table-header text-text-secondary' },
};

/** Stroke icon (§icons) — a document with a warning. */
function DocumentAlertIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" strokeWidth="1.8" aria-hidden="true">
      <path
        d="M14 3v4a1 1 0 0 0 1 1h4M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5ZM12 11v3.5M12 17.5h.01"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Spinner() {
  return (
    <div className="px-5 py-8 flex items-center justify-center text-text-muted text-table-cell">
      <div className="w-6 h-6 border-2 border-border border-t-primary rounded-full animate-spin mr-3" />
      Loading…
    </div>
  );
}

/**
 * Data Forms: what the insurer received against what the customer said,
 * across every sale — plus the insurer question sets that drive it.
 *
 * The confirmation queue sits at the top on purpose. While a question set is
 * unconfirmed, every sale using it is parked: not failing, not passing, just
 * waiting on a person. That is the one thing on this page that blocks work.
 */
export function DataForms() {
  const {
    data: profilesData,
    isLoading: profilesLoading,
    isError: profilesError,
  } = useQuery({
    queryKey: ['reconciliation-profiles'],
    queryFn: () => api.get<{ data: ProfileRow[] }>('/reconciliation/profiles'),
  });

  const {
    data: runsData,
    isLoading: runsLoading,
    isError: runsError,
  } = useQuery({
    queryKey: ['reconciliation-runs'],
    queryFn: () => api.get<{ data: RunRow[] }>('/reconciliation/runs?limit=100'),
  });

  const profiles = profilesData?.data ?? [];
  const awaiting = profiles.filter((p) => p.status === 'needs_confirmation');
  const active = profiles.filter((p) => p.status === 'active');
  // Shown, quietly, rather than hidden. Dismissing is reversible, and a decision
  // you cannot find is not reversible in practice — the only way back would be a
  // URL nobody kept.
  const dismissed = profiles.filter((p) => p.status === 'dismissed');

  // The Compliance dashboard deep-links into these sections (#attention,
  // #awaiting). React Router does not act on a hash by itself, and the target
  // does not exist until its query has painted, so this re-runs as they load.
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [hash, runsLoading, profilesLoading]);

  const runs = runsData?.data ?? [];
  // 'undetermined' is deliberately not a finding: it means we could not tell,
  // usually because redaction removed the words that identify the question.
  // Counting it here would bury the real flags under noise of our own making.
  const attention = runs.filter(
    (r) =>
      r.mismatches > 0 ||
      r.not_asked > 0 ||
      r.no_answer > 0 ||
      // A required field left blank on the application. Unlike the others this
      // is visible from the document alone, but it still needs someone.
      r.missing > 0 ||
      r.withdrawn > 0 ||
      r.status === 'needs_profile' ||
      r.status === 'failed'
  );

  return (
    <div>
      <div className="mb-7">
        <h2 className="text-page-title text-text-primary">Data Forms</h2>
        <p className="text-page-sub text-text-subtle mt-1">
          The application submitted to the insurer, compared against what the customer actually
          said on the call.
        </p>
      </div>

      {/* Waiting on a person — first, because nothing moves until it is done. */}
      {awaiting.length > 0 && (
        <div id="awaiting" className="bg-card border border-review rounded-card overflow-hidden mb-5 scroll-mt-4">
          <div className="px-5 py-4 border-b border-border flex items-start gap-3">
            <DocumentAlertIcon className="w-5 h-5 text-review flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="text-section-title text-text-primary">
                Question sets awaiting confirmation ({awaiting.length})
              </h3>
              <p className="text-xs text-text-subtle mt-0.5 leading-relaxed">
                Either an insurer changed their questions or a format is new. Sales using these are
                paused until someone confirms the question set is right — comparing answers against
                the wrong list is worse than not comparing at all.
              </p>
            </div>
          </div>
          {awaiting.map((p) => (
            <Link
              key={p.id}
              to={`/data-forms/profiles/${p.id}`}
              className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-border-light last:border-0 hover:bg-table-header transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <div className="min-w-0">
                <div className="text-table-cell text-text-primary font-medium">
                  {p.insurer}
                  {p.product ? <span className="text-text-muted font-normal"> — {p.product}</span> : null}
                </div>
                <div className="text-xs text-text-muted mt-0.5">
                  {p.question_count} question{p.question_count === 1 ? '' : 's'} · version {p.version} ·
                  proposed {new Date(p.created_at).toLocaleDateString('en-GB')}
                </div>
              </div>
              <span className="px-2.5 py-[3px] rounded-full text-badge font-semibold bg-review-bg text-review flex-shrink-0">
                Review
              </span>
            </Link>
          ))}
        </div>
      )}

      {dismissed.length > 0 && (
        <details className="bg-card border border-border rounded-card overflow-hidden mb-5">
          <summary className="px-5 py-3 cursor-pointer text-table-cell text-text-secondary hover:bg-table-header focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
            Formats dismissed ({dismissed.length})
          </summary>
          <p className="px-5 pb-3 text-xs text-text-subtle leading-relaxed">
            Proposed formats somebody decided not to use. They are not proposed again, and sales
            carrying them are read directly instead. Open one to use it after all.
          </p>
          {dismissed.map((p) => (
            <Link
              key={p.id}
              to={`/data-forms/profiles/${p.id}`}
              className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-t border-border-light hover:bg-table-header transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <div className="min-w-0">
                <div className="text-table-cell text-text-secondary">
                  {p.insurer}
                  {p.product ? <span className="text-text-muted"> — {p.product}</span> : null}
                </div>
                {p.dismissed_reason ? (
                  <div className="text-xs text-text-muted mt-0.5">{p.dismissed_reason}</div>
                ) : null}
              </div>
              <span className="text-xs text-text-muted flex-shrink-0">
                {p.dismissed_at ? new Date(p.dismissed_at).toLocaleDateString('en-GB') : ''}
              </span>
            </Link>
          ))}
        </details>
      )}

      {/* Sales needing attention */}
      <div id="attention" className="bg-card border border-border rounded-card overflow-hidden mb-5 scroll-mt-4">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-section-title text-text-primary">
            Sales needing attention ({attention.length})
          </h3>
          <p className="text-xs text-text-subtle mt-0.5">
            Answers that do not match the call, questions never asked, and disclosures that were
            withdrawn before submission.
          </p>
        </div>
        {runsError ? (
          <div className="px-5 py-4">
            <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell inline-block">
              Could not load application checks.
            </div>
          </div>
        ) : runsLoading ? (
          <Spinner />
        ) : runs.length === 0 ? (
          <p className="px-5 py-8 text-center text-text-muted text-table-cell">
            No sales have been checked yet. Checks start automatically once a sale is scored and its
            application document is on the CRM record.
          </p>
        ) : attention.length === 0 ? (
          <p className="px-5 py-8 text-center text-text-muted text-table-cell">
            Nothing needs attention across {runs.length} checked sale{runs.length === 1 ? '' : 's'}.
          </p>
        ) : (
          <div>
            {attention.map((r) => (
              <Link
                key={r.id}
                to={`/journeys/${r.journey_id}`}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-border-light last:border-0 hover:bg-table-header transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <div className="min-w-0">
                  <div className="text-table-cell text-text-primary font-medium">
                    {r.customer_name ?? 'Unknown customer'}
                    {r.insurer ? (
                      <span className="text-text-muted font-normal"> — {r.insurer}</span>
                    ) : null}
                  </div>
                  <div className="text-xs text-text-muted mt-0.5">
                    {new Date(r.created_at).toLocaleDateString('en-GB')}
                    {r.total_questions > 0 ? ` · ${r.total_questions} questions` : ''}
                    {r.status === 'failed' && r.error_message ? ` · ${r.error_message}` : ''}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 flex-shrink-0">
                  {r.mismatches > 0 && (
                    <span className="px-2.5 py-[3px] rounded-full text-badge font-semibold bg-fail-bg text-fail">
                      {r.mismatches} do not match
                    </span>
                  )}
                  {r.not_asked > 0 && (
                    <span className="px-2.5 py-[3px] rounded-full text-badge font-semibold bg-fail-bg text-fail">
                      {r.not_asked} not asked
                    </span>
                  )}
                  {r.missing > 0 && (
                    <span className="px-2.5 py-[3px] rounded-full text-badge font-semibold bg-fail-bg text-fail">
                      {r.missing} left blank
                    </span>
                  )}
                  {r.withdrawn > 0 && (
                    <span className="px-2.5 py-[3px] rounded-full text-badge font-semibold bg-fail-bg text-fail">
                      {r.withdrawn} withdrawn
                    </span>
                  )}
                  {r.no_answer > 0 && (
                    <span className="px-2.5 py-[3px] rounded-full text-badge font-semibold bg-review-bg text-review">
                      {r.no_answer} no answer
                    </span>
                  )}
                  <span
                    className={`px-2.5 py-[3px] rounded-full text-badge font-semibold ${RUN_STATUS[r.status].className}`}
                  >
                    {RUN_STATUS[r.status].label}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Active question sets */}
      <div className="bg-card border border-border rounded-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-section-title text-text-primary">Insurer question sets</h3>
          <p className="text-xs text-text-subtle mt-0.5">
            Learned once per insurer document, then reused at no cost. CallGuard checks every
            document against its stored question set and stops if the insurer has changed it.
          </p>
        </div>
        {profilesError ? (
          <div className="px-5 py-4">
            <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell inline-block">
              Could not load question sets.
            </div>
          </div>
        ) : profilesLoading ? (
          <Spinner />
        ) : active.length === 0 ? (
          <p className="px-5 py-8 text-center text-text-muted text-table-cell">
            No question sets yet. Open a sale with an application attached and choose
            &ldquo;Read this application and propose a format&rdquo; to add the first one.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-table-header text-left">
                  <th className="px-5 py-3 text-table-header text-text-muted uppercase tracking-wider">
                    Insurer
                  </th>
                  <th className="px-5 py-3 text-table-header text-text-muted uppercase tracking-wider">
                    Product
                  </th>
                  <th className="px-5 py-3 text-table-header text-text-muted uppercase tracking-wider text-right">
                    Questions
                  </th>
                  <th className="px-5 py-3 text-table-header text-text-muted uppercase tracking-wider text-right">
                    Version
                  </th>
                  <th className="px-5 py-3 text-table-header text-text-muted uppercase tracking-wider">
                    Confirmed
                  </th>
                </tr>
              </thead>
              <tbody>
                {active.map((p) => (
                  <tr key={p.id} className="border-t border-border-light">
                    <td className="px-5 py-3 text-table-cell text-text-primary">
                      <Link
                        to={`/data-forms/profiles/${p.id}`}
                        className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-btn"
                      >
                        {p.insurer}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-table-cell text-text-muted">{p.product ?? '—'}</td>
                    <td className="px-5 py-3 text-table-cell text-text-secondary text-right">
                      {p.question_count}
                    </td>
                    <td className="px-5 py-3 text-table-cell text-text-muted text-right">
                      v{p.version}
                    </td>
                    <td className="px-5 py-3 text-table-cell text-text-muted">
                      {p.confirmed_at ? new Date(p.confirmed_at).toLocaleDateString('en-GB') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
