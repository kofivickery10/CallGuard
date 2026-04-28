import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { CallStatusBadge } from '../components/CallStatusBadge';
import { ScoreGauge } from '../components/ScoreGauge';
import { AgentFilter } from '../components/AgentFilter';
import type { Call, PaginatedResponse } from '@callguard/shared';

export function Calls() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [page, setPage] = useState(1);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);

  const queryParams = new URLSearchParams({ page: String(page), limit: '20' });
  if (agentFilter) queryParams.set('agent_id', agentFilter);

  const { data, isLoading } = useQuery({
    queryKey: ['calls', page, agentFilter],
    queryFn: () =>
      api.get<PaginatedResponse<Call & { resolved_agent_name: string | null; overall_score?: number; pass?: boolean }>>(
        `/calls?${queryParams.toString()}`
      ),
  });

  const totalPages = data ? Math.ceil(data.total / data.limit) : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Calls</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            {data ? `${data.total} total calls` : 'Loading...'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isAdmin && <AgentFilter value={agentFilter} onChange={(v) => { setAgentFilter(v); setPage(1); }} />}
          <Link
            to="/calls/upload"
            className="inline-flex items-center gap-2 bg-primary text-white px-[18px] py-[9px] rounded-btn text-table-cell font-semibold hover:bg-primary-hover transition-colors"
          >
            Upload Call
          </Link>
        </div>
      </div>

      <div className="bg-white border border-border rounded-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr>
              {['Call', 'Agent', 'Duration', 'Score', 'Status', 'Date'].map((h) => (
                <th key={h} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={6} className="px-5 py-12 text-center text-text-muted">Loading...</td></tr>
            ) : (
              data?.data.map((call) => (
                <tr key={call.id} className="hover:bg-table-header transition-colors cursor-pointer border-b border-border-light last:border-0">
                  <td className="px-5 py-3.5">
                    <Link to={`/calls/${call.id}`} className="text-primary font-semibold text-table-cell hover:underline">
                      {call.file_name}
                    </Link>
                  </td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">
                    {('resolved_agent_name' in call ? (call as { resolved_agent_name: string }).resolved_agent_name : null) || call.agent_name || '--'}
                  </td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">
                    {call.duration_seconds
                      ? `${Math.floor(call.duration_seconds / 60)}:${String(Math.floor(call.duration_seconds % 60)).padStart(2, '0')}`
                      : '--'}
                  </td>
                  <td className="px-5 py-3.5">
                    {call.overall_score != null ? <ScoreGauge score={call.overall_score} showBar /> : <span className="text-text-muted">--</span>}
                  </td>
                  <td className="px-5 py-3.5">
                    <CallStatusBadge status={call.status} pass={call.pass} />
                  </td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">
                    {new Date(call.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-border bg-table-header">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors">
              Previous
            </button>
            <span className="text-[12px] text-text-muted">{page} / {totalPages}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors">
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
