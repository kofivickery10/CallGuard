import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { JourneyStatusBadge } from '../components/JourneyStatusBadge';
import { useScoreOnly } from '../context/AuthContext';
import { formatPhone } from '../lib/format';
import type { JourneyListItem, JourneyStatus } from '@callguard/shared';

const STATUS_FILTERS: Array<{ value: '' | JourneyStatus; label: string }> = [
  { value: '', label: 'All' },
  { value: 'scored', label: 'Scored' },
  { value: 'pending', label: 'Pending' },
  { value: 'scoring', label: 'Scoring' },
  { value: 'failed', label: 'Failed' },
  // NTU sales are deliberately not scored (migration 071). They still belong in
  // the list — a compliance manager needs to see the business exists — but they
  // are not a score anyone should read, so isolating them matters.
  { value: 'skipped', label: 'Not taken up' },
];

export function Journeys() {
  const scoreOnly = useScoreOnly();
  const [status, setStatus] = useState<'' | JourneyStatus>('');
  const [adviser, setAdviser] = useState('');
  const [branch, setBranch] = useState('');
  const [result, setResult] = useState<'' | 'pass' | 'fail'>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  // Any filter change invalidates the current page number — page 3 of an
  // unfiltered list is rarely page 3 of a filtered one, and landing on an empty
  // page reads as "no results" rather than "wrong page".
  const onFilterChange = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  // Distinct closing advisers, for the filter. Cached separately from the list
  // so paging or changing the status filter doesn't refetch it.
  const { data: advisersData } = useQuery({
    queryKey: ['journey-advisers'],
    queryFn: () => api.get<{ data: string[] }>('/journeys/advisers'),
    staleTime: 5 * 60 * 1000,
  });
  const advisers = advisersData?.data ?? [];

  // Branches actually present in the org's sales (not merely configured), so
  // the filter never offers an option that returns nothing.
  const { data: branchesData } = useQuery({
    queryKey: ['journey-branches'],
    queryFn: () => api.get<{ data: string[] }>('/journeys/branches'),
    staleTime: 5 * 60 * 1000,
  });
  const branches = branchesData?.data ?? [];

  const { data, isLoading, isError } = useQuery({
    queryKey: ['journeys', status, adviser, branch, result, from, to, page],
    queryFn: () =>
      api.get<{
        data: JourneyListItem[]; total: number; page: number; limit: number;
        counts: Record<string, number>;
      }>(
        `/journeys?page=${page}&limit=50${status ? `&status=${status}` : ''}` +
          (adviser ? `&agent=${encodeURIComponent(adviser)}` : '') +
          (branch ? `&branch=${encodeURIComponent(branch)}` : '') +
          (result ? `&result=${result}` : '') +
          (from ? `&from=${from}` : '') +
          (to ? `&to=${to}` : '')
      ),
    refetchInterval: (query) => {
      // Poll while anything is still in flight so scores appear without a manual refresh.
      const rows = query.state.data?.data ?? [];
      return rows.some((j) => j.status === 'pending' || j.status === 'scoring') ? 4000 : false;
    },
  });

  const journeys = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = data ? Math.ceil(total / data.limit) : 0;
  const counts = data?.counts ?? {};
  const firstRow = total === 0 ? 0 : (page - 1) * (data?.limit ?? 50) + 1;
  const lastRow = Math.min(page * (data?.limit ?? 50), total);
  const filtered = !!(status || adviser || branch || result || from || to);

  // Score-only tenants don't see the pass/fail verdict, so the Result column is
  // dropped entirely rather than left blank.
  // Two dates, because they answer different questions and used to be conflated:
  // "Sale date" is when it happened (stable, what the list sorts and filters on),
  // "Last scored" is when we last judged it (moves on a re-score).
  const columns = ['Customer', 'Adviser', ...(scoreOnly ? [] : ['Result']), 'Score', 'Branch', 'Calls', 'Status', 'Sale date', 'Last scored', ''];
  const colCount = columns.length;

  return (
    <div>
      <div className="flex items-center justify-between mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Sales</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            Multi-call sales scored as one unit — a statement or consent counts if it happened on any call in the sale.
          </p>
        </div>
        <div className="flex gap-1.5 flex-wrap justify-end">
          {STATUS_FILTERS.map((f) => {
            // Count for this tab under every OTHER active filter, so it says
            // what clicking it would actually return rather than a global total.
            const n = f.value === '' ? counts.all : counts[f.value];
            return (
              <button
                key={f.value}
                onClick={() => onFilterChange(setStatus)(f.value)}
                aria-pressed={status === f.value}
                className={`px-3 py-1.5 rounded-btn text-table-cell font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                  status === f.value
                    ? 'bg-primary text-white'
                    : 'border border-border text-text-secondary hover:bg-sidebar-hover'
                }`}
              >
                {f.label}
                {n !== undefined && (
                  <span className={status === f.value ? 'ml-1.5 opacity-80' : 'ml-1.5 text-text-muted'}>
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Secondary filters. Separate row from the status tabs: status is the
          primary axis a compliance manager works along, and mixing six controls
          into one row buries it. */}
      <div className="flex items-end gap-2 flex-wrap mb-4">
        {advisers.length > 0 && (
          <div>
            <label htmlFor="adviser-filter" className="block text-xs text-text-muted mb-1">Adviser</label>
            <select
              id="adviser-filter"
              value={adviser}
              onChange={(e) => onFilterChange(setAdviser)(e.target.value)}
              className={`px-3 py-1.5 rounded-btn text-table-cell font-semibold border bg-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                adviser ? 'border-primary text-primary' : 'border-border text-text-secondary hover:bg-sidebar-hover'
              }`}
            >
              <option value="">All advisers</option>
              {advisers.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        )}

        {branches.length > 1 && (
          <div>
            <label htmlFor="branch-filter" className="block text-xs text-text-muted mb-1">Branch</label>
            <select
              id="branch-filter"
              value={branch}
              onChange={(e) => onFilterChange(setBranch)(e.target.value)}
              className={`px-3 py-1.5 rounded-btn text-table-cell font-semibold border bg-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                branch ? 'border-primary text-primary' : 'border-border text-text-secondary hover:bg-sidebar-hover'
              }`}
            >
              <option value="">All branches</option>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
        )}

        {!scoreOnly && (
          <div>
            <label htmlFor="result-filter" className="block text-xs text-text-muted mb-1">Result</label>
            <select
              id="result-filter"
              value={result}
              onChange={(e) => onFilterChange(setResult)(e.target.value as '' | 'pass' | 'fail')}
              className={`px-3 py-1.5 rounded-btn text-table-cell font-semibold border bg-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                result ? 'border-primary text-primary' : 'border-border text-text-secondary hover:bg-sidebar-hover'
              }`}
            >
              <option value="">Pass or fail</option>
              <option value="pass">Pass</option>
              <option value="fail">Fail</option>
            </select>
          </div>
        )}

        <div>
          <label htmlFor="from-filter" className="block text-xs text-text-muted mb-1">Scored from</label>
          <input
            id="from-filter"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => onFilterChange(setFrom)(e.target.value)}
            className={`px-3 py-1.5 rounded-btn text-table-cell border bg-card text-text-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
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
            className={`px-3 py-1.5 rounded-btn text-table-cell border bg-card text-text-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
              to ? 'border-primary' : 'border-border'
            }`}
          />
        </div>

        {filtered && (
          <button
            type="button"
            onClick={() => {
              setStatus(''); setAdviser(''); setBranch(''); setResult(''); setFrom(''); setTo(''); setPage(1);
            }}
            className="px-3 py-1.5 rounded-btn text-table-cell font-semibold text-text-muted hover:text-text-primary underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Clear filters
          </button>
        )}

        {/* Where you are in the result set. Always shown, not just when it
            paginates — "12 sales" is worth knowing on its own, and its absence
            below 50 rows made the list feel like it might be truncated. */}
        <div className="ml-auto text-xs text-text-muted pb-1.5" aria-live="polite">
          {isLoading
            ? 'Loading…'
            : total === 0
              ? 'No sales'
              : totalPages > 1
                ? `${firstRow}–${lastRow} of ${total} sales`
                : `${total} sale${total === 1 ? '' : 's'}`}
        </div>
      </div>

      <div className="bg-card border border-border rounded-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr>
                {columns.map((h) => (
                  <th key={h} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">
                    {h || <span className="sr-only">Actions</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`skeleton-${i}`} className="border-b border-border-light last:border-0">
                    {Array.from({ length: colCount }).map((__, j) => (
                      <td key={j} className="px-5 py-3.5">
                        <div
                          className="h-4 rounded bg-[length:800px_100%] animate-skeleton-shimmer"
                          style={{
                            backgroundImage:
                              'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
                            width: j === 0 ? '70%' : '40%',
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                ))}

              {isError && (
                <tr>
                  <td colSpan={colCount} className="px-5 py-6 text-center">
                    <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn inline-block">
                      Could not load sales — try refreshing.
                    </div>
                  </td>
                </tr>
              )}

              {!isLoading && !isError && journeys.length === 0 && (
                <tr>
                  <td colSpan={colCount} className="px-5 py-12 text-center text-text-muted text-table-cell">
                    No scored sales yet. A sale is scored when it closes in your CRM, or via
                    “Score sale” on a customer.
                  </td>
                </tr>
              )}

              {journeys.map((j) => {
                const failed = j.pass === false && !scoreOnly;
                return (
                <tr
                  key={j.id}
                  className={`hover:bg-table-header transition-colors border-b border-border-light last:border-0 border-l-[3px] ${
                    failed ? 'border-l-fail bg-fail-bg/30' : 'border-l-transparent'
                  }`}
                >
                  <td className="px-5 py-3.5 text-table-cell">
                    <Link to={`/customers/${j.customer_id}`} className="text-primary font-semibold hover:underline">
                      {j.customer_name || 'Unknown customer'}
                    </Link>
                    <div className="text-xs text-text-muted">{formatPhone(j.customer_phone) || '—'}</div>
                  </td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">
                    {j.agent_name ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="truncate max-w-[10rem]">{j.agent_name}</span>
                        {j.agent_count > 1 && (
                          <span
                            className="px-1.5 py-[1px] rounded-full text-badge font-semibold bg-table-header text-text-muted shrink-0"
                            title={`This sale was handled by ${j.agent_count} advisers. Shown is the one who closed it — the same attribution used for breaches and CRM write-back.`}
                          >
                            +{j.agent_count - 1}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                  {!scoreOnly && (
                    <td className="px-5 py-3.5">
                      {j.pass == null ? (
                        <span className="text-text-muted text-table-cell">—</span>
                      ) : (
                        <span
                          className={`inline-block px-2.5 py-[3px] rounded-full text-badge font-semibold ${
                            j.pass ? 'bg-pass-bg text-pass' : 'bg-fail-bg text-fail'
                          }`}
                        >
                          {j.pass ? 'Pass' : 'Fail'}
                        </span>
                      )}
                    </td>
                  )}
                  <td className={`px-5 py-3.5 text-table-cell font-semibold tabular-nums ${failed ? 'text-fail' : 'text-text-cell'}`}>
                    {j.overall_score != null ? `${Number(j.overall_score).toFixed(1)}%` : '—'}
                  </td>
                  <td className="px-5 py-3.5 text-table-cell text-text-secondary">{j.branch || '—'}</td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell tabular-nums">{j.call_count}</td>
                  <td className="px-5 py-3.5"><JourneyStatusBadge status={j.status} /></td>
                  {/* When it happened. The primary date: stable across a
                      re-score, and what the list is ordered and filtered by. */}
                  <td className="px-5 py-3.5 text-table-cell text-text-cell whitespace-nowrap">
                    {j.sale_date ? new Date(j.sale_date).toLocaleDateString('en-GB') : '—'}
                  </td>
                  {/* When we last judged it. Muted, because it is provenance
                      rather than the sale's own date. A re-score is called out:
                      the score on screen replaced an earlier one, which matters
                      if that earlier one was already fed back to the adviser. */}
                  <td className="px-5 py-3.5 text-table-cell text-text-muted whitespace-nowrap">
                    {j.scored_at ? new Date(j.scored_at).toLocaleDateString('en-GB') : '—'}
                    {j.score_runs > 1 && (
                      <span
                        className="ml-1.5 px-1.5 py-[1px] rounded-full text-badge font-semibold bg-table-header text-text-secondary"
                        title={`Scored ${j.score_runs} times — the current score replaced an earlier one`}
                      >
                        ×{j.score_runs}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <Link to={`/journeys/${j.id}`} className="text-primary text-table-cell font-semibold hover:underline">
                      View
                    </Link>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-border bg-table-header">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Previous
            </button>
            <span className="text-xs text-text-muted">
              Page {page} of {totalPages}
              <span className="mx-2 text-border">|</span>
              showing {firstRow}–{lastRow} of {total}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
