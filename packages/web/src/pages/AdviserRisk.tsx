import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { RiskLevelBadge } from '../components/RiskLevelBadge';
import {
  RISK_LEVELS,
  RISK_LEVEL_LABELS,
  type AdviserRisk,
  type RiskLevel,
} from '@callguard/shared';

type Window = '7' | '30' | '90' | '0';

const WINDOW_LABELS: Record<Window, string> = {
  '7': '7 days',
  '30': '30 days',
  '90': '90 days',
  '0': 'All time',
};

export function AdviserRiskPage() {
  const navigate = useNavigate();
  const [window, setWindow] = useState<Window>('30');

  const { data, isLoading } = useQuery({
    queryKey: ['adviser-risk', window],
    queryFn: () => api.get<{ data: AdviserRisk[] }>(`/dashboard/adviser-risk?days=${window}`),
  });

  // Counts per risk level for the summary bar
  const counts = data?.data.reduce<Record<RiskLevel, number>>(
    (acc, row) => {
      acc[row.risk_level] = (acc[row.risk_level] || 0) + 1;
      return acc;
    },
    { high_risk: 0, elevated: 0, monitor: 0, low_risk: 0, compliant: 0 }
  );

  const handleRowClick = (agentId: string) => {
    const fromDate = window === '0'
      ? ''
      : new Date(Date.now() - parseInt(window) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const params = new URLSearchParams({ agent_id: agentId });
    if (fromDate) params.set('from', fromDate);
    navigate(`/breaches?${params.toString()}`);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Adviser Risk Profile</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            Compliance risk per adviser, with recommended coaching actions
          </p>
        </div>
        <div className="flex gap-1 bg-white border border-border rounded-btn p-1">
          {(['7', '30', '90', '0'] as Window[]).map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`px-3 py-1.5 rounded-btn text-[12px] font-semibold transition-colors ${
                window === w
                  ? 'bg-primary-light text-pass'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {WINDOW_LABELS[w]}
            </button>
          ))}
        </div>
      </div>

      {/* Summary bar */}
      {counts && (
        <div className="grid grid-cols-5 gap-3 mb-6">
          {RISK_LEVELS.map((level) => (
            <div key={level} className="bg-white border border-border rounded-card p-4">
              <div className="text-[11px] uppercase tracking-wider text-text-muted font-semibold">
                {RISK_LEVEL_LABELS[level]}
              </div>
              <div className={`text-[24px] font-bold mt-1 font-mono ${riskTextColor(level)}`}>
                {counts[level]}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-border rounded-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr>
              {['Agent', 'Calls', 'Critical', 'High', 'Medium', 'Risk Level', 'Recommended Action'].map((h) => (
                <th key={h} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="px-5 py-12 text-center text-text-muted">Loading...</td></tr>
            ) : !data?.data.length ? (
              <tr><td colSpan={7} className="px-5 py-12 text-center text-text-muted">No agents in this organization yet</td></tr>
            ) : (
              data.data.map((row) => (
                <tr
                  key={row.agent_id}
                  onClick={() => handleRowClick(row.agent_id)}
                  className="border-b border-border-light last:border-0 hover:bg-table-header cursor-pointer"
                >
                  <td className="px-5 py-3.5">
                    <div className="text-table-cell font-medium text-text-primary">{row.agent_name}</div>
                    <div className="text-[11px] text-text-muted">{row.email}</div>
                  </td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell font-mono">{row.total_calls}</td>
                  <td className="px-5 py-3.5 font-mono text-table-cell">
                    {row.critical > 0 ? (
                      <span className="text-fail font-bold">{row.critical}</span>
                    ) : (
                      <span className="text-text-muted">0</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 font-mono text-table-cell">
                    {row.high > 0 ? (
                      <span className="text-fail font-semibold">{row.high}</span>
                    ) : (
                      <span className="text-text-muted">0</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 font-mono text-table-cell">
                    {row.medium > 0 ? (
                      <span className="text-review font-semibold">{row.medium}</span>
                    ) : (
                      <span className="text-text-muted">0</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5"><RiskLevelBadge level={row.risk_level} /></td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">{row.recommended_action}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function riskTextColor(level: RiskLevel): string {
  switch (level) {
    case 'high_risk':
      return 'text-fail';
    case 'elevated':
      return 'text-review';
    case 'monitor':
      return 'text-processing';
    case 'low_risk':
      return 'text-text-muted';
    case 'compliant':
      return 'text-pass';
  }
}
