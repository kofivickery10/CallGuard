import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { SeverityBadge, StatusBadge } from '../components/BreachBadges';
import { BreachDetailDrawer } from '../components/BreachDetailDrawer';
import {
  BREACH_SEVERITIES,
  BREACH_STATUSES,
  BREACH_SEVERITY_LABELS,
  BREACH_STATUS_LABELS,
  type BreachSeverity,
  type BreachStatus,
  type BreachWithDetail,
  type BreachSummary,
  type AgentSummary,
} from '@callguard/shared';

interface Filters {
  severity: BreachSeverity | '';
  status: BreachStatus | '';
  agent_id: string;
  from: string;
  to: string;
  search: string;
}

const emptyFilters: Filters = {
  severity: '',
  status: '',
  agent_id: '',
  from: '',
  to: '',
  search: '',
};

export function Breaches() {
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: summary } = useQuery({
    queryKey: ['breach-summary'],
    queryFn: () => api.get<BreachSummary>('/breaches/summary'),
  });

  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ data: AgentSummary[] }>('/agents'),
  });

  const queryParams = new URLSearchParams({ page: String(page), limit: '50' });
  if (filters.severity) queryParams.set('severity', filters.severity);
  if (filters.status) queryParams.set('status', filters.status);
  if (filters.agent_id) queryParams.set('agent_id', filters.agent_id);
  if (filters.from) queryParams.set('from', filters.from);
  if (filters.to) queryParams.set('to', filters.to);
  if (filters.search) queryParams.set('search', filters.search);

  const { data, isLoading } = useQuery({
    queryKey: ['breaches', filters, page],
    queryFn: () =>
      api.get<{ data: BreachWithDetail[]; total: number; page: number; limit: number }>(
        `/breaches?${queryParams.toString()}`
      ),
  });

  const totalPages = data ? Math.ceil(data.total / data.limit) : 0;

  const handleExport = () => {
    const token = localStorage.getItem('callguard_token');
    const url = `/api/breaches/export.csv?${queryParams.toString()}`;
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `callguard-breaches-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
      });
  };

  const handlePrint = () => {
    const token = localStorage.getItem('callguard_token');
    // Open report in new window. Since fetch would need auth, we'll use a temp link with token via the sub-route that accepts tokens
    // Simpler: open the route with auth done via a form-post, but report route uses JWT auth - easiest is to fetch HTML then write to new window
    fetch(`/api/breaches/report?${queryParams.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.text())
      .then((html) => {
        const w = window.open('', '_blank');
        if (w) {
          w.document.write(html);
          w.document.close();
        }
      });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Breach Register</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            Every compliance breach, triaged and tracked
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            className="px-[18px] py-[9px] rounded-btn text-table-cell font-semibold border border-border text-text-cell hover:bg-sidebar-hover transition-colors"
          >
            Export CSV
          </button>
          <button
            onClick={handlePrint}
            className="bg-primary text-white px-[18px] py-[9px] rounded-btn text-table-cell font-semibold hover:bg-primary-hover transition-colors"
          >
            Print Report
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <SummaryCard label="Open Breaches" value={summary?.total_open ?? '-'} color="text-text-primary" />
        <SummaryCard label="Critical" value={summary?.by_severity.critical ?? '-'} color="text-fail" />
        <SummaryCard label="High" value={summary?.by_severity.high ?? '-'} color="text-fail" />
        <SummaryCard label="Resolved (30d)" value={summary?.resolved_last_30_days ?? '-'} color="text-pass" />
      </div>

      {/* Filters */}
      <div className="bg-white border border-border rounded-card p-4 mb-4 grid grid-cols-6 gap-3">
        <select
          value={filters.severity}
          onChange={(e) => { setFilters({ ...filters, severity: e.target.value as BreachSeverity | '' }); setPage(1); }}
          className={filterCls}
        >
          <option value="">All severities</option>
          {BREACH_SEVERITIES.map((s) => (
            <option key={s} value={s}>{BREACH_SEVERITY_LABELS[s]}</option>
          ))}
        </select>
        <select
          value={filters.status}
          onChange={(e) => { setFilters({ ...filters, status: e.target.value as BreachStatus | '' }); setPage(1); }}
          className={filterCls}
        >
          <option value="">All statuses</option>
          {BREACH_STATUSES.map((s) => (
            <option key={s} value={s}>{BREACH_STATUS_LABELS[s]}</option>
          ))}
        </select>
        <select
          value={filters.agent_id}
          onChange={(e) => { setFilters({ ...filters, agent_id: e.target.value }); setPage(1); }}
          className={filterCls}
        >
          <option value="">All agents</option>
          {agents?.data.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <input
          type="date"
          value={filters.from}
          onChange={(e) => { setFilters({ ...filters, from: e.target.value }); setPage(1); }}
          className={filterCls}
          placeholder="From"
        />
        <input
          type="date"
          value={filters.to}
          onChange={(e) => { setFilters({ ...filters, to: e.target.value }); setPage(1); }}
          className={filterCls}
        />
        <input
          type="search"
          value={filters.search}
          onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1); }}
          className={filterCls}
          placeholder="Search..."
        />
      </div>

      {/* Table */}
      <div className="bg-white border border-border rounded-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr>
              {['Date', 'Call', 'Agent', 'Breach Type', 'Severity', 'Score', 'Status', 'Assigned'].map((h) => (
                <th key={h} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={8} className="px-5 py-12 text-center text-text-muted">Loading...</td></tr>
            ) : !data?.data.length ? (
              <tr><td colSpan={8} className="px-5 py-12 text-center text-text-muted">No breaches match these filters</td></tr>
            ) : (
              data.data.map((b) => (
                <tr
                  key={b.id}
                  onClick={() => setSelectedId(b.id)}
                  className="border-b border-border-light last:border-0 hover:bg-table-header cursor-pointer"
                >
                  <td className="px-5 py-3.5 text-table-cell text-text-cell font-mono text-[12px]">
                    {new Date(b.detected_at).toLocaleDateString('en-GB')}
                  </td>
                  <td className="px-5 py-3.5 text-table-cell">
                    <Link
                      to={`/calls/${b.call_id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-primary font-medium hover:underline"
                    >
                      {b.call_file_name}
                    </Link>
                  </td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">{b.agent_name || '--'}</td>
                  <td className="px-5 py-3.5 text-table-cell text-text-primary">{b.breach_type}</td>
                  <td className="px-5 py-3.5"><SeverityBadge severity={b.severity} /></td>
                  <td className="px-5 py-3.5 text-table-cell text-fail font-mono font-semibold">
                    {Math.round(Number(b.normalized_score))}%
                  </td>
                  <td className="px-5 py-3.5"><StatusBadge status={b.status} /></td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">{b.assigned_to_name || <span className="text-text-muted">--</span>}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-border bg-table-header">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40">Previous</button>
            <span className="text-[12px] text-text-muted">{page} / {totalPages} ({data?.total} total)</span>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40">Next</button>
          </div>
        )}
      </div>

      {selectedId && (
        <BreachDetailDrawer
          breachId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

const filterCls = "border border-border rounded-btn px-3 py-[7px] text-table-cell text-text-primary focus:outline-none focus:border-primary transition-colors bg-white";

function SummaryCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="bg-white border border-border rounded-card p-5">
      <div className="text-card-label uppercase text-text-muted">{label}</div>
      <div className={`text-card-value mt-2.5 ${color} font-mono`}>{value}</div>
    </div>
  );
}
