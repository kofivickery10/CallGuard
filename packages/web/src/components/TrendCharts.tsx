import { useQuery } from '@tanstack/react-query';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { api } from '../api/client';
import type {
  CallsPerDayPoint,
  ScoreTrendPoint,
  ScorecardBreakdownRow,
  BreachSeverityPoint,
} from '@callguard/shared';

const COLORS = {
  primary: '#4a9e6e',
  fail: '#c0392b',
  review: '#b8860b',
  processing: '#2d5a9e',
  neutral: '#c2c5c5',
  neutralDark: '#8a9e8a',
};

interface TrendChartsProps {
  agentFilter: string | null;
}

export function TrendCharts({ agentFilter }: TrendChartsProps) {
  return (
    <div className="mb-10">
      <h3 className="font-heading text-heading-md text-neutral-900 mb-4">Trends</h3>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <CallsPerDayChart agentFilter={agentFilter} />
        <ScoresOverTimeChart agentFilter={agentFilter} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ScorecardBreakdownTable agentFilter={agentFilter} />
        <BreachSeverityChart agentFilter={agentFilter} />
      </div>
    </div>
  );
}

// ============================================================
// Chart card wrapper
// ============================================================

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-border rounded-card p-5">
      <div className="mb-4">
        <h4 className="text-[15px] font-semibold text-text-primary">{title}</h4>
        {subtitle && <p className="text-[12px] text-text-muted mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="h-[220px] flex items-center justify-center text-table-cell text-text-muted">
      {message}
    </div>
  );
}

// ============================================================
// 1. Calls Per Day
// ============================================================

function CallsPerDayChart({ agentFilter }: { agentFilter: string | null }) {
  const qs = agentFilter ? `?agent_id=${agentFilter}&days=30` : '?days=30';
  const { data } = useQuery({
    queryKey: ['trends', 'calls-per-day', agentFilter],
    queryFn: () => api.get<{ data: CallsPerDayPoint[] }>(`/dashboard/trends/calls-per-day${qs}`),
  });

  const hasData = data?.data.some((d) => d.total > 0);

  return (
    <ChartCard title="Calls Per Day" subtitle="Last 30 days">
      {!hasData ? (
        <EmptyState message="No calls yet in the last 30 days" />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data?.data} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.neutral} vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: COLORS.neutralDark }}
              tickFormatter={(v) => new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
              interval={Math.ceil((data?.data.length || 0) / 10)}
            />
            <YAxis tick={{ fontSize: 11, fill: COLORS.neutralDark }} allowDecimals={false} />
            <Tooltip
              contentStyle={{ background: '#fff', border: '1px solid #e2e8e2', borderRadius: 6, fontSize: 12 }}
              labelFormatter={(v) => new Date(v).toLocaleDateString('en-GB')}
            />
            <Bar dataKey="scored" stackId="a" fill={COLORS.primary} name="Scored" />
            <Bar dataKey="total" stackId="b" fill={COLORS.neutral} name="Total" opacity={0} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

// ============================================================
// 2. Scores Over Time
// ============================================================

function ScoresOverTimeChart({ agentFilter }: { agentFilter: string | null }) {
  const qs = agentFilter ? `?agent_id=${agentFilter}&weeks=12` : '?weeks=12';
  const { data } = useQuery({
    queryKey: ['trends', 'scores-over-time', agentFilter],
    queryFn: () => api.get<{ data: ScoreTrendPoint[] }>(`/dashboard/trends/scores-over-time${qs}`),
  });

  return (
    <ChartCard title="Scores Over Time" subtitle="Weekly avg score & pass rate (last 12 weeks)">
      {!data?.data.length ? (
        <EmptyState message="Not enough scored calls yet" />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data.data} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.neutral} vertical={false} />
            <XAxis
              dataKey="week_start"
              tick={{ fontSize: 11, fill: COLORS.neutralDark }}
              tickFormatter={(v) => new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
            />
            <YAxis
              tick={{ fontSize: 11, fill: COLORS.neutralDark }}
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
            />
            <Tooltip
              contentStyle={{ background: '#fff', border: '1px solid #e2e8e2', borderRadius: 6, fontSize: 12 }}
              labelFormatter={(v) => `Week of ${new Date(v).toLocaleDateString('en-GB')}`}
              formatter={(val) => `${Math.round(Number(val))}%`}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line
              type="monotone"
              dataKey="avg_score"
              stroke={COLORS.primary}
              strokeWidth={2}
              dot={{ r: 3 }}
              name="Avg Score"
            />
            <Line
              type="monotone"
              dataKey="pass_rate"
              stroke={COLORS.processing}
              strokeWidth={2}
              dot={{ r: 3 }}
              name="Pass Rate"
              strokeDasharray="5 5"
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

// ============================================================
// 3. Compliance by Scorecard (table with inline bars)
// ============================================================

function ScorecardBreakdownTable({ agentFilter }: { agentFilter: string | null }) {
  const qs = agentFilter ? `?agent_id=${agentFilter}` : '';
  const { data } = useQuery({
    queryKey: ['trends', 'by-scorecard', agentFilter],
    queryFn: () => api.get<{ data: ScorecardBreakdownRow[] }>(`/dashboard/trends/by-scorecard${qs}`),
  });

  return (
    <ChartCard title="Compliance by Scorecard" subtitle="Volume, score, and critical breaches">
      {!data?.data.length ? (
        <EmptyState message="No scored calls yet" />
      ) : (
        <div className="overflow-hidden">
          <table className="w-full">
            <thead>
              <tr>
                {['Scorecard', 'Calls', 'Avg Score', 'Critical'].map((h) => (
                  <th key={h} className="text-left py-2 text-[11px] uppercase tracking-wider text-text-muted font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.data.map((row) => (
                <tr key={row.id} className="border-t border-border-light">
                  <td className="py-3 text-table-cell text-text-primary font-medium">{row.name}</td>
                  <td className="py-3 text-table-cell text-text-cell font-mono">{row.call_count}</td>
                  <td className="py-3">
                    {row.avg_score != null ? (
                      <div className="flex items-center gap-2">
                        <div className="w-[50px] h-[5px] bg-border rounded-[3px]">
                          <div
                            className="h-full rounded-[3px]"
                            style={{
                              width: `${Math.max(0, Math.min(100, row.avg_score))}%`,
                              background: row.avg_score >= 80 ? COLORS.primary : row.avg_score >= 65 ? COLORS.review : COLORS.fail,
                            }}
                          />
                        </div>
                        <span className="text-table-cell font-mono font-semibold text-text-cell">
                          {Math.round(row.avg_score)}%
                        </span>
                      </div>
                    ) : (
                      <span className="text-text-muted">--</span>
                    )}
                  </td>
                  <td className="py-3 text-table-cell font-mono">
                    {row.critical_count > 0 ? (
                      <span className="text-fail font-semibold">{row.critical_count}</span>
                    ) : (
                      <span className="text-text-muted">0</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ChartCard>
  );
}

// ============================================================
// 4. Breach Severity Trend (stacked bar chart)
// ============================================================

function BreachSeverityChart({ agentFilter }: { agentFilter: string | null }) {
  const qs = agentFilter ? `?agent_id=${agentFilter}&weeks=12` : '?weeks=12';
  const { data } = useQuery({
    queryKey: ['trends', 'breach-severity', agentFilter],
    queryFn: () => api.get<{ data: BreachSeverityPoint[] }>(`/dashboard/trends/breach-severity${qs}`),
  });

  const hasData = data?.data.some(
    (d) => d.critical + d.high + d.medium + d.low > 0
  );

  return (
    <ChartCard title="Breach Severity" subtitle="Weekly breach counts by severity (last 12 weeks)">
      {!hasData ? (
        <EmptyState message="No breaches yet - nice work!" />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data?.data} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.neutral} vertical={false} />
            <XAxis
              dataKey="week_start"
              tick={{ fontSize: 11, fill: COLORS.neutralDark }}
              tickFormatter={(v) => new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
            />
            <YAxis tick={{ fontSize: 11, fill: COLORS.neutralDark }} allowDecimals={false} />
            <Tooltip
              contentStyle={{ background: '#fff', border: '1px solid #e2e8e2', borderRadius: 6, fontSize: 12 }}
              labelFormatter={(v) => `Week of ${new Date(v).toLocaleDateString('en-GB')}`}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="critical" stackId="s" fill={COLORS.fail} name="Critical" />
            <Bar dataKey="high" stackId="s" fill="#e57766" name="High" />
            <Bar dataKey="medium" stackId="s" fill={COLORS.review} name="Medium" />
            <Bar dataKey="low" stackId="s" fill={COLORS.neutral} name="Low" />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
