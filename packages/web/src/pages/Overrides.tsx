import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type {
  OverrideRegisterEntry,
  OverrideRegisterSummary,
  OverrideDirection,
} from '@callguard/shared';

// The override register (CG-7).
//
// Every time a person overturned the AI: who, when, on what, from what, to
// what, and why. The data has been recorded since migration 068; this is the
// first place it can be read as a record rather than as an aggregate.
//
// Not behind the Pro plan, unlike Calibration next door. Trust Point's QA score
// feeds adviser commission, and a firm that cannot produce its own override
// history for a regulator does not have a defensible record — that must not
// depend on a plan tier.

const DIRECTION_LABELS: Record<OverrideDirection, string> = {
  ai_too_harsh: 'AI too harsh',
  ai_too_lenient: 'AI too lenient',
  ai_undecided: 'AI could not decide',
  unchanged: 'Unchanged',
};

// None of these is a failure, so none uses fail styling. "AI could not decide"
// in particular is the model behaving correctly — it declined to guess and a
// person ruled — and colouring it as a problem would misread the whole point.
const DIRECTION_CLASS: Record<OverrideDirection, string> = {
  ai_too_harsh: 'bg-review-bg text-review',
  ai_too_lenient: 'bg-review-bg text-review',
  ai_undecided: 'bg-table-header text-text-muted',
  unchanged: 'bg-table-header text-text-muted',
};

const TH = 'px-5 py-2.5 text-left text-table-header text-text-muted';
const TD = 'px-5 py-3.5 text-table-cell text-text-cell align-top';

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function Overrides() {
  const [direction, setDirection] = useState<'' | OverrideDirection>('');
  const [missingReason, setMissingReason] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const onFilterChange = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  const qs =
    (from ? `&from=${from}` : '') +
    (to ? `&to=${to}` : '') +
    (direction ? `&direction=${direction}` : '') +
    (missingReason ? '&missing_reason=true' : '');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['overrides', from, to, direction, missingReason, page],
    queryFn: () =>
      api.get<{ data: OverrideRegisterEntry[]; total: number; page: number; limit: number }>(
        `/overrides?page=${page}&limit=50${qs}`
      ),
  });

  // The summary describes the whole filtered set, so it takes only the filters
  // that bound the period — not direction, which would make each headline
  // count describe itself.
  const { data: summary } = useQuery({
    queryKey: ['overrides-summary', from, to],
    queryFn: () =>
      api.get<OverrideRegisterSummary>(
        `/overrides/summary?${from ? `from=${from}&` : ''}${to ? `to=${to}` : ''}`
      ),
  });

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = data ? Math.ceil(total / data.limit) : 0;
  const filtered = !!(direction || missingReason || from || to);

  return (
    <div>
      <div className="mb-7">
        <h2 className="text-page-title text-text-primary">Override register</h2>
        <p className="text-page-sub text-text-subtle mt-1">
          Every checkpoint a person overturned — who, when, from what, to what, and why.
          CallGuard is the system of record for the score; this is the trail behind it.
        </p>
      </div>

      {summary && summary.total > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <div className="bg-card border border-border rounded-card px-4 py-3">
            <p className="text-xs text-text-muted">Overrides</p>
            <p className="text-card-value text-text-primary">{summary.total}</p>
          </div>
          <div className="bg-card border border-border rounded-card px-4 py-3">
            <p className="text-xs text-text-muted">AI too harsh</p>
            <p className="text-card-value text-text-primary">{summary.ai_too_harsh}</p>
          </div>
          <div className="bg-card border border-border rounded-card px-4 py-3">
            <p className="text-xs text-text-muted">AI too lenient</p>
            <p className="text-card-value text-text-primary">{summary.ai_too_lenient}</p>
          </div>
          {/* The number that decides whether "every override is logged" is a
              defensible claim or merely a true one. Shown as a headline, and
              clickable, so it can be chased rather than admired. */}
          <button
            type="button"
            onClick={() => onFilterChange(setMissingReason)(!missingReason)}
            aria-pressed={missingReason}
            className={`text-left bg-card border rounded-card px-4 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
              missingReason ? 'border-primary' : 'border-border hover:bg-sidebar-hover'
            }`}
          >
            <p className="text-xs text-text-muted">No reason given</p>
            <p className={`text-card-value ${summary.missing_reason > 0 ? 'text-review' : 'text-text-primary'}`}>
              {summary.missing_reason}
            </p>
          </button>
        </div>
      )}

      <div className="flex items-end gap-2 flex-wrap mb-4">
        <div>
          <label htmlFor="direction-filter" className="block text-xs text-text-muted mb-1">Direction</label>
          <select
            id="direction-filter"
            value={direction}
            onChange={(e) => onFilterChange(setDirection)(e.target.value as '' | OverrideDirection)}
            className={`px-3 py-1.5 rounded-btn text-table-cell font-semibold border bg-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
              direction ? 'border-primary text-primary' : 'border-border text-text-secondary hover:bg-sidebar-hover'
            }`}
          >
            <option value="">Any direction</option>
            <option value="ai_too_harsh">AI too harsh</option>
            <option value="ai_too_lenient">AI too lenient</option>
            <option value="ai_undecided">AI could not decide</option>
          </select>
        </div>
        <div>
          <label htmlFor="from-filter" className="block text-xs text-text-muted mb-1">From</label>
          <input
            id="from-filter"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => onFilterChange(setFrom)(e.target.value)}
            className={`px-3 py-1.5 rounded-btn text-table-cell border bg-card text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
              from ? 'border-primary' : 'border-border'
            }`}
          />
        </div>
        <div>
          <label htmlFor="to-filter" className="block text-xs text-text-muted mb-1">to</label>
          <input
            id="to-filter"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => onFilterChange(setTo)(e.target.value)}
            className={`px-3 py-1.5 rounded-btn text-table-cell border bg-card text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
              to ? 'border-primary' : 'border-border'
            }`}
          />
        </div>
        {filtered && (
          <button
            type="button"
            onClick={() => {
              setDirection(''); setMissingReason(false); setFrom(''); setTo(''); setPage(1);
            }}
            className="px-3 py-1.5 rounded-btn text-table-cell font-semibold text-text-muted hover:text-text-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Clear filters
          </button>
        )}
        <div className="ml-auto text-xs text-text-muted pb-1.5" aria-live="polite">
          {isLoading ? 'Loading…' : total === 0 ? 'No overrides' : `${total} override${total === 1 ? '' : 's'}`}
        </div>
      </div>

      <div className="bg-card border border-border rounded-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead className="bg-table-header">
              <tr>
                <th className={TH}>When</th>
                <th className={TH}>Checkpoint</th>
                <th className={TH}>Record</th>
                <th className={TH}>Change</th>
                <th className={TH}>Reviewer</th>
                <th className={TH}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={6} className="px-5 py-8 text-table-cell text-text-subtle">Loading…</td></tr>
              )}
              {isError && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-table-cell text-fail" role="alert">
                    Could not load the override register. Refresh to try again.
                  </td>
                </tr>
              )}
              {!isLoading && !isError && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-table-cell text-text-subtle">
                    {filtered
                      ? 'No overrides match these filters.'
                      : 'Nobody has overturned the AI yet. Overrides appear here as they are made.'}
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border-light">
                  <td className={`${TD} text-text-muted whitespace-nowrap`}>{formatWhen(r.created_at)}</td>
                  <td className={TD}>
                    <span className="text-text-primary">{r.item_label}</span>
                    {r.item_section && (
                      <span className="block text-xs text-text-muted">{r.item_section}</span>
                    )}
                  </td>
                  <td className={TD}>
                    {r.journey_id ? (
                      <Link to={`/journeys/${r.journey_id}`} className="text-primary hover:underline">
                        {r.subject_name || 'Sale'}
                      </Link>
                    ) : r.call_id ? (
                      <Link to={`/calls/${r.call_id}`} className="text-primary hover:underline">
                        {r.subject_name || 'Call'}
                      </Link>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                  <td className={TD}>
                    <span className={`inline-block whitespace-nowrap px-2.5 py-[3px] rounded-full text-badge font-semibold ${DIRECTION_CLASS[r.direction]}`}>
                      {DIRECTION_LABELS[r.direction]}
                    </span>
                  </td>
                  <td className={TD}>{r.user_name ?? <span className="text-text-muted">(user deleted)</span>}</td>
                  <td className={TD}>
                    {r.reason ? (
                      r.reason
                    ) : (
                      // Stated in words, not left blank: a missing reason is a
                      // gap in the audit trail, and an empty cell reads as a
                      // rendering fault rather than as the finding it is.
                      <span className="text-review">No reason given</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 rounded-btn text-table-cell border border-border text-text-secondary disabled:opacity-40 hover:bg-sidebar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Previous
          </button>
          <span className="text-xs text-text-muted">Page {page} of {totalPages}</span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="px-3 py-1.5 rounded-btn text-table-cell border border-border text-text-secondary disabled:opacity-40 hover:bg-sidebar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
