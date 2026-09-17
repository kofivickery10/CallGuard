import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDialog } from '../components/DialogProvider';
import {
  scorecardItemsToCsv,
  scorecardTemplateCsv,
  downloadCsv,
  csvFilename,
} from '../lib/scorecard-csv';
import type { Scorecard, ScorecardItem, ScorecardListEntry } from '@callguard/shared';

const shimmerStyle = {
  backgroundImage:
    'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
};
const shimmer = 'h-4 rounded bg-[length:800px_100%] animate-skeleton-shimmer';

const PRIMARY_BTN =
  'px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary text-on-solid hover:bg-primary-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const SECONDARY_BTN =
  'px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const ROW_ACTION =
  'px-2.5 py-1.5 rounded-btn text-table-cell font-semibold text-text-secondary hover:bg-sidebar-hover hover:text-text-primary disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';

function ScorecardRowSkeleton() {
  return (
    <div className="px-5 py-4 border-b border-border-light last:border-0 space-y-2.5">
      <div className={shimmer} style={{ ...shimmerStyle, width: '38%' }} />
      <div className={shimmer} style={{ ...shimmerStyle, width: '62%' }} />
    </div>
  );
}

/**
 * Which scorecard a call lands on when it names none. Both scoring paths take
 * the org's OLDEST active scorecard (jobs/processors/score.ts and
 * assemble-journey.ts both `ORDER BY created_at ASC`), so with more than one
 * live the older silently wins and the newer one scores nothing.
 */
function LiveBadge({ live }: { live: boolean }) {
  if (!live) {
    return <span className="text-badge font-semibold text-text-muted">Not live</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 text-badge font-semibold px-2.5 py-[3px] rounded-full bg-pass-bg text-pass">
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      Live
    </span>
  );
}

function formatEdited(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function Scorecards() {
  const { user } = useAuth();
  const { confirm } = useDialog();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isAdmin = user?.role === 'admin';

  // Announced to a screen reader and shown under the header — every action on
  // this page changes something a person can't see from the row alone.
  const [status, setStatus] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isLoading, isError, isRefetching, refetch } = useQuery({
    queryKey: ['scorecards'],
    queryFn: () => api.get<{ data: ScorecardListEntry[] }>('/scorecards'),
  });

  const scorecards = data?.data ?? [];
  // The API returns live scorecards first, oldest first — the same order
  // scoring resolves them in.
  const liveScorecards = scorecards.filter((s) => s.is_active);
  const defaultScorecard = liveScorecards[0];

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['scorecards'] });

  const setActive = async (scorecard: ScorecardListEntry, next: boolean) => {
    const onlyLive = next === false && liveScorecards.length === 1 && scorecard.is_active;
    const message = next
      ? `Make "${scorecard.name}" the live scorecard? Calls that don't name a scorecard will be scored against this one from now on.`
      : onlyLive
        ? `Retire "${scorecard.name}"? It is the only live scorecard, so new calls will have nothing to score against until you make another one live. Sales already scored keep their results.`
        : `Retire "${scorecard.name}"? It stops being used to score new calls. Sales already scored against it keep their results.`;
    const ok = await confirm(message, {
      danger: !next,
      confirmLabel: next ? 'Make live' : 'Retire',
    });
    if (!ok) return;

    setActionError('');
    setBusyId(scorecard.id);
    try {
      await api.put(`/scorecards/${scorecard.id}`, { is_active: next });
      await refresh();
      setStatus(
        next
          ? `"${scorecard.name}" is now the live scorecard.`
          : `"${scorecard.name}" is retired and will not score new calls.`
      );
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const duplicate = async (scorecard: ScorecardListEntry) => {
    setActionError('');
    setBusyId(scorecard.id);
    try {
      const copy = await api.post<Scorecard>(`/scorecards/${scorecard.id}/duplicate`);
      await refresh();
      setStatus(`Copied "${scorecard.name}". Opening the copy.`);
      navigate(`/scorecards/${copy.id}/edit`);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  // Rendered here from the scorecard's own checkpoints — there is no export
  // endpoint, and nothing leaves the browser.
  const exportCsv = async (scorecard: ScorecardListEntry) => {
    setActionError('');
    setBusyId(scorecard.id);
    try {
      const full = await api.get<Scorecard & { items: ScorecardItem[] }>(`/scorecards/${scorecard.id}`);
      downloadCsv(csvFilename(scorecard.name), scorecardItemsToCsv(full.items ?? []));
      setStatus(`Exported ${plural(full.items?.length ?? 0, 'checkpoint', 'checkpoints')} from "${scorecard.name}".`);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const downloadTemplate = () => {
    downloadCsv('callguard-scorecard-template.csv', scorecardTemplateCsv());
    setStatus('Template downloaded.');
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Scorecards</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            The checkpoints your calls are scored against.
          </p>
        </div>
        {isAdmin && scorecards.length > 0 && (
          <Link to="/scorecards/new" className={PRIMARY_BTN}>
            New scorecard
          </Link>
        )}
      </div>

      <div aria-live="polite" className="sr-only">
        {status}
      </div>

      {status && (
        <p className="text-table-cell text-pass mb-4 flex items-center gap-2">
          <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {status}
        </p>
      )}

      {actionError && (
        <div role="alert" className="bg-fail-bg text-fail px-4 py-3 rounded-btn text-table-cell mb-4">
          {actionError}
        </div>
      )}

      {liveScorecards.length > 1 && defaultScorecard && (
        <div role="status" className="bg-fail-bg text-fail px-4 py-3 rounded-card text-table-cell mb-4">
          <p className="font-semibold">
            {liveScorecards.length === 2 ? 'Two scorecards are live.' : `${liveScorecards.length} scorecards are live.`}{' '}
            {liveScorecards.length === 2
              ? `Calls that don't name one are scored against the older of the two — ${defaultScorecard.name}.`
              : `Calls that don't name one are scored against the oldest — ${defaultScorecard.name}.`}{' '}
            {liveScorecards.length === 2
              ? "Retire the one you're not using."
              : "Retire the ones you're not using."}
          </p>
          <p className="mt-1 opacity-90">
            Live streaming sessions that name no scorecard take whichever the database returns
            first, so they may not use {defaultScorecard.name} at all.
          </p>
        </div>
      )}

      {isError ? (
        <div role="alert" className="bg-fail-bg text-fail px-4 py-3 rounded-btn text-table-cell inline-flex items-center gap-3">
          Could not load scorecards.
          <button
            onClick={() => refetch()}
            disabled={isRefetching}
            className="underline font-semibold disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
          >
            {isRefetching ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ) : isLoading ? (
        <div className="bg-card border border-border rounded-card overflow-hidden" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <ScorecardRowSkeleton key={`skeleton-${i}`} />
          ))}
        </div>
      ) : scorecards.length === 0 ? (
        <div className="bg-card border border-border rounded-card p-10 text-center">
          <h3 className="text-section-title text-text-primary">Start from your own QA manual</h3>
          <p className="text-table-cell text-text-secondary mt-2 max-w-[52ch] mx-auto">
            A scorecard is the list of checkpoints every call is judged against. Bring in the
            manual your assessors already use as a CSV, and you can tidy it up here.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 mt-5">
            <Link to="/scorecards/new?import=csv" className={PRIMARY_BTN}>
              Import your QA manual (CSV)
            </Link>
            <Link to="/scorecards/new" className={SECONDARY_BTN}>
              Start from scratch
            </Link>
          </div>
          <button type="button" onClick={downloadTemplate} className="mt-4 text-table-cell text-primary-ink font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded">
            Download the template CSV
          </button>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-card overflow-hidden">
          {scorecards.map((scorecard) => {
            const unit = scorecard.scoring_mode === 'per_call' ? 'call' : 'sale';
            const meta = [
              plural(scorecard.checkpoint_count, 'checkpoint', 'checkpoints'),
              plural(scorecard.section_count, 'section', 'sections'),
              `v${scorecard.version}`,
              `edited ${formatEdited(scorecard.updated_at)}`,
            ];
            const usage = [
              scorecard.scored_units > 0
                ? `Scoring ${plural(scorecard.scored_units, unit, `${unit}s`)}`
                : 'Scoring nothing yet',
              ...(scorecard.scored_units > 0 && scorecard.pass_rate != null
                ? [`${Math.round(scorecard.pass_rate)}% pass`]
                : []),
              ...(scorecard.critical_count > 0
                ? [`${plural(scorecard.critical_count, 'critical checkpoint', 'critical checkpoints')}`]
                : []),
              ...(scorecard.consent_gate_count > 0
                ? [`${plural(scorecard.consent_gate_count, 'consent gate', 'consent gates')}`]
                : []),
            ];
            const busy = busyId === scorecard.id;

            return (
              <div
                key={scorecard.id}
                className="px-5 py-4 border-b border-border-light last:border-0 flex flex-wrap items-start justify-between gap-x-4 gap-y-3"
              >
                <div className="min-w-[240px] flex-1">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <Link
                      to={`/scorecards/${scorecard.id}/edit`}
                      className="text-section-title text-text-primary hover:text-primary-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                    >
                      {scorecard.name}
                    </Link>
                    <LiveBadge live={scorecard.is_active} />
                  </div>
                  <p className="text-xs text-text-muted mt-1">{meta.join(' · ')}</p>
                  <p className="text-xs text-text-secondary mt-0.5">{usage.join(' · ')}</p>
                </div>

                <div className="flex items-center gap-1 flex-wrap">
                  <Link to={`/scorecards/${scorecard.id}/edit`} className={ROW_ACTION}>
                    Edit
                  </Link>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => duplicate(scorecard)}
                      disabled={busy}
                      className={ROW_ACTION}
                    >
                      Duplicate
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => exportCsv(scorecard)}
                    disabled={busy}
                    className={ROW_ACTION}
                  >
                    Export CSV
                  </button>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => setActive(scorecard, !scorecard.is_active)}
                      disabled={busy}
                      className={ROW_ACTION}
                    >
                      {scorecard.is_active ? 'Retire' : 'Make live'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
