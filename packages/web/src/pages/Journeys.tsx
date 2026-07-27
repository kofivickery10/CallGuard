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
  const [page, setPage] = useState(1);

  // Distinct closing advisers, for the filter. Cached separately from the list
  // so paging or changing the status filter doesn't refetch it.
  const { data: advisersData } = useQuery({
    queryKey: ['journey-advisers'],
    queryFn: () => api.get<{ data: string[] }>('/journeys/advisers'),
    staleTime: 5 * 60 * 1000,
  });
  const advisers = advisersData?.data ?? [];

  const { data, isLoading, isError } = useQuery({
    queryKey: ['journeys', status, adviser, page],
    queryFn: () =>
      api.get<{ data: JourneyListItem[]; total: number; page: number; limit: number }>(
        `/journeys?page=${page}&limit=50${status ? `&status=${status}` : ''}` +
          (adviser ? `&agent=${encodeURIComponent(adviser)}` : '')
      ),
    refetchInterval: (query) => {
      // Poll while anything is still in flight so scores appear without a manual refresh.
      const rows = query.state.data?.data ?? [];
      return rows.some((j) => j.status === 'pending' || j.status === 'scoring') ? 4000 : false;
    },
  });

  const journeys = data?.data ?? [];
  const totalPages = data ? Math.ceil(data.total / data.limit) : 0;

  // Score-only tenants don't see the pass/fail verdict, so the Result column is
  // dropped entirely rather than left blank.
  const columns = ['Customer', 'Adviser', ...(scoreOnly ? [] : ['Result']), 'Score', 'Branch', 'Calls', 'Status', 'Scored', ''];
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
        <div className="flex gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => {
                setStatus(f.value);
                setPage(1);
              }}
              aria-pressed={status === f.value}
              className={`px-3 py-1.5 rounded-btn text-table-cell font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                status === f.value
                  ? 'bg-primary text-white'
                  : 'border border-border text-text-secondary hover:bg-sidebar-hover'
              }`}
            >
              {f.label}
            </button>
          ))}

          {advisers.length > 0 && (
            <>
              <label htmlFor="adviser-filter" className="sr-only">
                Filter by adviser
              </label>
              <select
                id="adviser-filter"
                value={adviser}
                onChange={(e) => {
                  setAdviser(e.target.value);
                  setPage(1);
                }}
                className={`px-3 py-1.5 rounded-btn text-table-cell font-semibold border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                  adviser
                    ? 'border-primary text-primary bg-card'
                    : 'border-border text-text-secondary bg-card hover:bg-sidebar-hover'
                }`}
              >
                <option value="">All advisers</option>
                {advisers.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </>
          )}
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
                  <td className="px-5 py-3.5 text-table-cell text-text-muted whitespace-nowrap">
                    {j.scored_at ? new Date(j.scored_at).toLocaleDateString('en-GB') : '—'}
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
            <span className="text-xs text-text-muted">{page} / {totalPages}</span>
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
