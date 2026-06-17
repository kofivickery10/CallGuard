import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

interface AuditEntry {
  id: string;
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  action_type: string;
  entity_type: string;
  entity_id: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  created_at: string;
}

const ACTION_TYPES = [
  'auth.login',
  'call.delete',
  'call.bulk_import',
  'score.correct',
  'exemplar.toggle',
  'breach.status_change',
  'breach.assign',
  'breach.note_add',
  'api_key.create',
  'api_key.revoke',
];

export function AuditLog() {
  const [actionFilter, setActionFilter] = useState('');
  const [page, setPage] = useState(0);
  const limit = 100;

  const params = new URLSearchParams({ limit: String(limit), offset: String(page * limit) });
  if (actionFilter) params.set('action_type', actionFilter);

  const { data, isLoading } = useQuery({
    queryKey: ['audit-log', actionFilter, page],
    queryFn: () =>
      api.get<{ data: AuditEntry[]; total: number; limit: number; offset: number }>(
        `/audit-log?${params.toString()}`
      ),
  });

  const handleExport = () => {
    const token = localStorage.getItem('callguard_token');
    fetch('/api/audit-log/export.csv', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `callguard-audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
      });
  };

  const totalPages = data ? Math.ceil(data.total / data.limit) : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Audit Log</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            Every admin and compliance action recorded for procurement review and FCA evidence trails.
          </p>
        </div>
        <button
          onClick={handleExport}
          className="inline-flex items-center gap-2 bg-card border border-border text-text-primary px-[18px] py-[9px] rounded-btn text-table-cell font-semibold hover:border-primary hover:text-primary transition-colors"
        >
          Export CSV
        </button>
      </div>

      <div className="flex items-center gap-3 mb-5">
        <select
          value={actionFilter}
          onChange={(e) => { setActionFilter(e.target.value); setPage(0); }}
          className="bg-card border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary"
        >
          <option value="">All actions</option>
          {ACTION_TYPES.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        {data && (
          <span className="text-table-cell text-text-muted">
            {data.total.toLocaleString()} entries
          </span>
        )}
      </div>

      <div className="bg-card border border-border rounded-card overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">When</th>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Who</th>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Action</th>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Detail</th>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">IP</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={`s-${i}`} className="border-b border-border-light last:border-0">
                  {Array.from({ length: 5 }).map((__, j) => (
                    <td key={j} className="px-5 py-3">
                      <div
                        className="h-3.5 rounded bg-[length:800px_100%] animate-skeleton-shimmer"
                        style={{
                          backgroundImage: 'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
                          width: j === 3 ? '70%' : '50%',
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))
            )}

            {!isLoading && data?.data.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-12 text-center text-text-muted text-table-cell">
                  No audit entries match this filter yet.
                </td>
              </tr>
            )}

            {data?.data.map((e) => (
              <tr key={e.id} className="hover:bg-table-header transition-colors border-b border-border-light last:border-0">
                <td className="px-5 py-3 text-[12px] text-text-muted whitespace-nowrap font-mono">
                  {new Date(e.created_at).toLocaleString()}
                </td>
                <td className="px-5 py-3 text-table-cell text-text-cell">
                  {e.user_email || <span className="text-text-muted italic">system</span>}
                </td>
                <td className="px-5 py-3">
                  <span className="inline-block px-2 py-[2px] rounded bg-primary-light text-pass text-[11px] font-semibold tracking-wide">
                    {e.action_type}
                  </span>
                </td>
                <td className="px-5 py-3 text-table-cell text-text-cell">
                  {e.summary || <span className="text-text-muted">{e.entity_type}{e.entity_id ? ` #${e.entity_id}` : ''}</span>}
                </td>
                <td className="px-5 py-3 text-[12px] text-text-muted font-mono whitespace-nowrap">
                  {e.ip_address || '--'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-border bg-table-header">
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors">
              Previous
            </button>
            <span className="text-[12px] text-text-muted">{page + 1} / {totalPages}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors">
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
