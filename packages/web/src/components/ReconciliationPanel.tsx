import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { ReconciliationBadge, AmendmentBadge } from './ReconciliationBadge';
import {
  ACTIONABLE_RECONCILIATION_OUTCOMES,
  type ReconciliationRun,
  type ReconciliationItem,
} from '@callguard/shared';

interface ReconciliationRecord {
  run: ReconciliationRun | null;
  items: ReconciliationItem[];
}

/** What POST /reconciliation/journeys/:id/learn returns. */
interface LearnOutcome {
  profileId: string | null;
  failure: 'not_configured' | 'no_attachments' | 'attachment_not_found' | 'unreadable' | 'unusable' | null;
  attachment: { id: string; file_name: string } | null;
  candidates: Array<{ id: string; file_name: string }>;
  problems: Array<{ severity: 'error' | 'warning'; message: string }>;
  notes: string | null;
  insurer: string | null;
  product: string | null;
  questionCount: number;
  reusedExisting: boolean;
}

const LEARN_FAILURES: Record<NonNullable<LearnOutcome['failure']>, string> = {
  not_configured: 'The CRM connection is not set up to read attachments.',
  no_attachments: 'There are no PDF attachments on this sale to read.',
  attachment_not_found: 'That attachment is no longer on the CRM record.',
  unreadable: 'The document could not be read — it may be a scan rather than text.',
  unusable:
    'The document was read but the proposed way of parsing it did not hold up, so nothing has been saved.',
};

/**
 * When the message above was written.
 *
 * The states that show a stored message — waiting, unrecognised, abandoned — show
 * a SNAPSHOT of a check that ran at some point, not a live verdict, and the gap
 * between the two is where the confusion lives. One sale read "None of the 1
 * attached document(s) match a known format" for half a day after the real
 * application became the second of three attachments; the panel was telling the
 * truth about a moment that had passed. Dating it is what makes that legible.
 */
function CheckedAt({ at }: { at: string | null }) {
  if (!at) return null;
  return (
    <p className="text-xs text-text-muted mt-1.5">
      Last checked{' '}
      {new Date(at).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })}
      .
    </p>
  );
}

/**
 * Check this sale again now, rather than waiting for the sweep.
 *
 * Exists because the commonest reason a parked sale is parked is that the
 * application had not been uploaded when we last looked — so the document
 * arriving is exactly the event nothing tells CallGuard about. The sweep does
 * come back on its own, but on a twelve-hour cadence for a parked run and not at
 * all for an abandoned one, which left forty of one tenant's sales written off
 * with no route back but a database write.
 *
 * The route it calls has existed all along (POST /reconciliation/journeys/:id/run);
 * only the button was missing.
 */
function RecheckAction({ journeyId, detail }: { journeyId: string; detail: string }) {
  const queryClient = useQueryClient();

  const recheck = useMutation({
    mutationFn: () => api.post<{ id: string; status: string }>(`/reconciliation/journeys/${journeyId}/run`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reconciliation-journey', journeyId] });
    },
  });

  return (
    <div className="mt-4">
      <button
        onClick={() => recheck.mutate()}
        disabled={recheck.isPending}
        aria-label="Check this sale against its application again"
        className="px-3 py-1.5 rounded-btn text-badge font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {recheck.isPending ? 'Checking again…' : 'Check this sale again'}
      </button>
      <p className="text-xs text-text-muted mt-1.5 leading-relaxed">{detail}</p>
      {recheck.isError && (
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mt-2.5 inline-block">
          {(recheck.error as Error).message}
        </div>
      )}
      {recheck.isSuccess && (
        <div className="bg-review-bg text-review px-3 py-2 rounded-btn text-table-cell mt-2.5 inline-block">
          Queued. This panel updates once the check finishes.
        </div>
      )}
    </div>
  );
}

/**
 * Teach CallGuard an insurer's document format from this sale's attachment.
 *
 * Admin-only and deliberately manual. Nothing it produces is used to judge a
 * sale until it is confirmed on the Reconciliation screen.
 */
function LearnProfileAction({ journeyId }: { journeyId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<LearnOutcome | null>(null);

  const learn = useMutation({
    mutationFn: (attachmentId: string | null) =>
      api.post<LearnOutcome>(`/reconciliation/journeys/${journeyId}/learn`, { attachmentId }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.profileId) {
        queryClient.invalidateQueries({ queryKey: ['reconciliation-profiles'] });
        navigate(`/reconciliation/profiles/${result.profileId}`);
      }
    },
  });

  return (
    <div className="mt-4">
      <button
        onClick={() => learn.mutate(null)}
        disabled={learn.isPending}
        aria-label="Read this application and propose a format for it"
        className="px-3 py-1.5 rounded-btn border border-border text-text-cell text-badge font-semibold hover:bg-sidebar-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {learn.isPending ? 'Reading the document…' : 'Read this application and propose a format'}
      </button>
      <p className="text-xs text-text-muted mt-1.5 leading-relaxed">
        Reads the attachment and works out how to parse it. You review the questions it finds
        before anything is compared against them.
      </p>

      {learn.isError && (
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mt-2.5 inline-block">
          {(learn.error as Error).message}
        </div>
      )}

      {outcome?.failure && (
        <div className="mt-2.5">
          <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">
            {LEARN_FAILURES[outcome.failure]}
          </div>
          {/* The specific reasons matter: they tell whoever is looking whether the
              wrong document was read or the right one was read badly. */}
          {outcome.problems.length > 0 && (
            <ul className="mt-2 space-y-1">
              {outcome.problems.map((p, i) => (
                <li key={i} className="text-xs text-text-muted leading-relaxed">
                  <span className={p.severity === 'error' ? 'text-fail font-semibold' : 'text-review font-semibold'}>
                    {p.severity === 'error' ? 'Problem' : 'Warning'}:
                  </span>{' '}
                  {p.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Filenames only rank the attachments; the pack often holds several PDFs and
          the firm's own suitability report looks plausible. If we read the wrong
          one, say which and let it be pointed at the right one. */}
      {outcome && outcome.candidates.length > 1 && (
        <div className="mt-3">
          <p className="text-xs text-text-secondary">
            {outcome.attachment ? (
              <>Read <span className="font-medium text-text-primary">{outcome.attachment.file_name}</span>. Wrong document? Try another:</>
            ) : (
              <>Try a specific attachment:</>
            )}
          </p>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {outcome.candidates
              .filter((c) => c.id !== outcome.attachment?.id)
              .map((c) => (
                <button
                  key={c.id}
                  onClick={() => learn.mutate(c.id)}
                  disabled={learn.isPending}
                  className="px-2.5 py-1 rounded-btn text-badge border border-border text-text-secondary hover:bg-table-header disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {c.file_name}
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Stroke icon — a document with a tick. No emoji (brand guidelines §icons). */
function DocumentCheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" strokeWidth="1.8" aria-hidden="true">
      <path
        d="M14 3v4a1 1 0 0 0 1 1h4M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5ZM9 14.5l2 2 4-4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Stroke icon — a document with a warning. No emoji (brand guidelines §icons). */
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

function PanelShell({ children, subtitle }: { children: React.ReactNode; subtitle: string }) {
  return (
    <div className="bg-card border border-border rounded-card overflow-hidden mt-4">
      <div className="px-5 py-4 border-b border-border">
        <h3 className="text-section-title text-text-primary">Reconciliation</h3>
        <p className="text-xs text-text-subtle mt-0.5">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * What the insurer received against what the customer said.
 *
 * Renders nothing when the sale has no reconciliation run — the module is off
 * for the tenant, or the sale predates it.
 */
export function ReconciliationPanel({
  journeyId,
  isAdmin,
}: {
  journeyId: string;
  isAdmin: boolean;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['reconciliation-journey', journeyId],
    queryFn: () => api.get<ReconciliationRecord>(`/reconciliation/journeys/${journeyId}`),
    refetchInterval: (query) => {
      const s = query.state.data?.run?.status;
      return s === 'pending' || s === 'running' ? 4000 : false;
    },
  });

  if (isError) {
    return (
      <PanelShell subtitle="What the insurer received, against what the customer said.">
        <div className="px-5 py-4">
          <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell inline-block">
            Could not load the reconciliation record.
          </div>
        </div>
      </PanelShell>
    );
  }

  if (isLoading) {
    return (
      <PanelShell subtitle="What the insurer received, against what the customer said.">
        <div className="px-5 py-8 flex items-center justify-center text-text-muted text-table-cell">
          <div className="w-6 h-6 border-2 border-border border-t-primary rounded-full animate-spin mr-3" />
          Loading…
        </div>
      </PanelShell>
    );
  }

  if (!data?.run) return null;
  const { run, items } = data;

  if (run.status === 'pending' || run.status === 'running') {
    return (
      <PanelShell subtitle="What the insurer received, against what the customer said.">
        <div className="px-5 py-6 flex items-center gap-3 text-text-muted text-table-cell">
          <div className="w-5 h-5 border-2 border-border border-t-primary rounded-full animate-spin" />
          Reading the application and comparing it with the call…
        </div>
      </PanelShell>
    );
  }

  // Waiting, not broken: the pack is attached to the CRM by hand after the call,
  // so a promptly scored sale legitimately has nothing to reconcile against yet.
  if (run.status === 'needs_document') {
    return (
      <PanelShell subtitle="What the insurer received, against what the customer said.">
        <div className="px-5 py-6">
          <div className="flex items-start gap-3">
            <DocumentCheckIcon className="w-5 h-5 text-text-muted flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-table-cell text-text-primary font-medium">
                Waiting for the application
              </p>
              <p className="text-xs text-text-muted mt-1 leading-relaxed">
                {run.error_message ??
                  'No application document has been attached to this sale in the CRM yet.'}{' '}
                CallGuard keeps checking, and this runs on its own once the pack is attached.
              </p>
              <CheckedAt at={run.last_attempt_at ?? run.created_at} />
              {isAdmin && (
                <RecheckAction
                  journeyId={journeyId}
                  detail="If the application has just been attached, this checks it now rather than waiting for the next automatic sweep."
                />
              )}
            </div>
          </div>
        </div>
      </PanelShell>
    );
  }

  // We stopped looking. Said plainly, because a waiting state shown for ever
  // reads as "checked, nothing found" — the opposite of what happened.
  if (run.status === 'abandoned') {
    return (
      <PanelShell subtitle="What the insurer received, against what the customer said.">
        <div className="px-5 py-6">
          <div className="flex items-start gap-3">
            <DocumentAlertIcon className="w-5 h-5 text-text-muted flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-table-cell text-text-primary font-medium">
                This sale was never checked
              </p>
              <p className="text-xs text-text-muted mt-1 leading-relaxed">
                {run.error_message ??
                  'No application document was attached to this sale in the CRM, so there was nothing to compare the call against.'}
              </p>
              <CheckedAt at={run.last_attempt_at ?? run.created_at} />
              {isAdmin && (
                <RecheckAction
                  journeyId={journeyId}
                  detail="Attach the application to the CRM record, then check again — an abandoned sale is never revisited on its own, so this is the only way back."
                />
              )}
            </div>
          </div>
        </div>
      </PanelShell>
    );
  }

  // A person has to confirm how this document is read before any answer is judged
  // against it. Two ways to get here, told apart structurally rather than by
  // matching on the message text: a format we know whose question set changed
  // (the run carries the profile it drifted from), or one we have never seen.
  if (run.status === 'needs_profile') {
    const unrecognised = run.profile_id === null;
    return (
      <PanelShell subtitle="What the insurer received, against what the customer said.">
        <div className="px-5 py-6">
          <div className="bg-review-bg text-review px-3 py-2 rounded-btn text-table-cell">
            {run.error_message ??
              (unrecognised
                ? 'This document format has not been set up yet, so nothing has been compared.'
                : 'The insurer’s question set has changed since this document type was last reviewed.')}
          </div>
          <p className="text-xs text-text-muted mt-2.5 leading-relaxed">
            {unrecognised
              ? 'Nothing has been compared, because CallGuard does not yet know how to read this insurer’s application. '
              : 'Nothing has been compared, because judging answers against an out-of-date question set would produce misleading results. '}
            {isAdmin ? (
              <>
                Read {unrecognised ? 'the document' : 'the new version'} below, then confirm it on{' '}
                <Link to="/reconciliation" className="text-primary hover:underline">
                  Reconciliation
                </Link>
                . This sale is reconciled automatically once you do, and every future sale on
                this format is read without asking again.
              </>
            ) : (
              `An administrator needs to review ${unrecognised ? 'this format' : 'the change'} before this sale can be reconciled.`
            )}
          </p>
          <CheckedAt at={run.last_attempt_at ?? run.created_at} />
          {/* Re-check FIRST, and deliberately so on an unrecognised format.
              "None of the N attached documents match a known format" is a
              statement about the pack as it was when we looked, and the pack
              grows: one sale said "none of the 1 document(s)" while the real
              application sat second of three, already covered by a format that
              was live. Proposing a format there teaches nothing and puts another
              row in somebody's review queue, when the sale needed looking at
              again. Learning a format is the right move only once a re-check has
              confirmed the document genuinely is not one we know. */}
          {isAdmin && (
            <RecheckAction
              journeyId={journeyId}
              detail={
                unrecognised
                  ? 'Documents are often attached after the sale is scored. Check again first — if the application has arrived since, it may already be covered by a format that is live.'
                  : 'Checks the pack as it stands now, in case the document has been replaced with one matching the format already in use.'
              }
            />
          )}
          {isAdmin && <LearnProfileAction journeyId={journeyId} />}
        </div>
      </PanelShell>
    );
  }

  // Explicit, so a clean panel is never read as "the health answers matched"
  // when the document never contained any.
  if (run.status === 'summary_only') {
    return (
      <PanelShell subtitle="What the insurer received, against what the customer said.">
        <div className="px-5 py-6">
          <p className="text-table-cell text-text-primary font-medium">
            This insurer returns a summary, not a question set
          </p>
          <p className="text-xs text-text-muted mt-1 leading-relaxed">
            {run.attachment_name ? <><span className="text-text-secondary">{run.attachment_name}</span> contains </> : 'The application document contains '}
            the policy and applicant details but no health or lifestyle questions, so there is
            nothing to compare those answers against. This is how the product is underwritten,
            not a fault — but it does mean an omission here would not be detected.
          </p>
        </div>
      </PanelShell>
    );
  }

  // The document is fine and the call is fine; the pairing between them is not.
  // Given its own state rather than a quiet 'undetermined' on two rows, because
  // that is exactly how a sale once produced six findings against an adviser
  // with the disproof sitting above them. Nothing was compared, and the sale is
  // waiting on a person rather than a clock — so no "we will keep checking".
  if (run.status === 'identity_mismatch') {
    return (
      <PanelShell subtitle="What the insurer received, against what the customer said.">
        <div className="px-5 py-6">
          <div className="flex items-start gap-3">
            <DocumentAlertIcon className="w-5 h-5 text-fail flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-table-cell text-text-primary font-medium">
                This application and this call are about different people
              </p>
              <p className="text-xs text-text-muted mt-1 leading-relaxed">
                {run.error_message ??
                  'The date of birth on the application does not match the one given on the call, by more than a mishearing can explain. Nothing has been compared.'}
              </p>
              <p className="text-xs text-text-muted mt-2 leading-relaxed">
                Sales are matched to a customer by phone number, so a mobile shared
                within a household can attach the wrong recording. Check which call
                belongs to this sale, then re-run the check.
              </p>
            </div>
          </div>
        </div>
      </PanelShell>
    );
  }

  if (run.status === 'failed') {
    return (
      <PanelShell subtitle="What the insurer received, against what the customer said.">
        <div className="px-5 py-6">
          <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell inline-block">
            Reconciliation failed{run.error_message ? `: ${run.error_message}` : ''}.
          </div>
        </div>
      </PanelShell>
    );
  }

  const mismatches = items.filter((i) => i.outcome === 'mismatch').length;
  const notAsked = items.filter((i) => i.outcome === 'not_asked').length;
  const noAnswer = items.filter((i) => i.outcome === 'asked_no_answer').length;
  const undetermined = items.filter((i) => i.outcome === 'undetermined').length;
  const withdrawn = items.filter((i) => i.amendment_type === 'disclosure_withdrawn').length;
  const leftBlank = items.filter((i) => i.outcome === 'missing_from_application').length;

  // Attention first — a supervisor should not have to scroll 50 rows to find the
  // three that matter. Taken from the shared constant rather than re-listed, so
  // an outcome added there cannot go quietly missing from this queue.
  const flagged = items.filter(
    (i) =>
      ACTIONABLE_RECONCILIATION_OUTCOMES.includes(i.outcome) ||
      i.amendment_type === 'disclosure_withdrawn'
  );
  const rest = items.filter((i) => !flagged.includes(i));

  return (
    <PanelShell
      subtitle={
        run.attachment_name
          ? `What the insurer received on ${run.attachment_name}, against what the customer said.`
          : 'What the insurer received, against what the customer said.'
      }
    >
      {/* Summary strip — meaning carried by the label, not colour alone (§7). */}
      <div className="px-5 py-3 border-b border-border-light flex flex-wrap gap-4 text-badge">
        <span className="text-text-secondary">
          <strong className="text-text-primary">{items.length}</strong> questions on the application
        </span>
        <span className={mismatches > 0 ? 'text-fail font-semibold' : 'text-text-muted'}>
          {mismatches} do not match
        </span>
        <span className={notAsked > 0 ? 'text-fail font-semibold' : 'text-text-muted'}>
          {notAsked} not asked
        </span>
        {noAnswer > 0 && <span className="text-review font-semibold">{noAnswer} no answer given</span>}
        {leftBlank > 0 && (
          <span className="text-fail font-semibold">{leftBlank} left blank on the form</span>
        )}
        {withdrawn > 0 && (
          <span className="text-fail font-semibold">{withdrawn} disclosure withdrawn</span>
        )}
        {undetermined > 0 && <span className="text-text-muted">{undetermined} could not verify</span>}
      </div>

      {undetermined > 0 && (
        <p className="px-5 py-2.5 text-xs text-text-muted border-b border-border-light leading-relaxed">
          &ldquo;Could not verify&rdquo; means the call could not be checked for that question, usually
          because personal or health wording is removed from stored transcripts. It is not a finding
          either way.
        </p>
      )}

      {items.length === 0 ? (
        <p className="px-5 py-8 text-center text-text-muted text-table-cell">
          No questions were found on the application document.
        </p>
      ) : (
        <div>
          {flagged.length > 0 && (
            <div className="px-5 py-2 bg-table-header">
              <span className="text-table-header uppercase text-text-muted">Needs attention</span>
            </div>
          )}
          {flagged.map((item) => (
            <ReconciliationRow key={item.id} item={item} />
          ))}
          {rest.length > 0 && flagged.length > 0 && (
            <div className="px-5 py-2 bg-table-header">
              <span className="text-table-header uppercase text-text-muted">Everything else</span>
            </div>
          )}
          {rest.map((item) => (
            <ReconciliationRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </PanelShell>
  );
}

function ReconciliationRow({ item }: { item: ReconciliationItem }) {
  const evidenceHref = item.source_call_id
    ? `/calls/${item.source_call_id}${item.source_timestamp != null ? `?t=${Math.floor(item.source_timestamp)}` : ''}`
    : null;

  return (
    <div className="px-5 py-3.5 border-b border-border-light last:border-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-table-cell text-text-primary font-medium">{item.question}</div>

          <div className="mt-1.5 flex flex-col gap-1 text-table-cell">
            <div className="text-text-secondary">
              Application:{' '}
              {item.application_answer ? (
                <strong className="text-text-primary">{item.application_answer}</strong>
              ) : (
                <span className="text-text-muted italic">no answer recorded</span>
              )}
            </div>
            <div className="text-text-secondary">
              On the call:{' '}
              {item.call_answer ? (
                <strong className="text-text-primary">{item.call_answer}</strong>
              ) : item.call_answer_redacted ? (
                <span className="text-text-muted italic">answered — value not stored (personal data)</span>
              ) : (
                <span className="text-text-muted italic">not found</span>
              )}
            </div>
          </div>

          {/* The insurer's own audit trail. The submitted document shows only the
              end state, so a withdrawn disclosure is invisible without this. */}
          {item.revisions?.length > 0 && (
            <div className="mt-2 text-xs text-text-muted leading-relaxed">
              <span className="text-text-secondary font-medium">Answer history:</span>{' '}
              {item.revisions.map((r, i) => (
                <span key={i}>
                  &ldquo;{r.value}&rdquo;
                  {r.timestamp ? <span className="text-text-muted"> ({r.timestamp})</span> : null}
                  {' → '}
                </span>
              ))}
              <span className="text-text-secondary">&ldquo;{item.application_answer}&rdquo;</span>
              {item.application_recorded_by ? (
                <span className="text-text-muted"> · recorded by {item.application_recorded_by}</span>
              ) : null}
            </div>
          )}

          {item.evidence && (
            <blockquote className="text-xs text-text-muted italic border-l-2 border-border pl-2.5 mt-1.5 leading-relaxed">
              {item.evidence}
              {evidenceHref && (
                <Link to={evidenceHref} className="not-italic ml-2 text-primary hover:underline">
                  {item.source_timestamp != null ? 'hear it in the call →' : 'source call →'}
                </Link>
              )}
            </blockquote>
          )}

          {item.reasoning && (
            <p className="text-xs text-text-muted mt-1.5 leading-relaxed">{item.reasoning}</p>
          )}
        </div>

        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <ReconciliationBadge outcome={item.outcome} />
          {item.amendment_type && <AmendmentBadge type={item.amendment_type} />}
          {item.confidence != null && (
            <span className="text-[11px] text-text-muted">
              {(Number(item.confidence) * 100).toFixed(0)}% confidence
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
