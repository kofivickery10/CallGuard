import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { JourneyStatusBadge } from '../components/JourneyStatusBadge';
import { formatPhone } from '../lib/format';
import type { JourneyListItem, JourneyStatus } from '@callguard/shared';

const STATUS_FILTERS: Array<{ value: '' | JourneyStatus; label: string }> = [
  { value: '', label: 'All' },
  { value: 'scored', label: 'Scored' },
  { value: 'pending', label: 'Pending' },
  { value: 'scoring', label: 'Scoring' },
  { value: 'failed', label: 'Failed' },
];

export function Journeys() {
  const [status, setStatus] = useState<'' | JourneyStatus>('');
  const [page, setPage] = useState(1);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['journeys', status, page],
    queryFn: () =>
      api.get<{ data: JourneyListItem[]; total: number; page: number; limit: number }>(
        `/journeys?page=${page}&limit=50${status ? `&status=${status}` : ''}`
      ),
    refetchInterval: (query) => {
      // Poll while anything is still in flight so scores appear without a manual refresh.
      const rows = query.state.data?.data ?? [];
      return rows.some((j) => j.status === 'pending' || j.status === 'scoring') ? 4000 : false;
    },
  });

  const journeys = data?.data ?? [];
  const totalPages = data ? Math.ceil(data.total / data.limit) : 0;

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
        </div>
      </div>

      <div className="bg-card border border-border rounded-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr>
                {['Customer', 'Result', 'Score', 'Branch', 'Calls', 'Status', 'Scored', ''].map((h) => (
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
                    {Array.from({ length: 8 }).map((__, j) => (
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
                  <td colSpan={8} className="px-5 py-6 text-center">
                    <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn inline-block">
                      Could not load sales — try refreshing.
                    </div>
                  </td>
                </tr>
              )}

              {!isLoading && !isError && journeys.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-text-muted text-table-cell">
                    No scored sales yet. A sale is scored when it closes in your CRM, or via
                    “Score sale” on a customer.
                  </td>
                </tr>
              )}

              {journeys.map((j) => {
                const failed = j.pass === false;
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
