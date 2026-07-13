import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { JourneyListItem, JourneyStatus } from '@callguard/shared';

const STATUS_FILTERS: Array<{ value: '' | JourneyStatus; label: string }> = [
  { value: '', label: 'All' },
  { value: 'scored', label: 'Scored' },
  { value: 'pending', label: 'Pending' },
  { value: 'scoring', label: 'Scoring' },
  { value: 'failed', label: 'Failed' },
];

function StatusPill({ status }: { status: JourneyStatus }) {
  const map: Record<JourneyStatus, string> = {
    scored: 'bg-pass-bg text-pass',
    pending: 'bg-table-header text-text-muted',
    scoring: 'bg-processing-bg text-processing',
    failed: 'bg-fail-bg text-fail',
  };
  return (
    <span className={`px-2 py-[2px] rounded-[20px] text-badge font-semibold ${map[status]}`}>
      {status}
    </span>
  );
}

export function Journeys() {
  const [status, setStatus] = useState<'' | JourneyStatus>('');

  const { data, isLoading } = useQuery({
    queryKey: ['journeys', status],
    queryFn: () =>
      api.get<{ data: JourneyListItem[]; total: number }>(
        `/journeys?limit=100${status ? `&status=${status}` : ''}`
      ),
    refetchInterval: (query) => {
      // Poll while anything is still in flight so scores appear without a manual refresh.
      const rows = query.state.data?.data ?? [];
      return rows.some((j) => j.status === 'pending' || j.status === 'scoring') ? 4000 : false;
    },
  });

  const journeys = data?.data ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Journeys</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            Multi-call sales scored as one unit — a statement or consent counts if it happened on any call in the sale.
          </p>
        </div>
        <div className="flex gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setStatus(f.value)}
              className={`px-3 py-1.5 rounded-btn text-table-cell font-semibold transition-colors ${
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

      <div className="bg-card border border-border rounded-card overflow-x-auto">
        <table className="w-full min-w-[720px]">
          <thead>
            <tr>
              {['Customer', 'Calls', 'Branch', 'Score', 'Result', 'Status', 'Scored', ''].map((h) => (
                <th key={h} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-border-light last:border-0">
                  {Array.from({ length: 8 }).map((__, j) => (
                    <td key={j} className="px-5 py-3.5">
                      <div className="h-4 rounded bg-border-light animate-pulse" style={{ width: j === 0 ? '70%' : '40%' }} />
                    </td>
                  ))}
                </tr>
              ))
            )}

            {!isLoading && journeys.length === 0 && (
              <tr>
                <td colSpan={8} className="px-5 py-12 text-center text-text-muted text-table-cell">
                  No journeys yet. Journeys are assembled when a sale closes (Zoho trigger) or via
                  “Score journey” on a customer.
                </td>
              </tr>
            )}

            {journeys.map((j) => (
              <tr key={j.id} className="hover:bg-table-header transition-colors border-b border-border-light last:border-0">
                <td className="px-5 py-3.5 text-table-cell">
                  <div className="font-semibold text-text-primary">{j.customer_name || 'Unknown customer'}</div>
                  <div className="text-[12px] text-text-muted">{j.customer_phone || '—'}</div>
                </td>
                <td className="px-5 py-3.5 text-table-cell text-text-cell tabular-nums">{j.call_count}</td>
                <td className="px-5 py-3.5 text-table-cell text-text-secondary">{j.branch || '—'}</td>
                <td className="px-5 py-3.5 text-table-cell font-medium tabular-nums">
                  {j.overall_score != null ? `${Number(j.overall_score).toFixed(1)}%` : '—'}
                </td>
                <td className="px-5 py-3.5 text-table-cell">
                  {j.pass == null ? (
                    <span className="text-text-muted">—</span>
                  ) : (
                    <span className={j.pass ? 'text-pass font-semibold' : 'text-fail font-semibold'}>
                      {j.pass ? 'Pass' : 'Fail'}
                    </span>
                  )}
                </td>
                <td className="px-5 py-3.5"><StatusPill status={j.status} /></td>
                <td className="px-5 py-3.5 text-table-cell text-text-muted">
                  {j.scored_at ? new Date(j.scored_at).toLocaleDateString('en-GB') : '—'}
                </td>
                <td className="px-5 py-3.5 text-right">
                  <Link to={`/journeys/${j.id}`} className="text-primary text-table-cell font-semibold hover:underline">
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > journeys.length && (
        <p className="text-[12px] text-text-muted mt-3">
          Showing {journeys.length} of {data.total}. Refine with the status filter.
        </p>
      )}
    </div>
  );
}
