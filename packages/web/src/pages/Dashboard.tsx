import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { CallStatusBadge } from '../components/CallStatusBadge';
import { ScoreGauge } from '../components/ScoreGauge';
import { AgentFilter } from '../components/AgentFilter';
import { TrendCharts } from '../components/TrendCharts';
import type { DashboardSummary, Call, AgentSummary, BreachSummary } from '@callguard/shared';

const statIcons = [
  'M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3',
  'M9 11l3 3L22 4',
  'M22 12l-4 0-3 9-6-18-3 9-4 0',
  'M12 2a10 10 0 100 20 10 10 0 000-20zM9 12l2 2 4-4',
];

export function Dashboard() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [agentFilter, setAgentFilter] = useState<string | null>(null);

  const queryParams = agentFilter ? `?agent_id=${agentFilter}` : '';

  const { data: summary } = useQuery({
    queryKey: ['dashboard', 'summary', agentFilter],
    queryFn: () => api.get<DashboardSummary>(`/dashboard/summary${queryParams}`),
  });

  const { data: recent } = useQuery({
    queryKey: ['dashboard', 'recent', agentFilter],
    queryFn: () =>
      api.get<{
        data: (Call & { overall_score: number | null; pass: boolean | null; resolved_agent_name: string | null })[];
      }>(`/dashboard/recent${queryParams}`),
  });

  const { data: leaderboard } = useQuery({
    queryKey: ['dashboard', 'leaderboard'],
    queryFn: () => api.get<{ data: AgentSummary[] }>('/dashboard/agent-leaderboard'),
    enabled: isAdmin,
  });

  const { data: breachSummary } = useQuery({
    queryKey: ['breach-summary'],
    queryFn: () => api.get<BreachSummary>('/breaches/summary'),
    enabled: isAdmin,
  });

  const baseStats = [
    { label: 'Total Calls', value: summary?.total_calls ?? '-', change: '' },
    { label: 'Scored', value: summary?.scored_calls ?? '-', change: '' },
    {
      label: 'Avg Score',
      value: summary?.average_score != null ? `${Math.round(summary.average_score)}%` : '-',
      change: '',
    },
    {
      label: 'Pass Rate',
      value: summary?.pass_rate != null ? `${Math.round(summary.pass_rate)}%` : '-',
      change: '',
    },
  ];

  const adminExtra = breachSummary ? [
    {
      label: 'Open Breaches',
      value: breachSummary.total_open,
      change: breachSummary.total_open > 0 ? 'Needs attention' : 'All clear',
      isWarning: breachSummary.total_open > 0,
    },
    {
      label: 'Critical',
      value: breachSummary.by_severity.critical ?? 0,
      change: (breachSummary.by_severity.critical || 0) > 0 ? 'Review required' : 'All clear',
      isCritical: (breachSummary.by_severity.critical || 0) > 0,
    },
  ] : [];

  const stats = isAdmin ? [...baseStats, ...adminExtra] : baseStats;

  return (
    <div>
      <div className="flex items-center justify-between mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Dashboard</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            {isAdmin ? 'Overview of your call quality performance' : 'Your performance'}
          </p>
        </div>
        {isAdmin && <AgentFilter value={agentFilter} onChange={setAgentFilter} />}
      </div>

      {/* Stats row */}
      <div className={`grid gap-4 mb-7 ${isAdmin ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-6' : 'grid-cols-4'}`}>
        {stats.map((stat, i) => {
          const isExtra = i >= 4;
          const extraStat = stat as typeof stat & { isWarning?: boolean; isCritical?: boolean };
          const valueColor = extraStat.isCritical
            ? 'text-fail'
            : extraStat.isWarning
              ? 'text-review'
              : 'text-text-primary';
          const changeColor = extraStat.isCritical
            ? 'text-fail'
            : extraStat.isWarning
              ? 'text-review'
              : 'text-primary';
          return (
            <div key={stat.label} className="bg-white border border-border rounded-card p-5">
              <div className="flex justify-between items-center">
                <span className="text-card-label uppercase text-text-muted">{stat.label}</span>
                {!isExtra && (
                  <svg viewBox="0 0 24 24" className="w-[18px] h-[18px] stroke-icon-muted" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d={statIcons[i]} />
                  </svg>
                )}
              </div>
              <div className={`text-card-value mt-2.5 ${valueColor}`}>{stat.value}</div>
              {stat.change && <div className={`text-[12px] mt-1 ${changeColor}`}>{stat.change}</div>}
            </div>
          );
        })}
      </div>

      {/* Trend charts (admin only) */}
      {isAdmin && <TrendCharts agentFilter={agentFilter} />}

      {/* Agent leaderboard (admin only) */}
      {isAdmin && leaderboard?.data && leaderboard.data.length > 0 && !agentFilter && (
        <div className="bg-white border border-border rounded-card overflow-hidden mb-5">
          <div className="px-5 py-4 border-b border-border flex justify-between items-center">
            <h3 className="text-[15px] font-semibold text-text-primary">Agent Leaderboard</h3>
            <Link to="/team" className="text-table-cell text-primary font-medium hover:underline">View team</Link>
          </div>
          <table className="w-full">
            <thead>
              <tr>
                <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Agent</th>
                <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Calls</th>
                <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Score</th>
                <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Pass Rate</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.data.map((agent) => (
                <tr key={agent.id} className="hover:bg-table-header transition-colors">
                  <td className="px-5 py-3 text-table-cell text-text-cell font-medium">{agent.name}</td>
                  <td className="px-5 py-3 text-table-cell text-text-cell">{agent.scored_calls}</td>
                  <td className="px-5 py-3">
                    {agent.average_score != null ? (
                      <ScoreGauge score={agent.average_score} showBar />
                    ) : <span className="text-text-muted">--</span>}
                  </td>
                  <td className="px-5 py-3 text-table-cell text-text-cell">
                    {agent.pass_rate != null ? `${Math.round(agent.pass_rate)}%` : '--'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent calls */}
      <div className="bg-white border border-border rounded-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex justify-between items-center">
          <h3 className="text-[15px] font-semibold text-text-primary">Recent Calls</h3>
          <Link to="/calls" className="text-table-cell text-primary font-medium hover:underline">View all</Link>
        </div>
        <table className="w-full">
          <thead>
            <tr>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Call</th>
              {isAdmin && <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Agent</th>}
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Duration</th>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Score</th>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Status</th>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Date</th>
            </tr>
          </thead>
          <tbody>
            {recent?.data.map((call) => (
              <tr key={call.id} className="hover:bg-table-header transition-colors cursor-pointer border-b border-border-light last:border-0">
                <td className="px-5 py-3.5">
                  <Link to={`/calls/${call.id}`} className="text-primary font-semibold text-table-cell hover:underline">
                    {call.file_name}
                  </Link>
                </td>
                {isAdmin && (
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">
                    {('resolved_agent_name' in call ? (call as { resolved_agent_name: string }).resolved_agent_name : null) || call.agent_name || '--'}
                  </td>
                )}
                <td className="px-5 py-3.5 text-table-cell text-text-cell">
                  {call.duration_seconds
                    ? `${Math.floor(call.duration_seconds / 60)}:${String(Math.floor(call.duration_seconds % 60)).padStart(2, '0')}`
                    : '--'}
                </td>
                <td className="px-5 py-3.5">
                  {call.overall_score != null ? (
                    <ScoreGauge score={call.overall_score} showBar />
                  ) : <span className="text-text-muted text-table-cell">--</span>}
                </td>
                <td className="px-5 py-3.5">
                  <CallStatusBadge status={call.status} pass={call.pass} />
                </td>
                <td className="px-5 py-3.5 text-table-cell text-text-cell">
                  {new Date(call.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {(!recent?.data || recent.data.length === 0) && (
              <tr>
                <td colSpan={isAdmin ? 6 : 5} className="px-5 py-12 text-center text-text-muted text-table-cell">
                  No calls yet.{' '}
                  <Link to="/calls/upload" className="text-primary hover:underline">Upload your first call</Link>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
