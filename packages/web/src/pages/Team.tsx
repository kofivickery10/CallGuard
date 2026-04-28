import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { InviteAgentModal } from '../components/InviteAgentModal';
import { ScoreGauge } from '../components/ScoreGauge';
import type { AgentSummary } from '@callguard/shared';

export function Team() {
  const [inviteOpen, setInviteOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ data: AgentSummary[] }>('/agents'),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Team</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            Manage your agents and view performance
          </p>
        </div>
        <button
          onClick={() => setInviteOpen(true)}
          className="bg-primary text-white px-[18px] py-[9px] rounded-btn text-table-cell font-semibold hover:bg-primary-hover transition-colors"
        >
          Invite Agent
        </button>
      </div>

      {isLoading ? (
        <div className="text-text-muted text-table-cell">Loading...</div>
      ) : !data?.data.length ? (
        <div className="bg-white border-2 border-dashed border-border rounded-card p-12 text-center">
          <div className="text-text-secondary font-semibold mb-1">No agents yet</div>
          <p className="text-table-cell text-text-muted mb-4">
            Invite agents so they can log in and see their call scores
          </p>
          <button
            onClick={() => setInviteOpen(true)}
            className="text-primary font-semibold text-table-cell hover:underline"
          >
            Invite your first agent
          </button>
        </div>
      ) : (
        <div className="bg-white border border-border rounded-card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr>
                {['Agent', 'Calls', 'Scored', 'Avg Score', 'Pass Rate'].map((h) => (
                  <th key={h} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.data.map((agent) => (
                <tr key={agent.id} className="hover:bg-table-header transition-colors border-b border-border-light last:border-0">
                  <td className="px-5 py-3.5">
                    <div className="text-table-cell font-medium text-text-primary">{agent.name}</div>
                    <div className="text-[12px] text-text-muted">{agent.email}</div>
                  </td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">{agent.total_calls}</td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">{agent.scored_calls}</td>
                  <td className="px-5 py-3.5">
                    {agent.average_score != null ? (
                      <ScoreGauge score={agent.average_score} showBar />
                    ) : <span className="text-text-muted">--</span>}
                  </td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">
                    {agent.pass_rate != null ? `${Math.round(agent.pass_rate)}%` : '--'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <InviteAgentModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </div>
  );
}
