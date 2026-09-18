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
import { useChartColors, TOOLTIP_STYLE, TOOLTIP_LABEL_STYLE } from '../lib/chartColors';
import { useScoreOnly } from '../context/AuthContext';
import { ScoreGauge } from './ScoreGauge';
import type {
  CallsPerDayPoint,
  ScoreTrendPoint,
  ScorecardBreakdownRow,
  BreachSeverityPoint,
} from '@callguard/shared';

interface TrendChartsProps {
  agentFilter: string | null;
  // Which unit this firm is scored on, from /dashboard/summary — so the charts
  // say "sales" to a firm that scores sales and "calls" to one that doesn't,
  // rather than calling everything a call.
  mode: 'sales' | 'calls';
}

export function TrendCharts({ agentFilter, mode }: TrendChartsProps) {
  return (
    <section className="mb-7" aria-labelledby="trends-heading">
      <h3 id="trends-heading" className="text-section-heading text-text-primary">
        Which way it is moving
      </h3>
      <p className="text-page-sub text-text-subtle mt-0.5 mb-4">
        Each panel says the window it covers. They are not the all-time figures above.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <CallsPerDayChart agentFilter={agentFilter} />
        <ScoresOverTimeChart agentFilter={agentFilter} mode={mode} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ScorecardBreakdownTable agentFilter={agentFilter} mode={mode} />
        <BreachSeverityChart agentFilter={agentFilter} />
      </div>
    </section>
  );
}

// ============================================================
// Chart card wrapper. Loading, empty and error are one decision, not three
// independent ones — the page used to render its skeleton and its empty state
// at the same time, and had no error state at all.
// ============================================================

type CardState = 'loading' | 'error' | 'empty' | 'ready';

function ChartCard({
  title,
  measure,
  state,
  emptyMessage,
  onRetry,
  // A sentence describing the same thing the drawing shows, for anyone who
  // cannot see it. Recharts renders an SVG with no text equivalent of its own.
  textEquivalent,
  children,
}: {
  title: string;
  measure: string;
  state: CardState;
  emptyMessage: string;
  onRetry: () => void;
  textEquivalent?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-card shadow-card p-5">
      <div className="mb-4">
        <h4 className="text-section-title text-text-primary">{title}</h4>
        <p className="text-xs text-text-secondary mt-0.5">{measure}</p>
      </div>
      {state === 'error' ? (
        <div className="h-[220px] flex flex-col items-start justify-center gap-3">
          <span className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">
            Couldn&rsquo;t load this.
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Try again
          </button>
        </div>
      ) : state === 'loading' ? (
        <div
          className="h-[220px] rounded bg-[length:800px_100%] animate-skeleton-shimmer"
          aria-busy="true"
          aria-label={`Loading ${title}`}
          style={{
            backgroundImage:
              'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
          }}
        />
      ) : state === 'empty' ? (
        <div className="h-[220px] flex items-center justify-center text-table-cell text-text-muted text-center">
          {emptyMessage}
        </div>
      ) : (
        <>
          {textEquivalent && <p className="sr-only">{textEquivalent}</p>}
          <div aria-hidden="true">{children}</div>
        </>
      )}
    </div>
  );
}

function stateOf(isLoading: boolean, isError: boolean, hasData: boolean): CardState {
  if (isError) return 'error';
  if (isLoading) return 'loading';
  return hasData ? 'ready' : 'empty';
}

// Ink, not the series colour. Recharts colours a legend label with the series
// fill, which measured between 1.74:1 and 3.28:1 against the card — the swatch
// beside it already carries the colour, so the words don't have to.
const legendText = (value: string) => (
  <span className="text-table-cell text-text-secondary align-middle">{value}</span>
);

const londonDay = (v: string) =>
  new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Europe/London' });

// ============================================================
// 1. Calls Per Day
// ============================================================

function CallsPerDayChart({ agentFilter }: { agentFilter: string | null }) {
  const qs = agentFilter ? `?agent_id=${agentFilter}&days=30` : '?days=30';
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['trends', 'calls-per-day', agentFilter],
    queryFn: () => api.get<{ data: CallsPerDayPoint[] }>(`/dashboard/trends/calls-per-day${qs}`),
  });

  const hasData = !!data?.data.some((d) => d.total > 0);
  const { grid, tick, primary, neutral } = useChartColors();
  // One stacked bar per day whose full height is the total call volume:
  // the scored portion is highlighted, the rest ('captured'/unscored) is
  // neutral. The old chart drew only 'scored' and hid 'total' (opacity 0), so
  // a capture tenant — most calls unscored until a sale — saw an empty chart.
  const chartData = data?.data.map((d) => ({ ...d, unscored: Math.max(0, d.total - d.scored) }));

  const total = data?.data.reduce((a, d) => a + d.total, 0) ?? 0;
  const scored = data?.data.reduce((a, d) => a + d.scored, 0) ?? 0;

  return (
    <ChartCard
      title="How many calls are arriving"
      measure="One bar a day, last 30 days · the scored part is highlighted"
      state={stateOf(isLoading, isError, hasData)}
      emptyMessage="No calls in the last 30 days"
      onRetry={() => refetch()}
      textEquivalent={`${total.toLocaleString('en-GB')} calls arrived in the last 30 days, of which ${scored.toLocaleString('en-GB')} are covered by scoring.`}
    >
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={grid} vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: tick }}
            // `date` is a date-only 'YYYY-MM-DD' string the server already
            // truncated in Europe/London (see routes/dashboard.ts). Rendering
            // it without a fixed zone lets the browser parse it as UTC
            // midnight and then re-render in the viewer's local time, which
            // is a day off for anyone behind UTC.
            tickFormatter={londonDay}
            interval={Math.ceil((data?.data.length || 0) / 10)}
          />
          <YAxis tick={{ fontSize: 11, fill: tick }} allowDecimals={false} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            labelFormatter={(v) => new Date(v).toLocaleDateString('en-GB', { timeZone: 'Europe/London' })}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendText} />
          <Bar dataKey="scored" stackId="a" fill={primary} name="Scored" />
          <Bar dataKey="unscored" stackId="a" fill={neutral} name="Not yet scored" />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ============================================================
// 2. Scores Over Time
// ============================================================

function ScoresOverTimeChart({
  agentFilter,
  mode,
}: {
  agentFilter: string | null;
  mode: 'sales' | 'calls';
}) {
  const qs = agentFilter ? `?agent_id=${agentFilter}&weeks=12` : '?weeks=12';
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['trends', 'scores-over-time', agentFilter],
    queryFn: () => api.get<{ data: ScoreTrendPoint[] }>(`/dashboard/trends/scores-over-time${qs}`),
  });

  const { grid, tick, primary, processing } = useChartColors();
  const scoreOnly = useScoreOnly();
  const unit = mode === 'sales' ? 'sales' : 'calls';

  const scored = data?.data.filter((d) => d.avg_score != null) ?? [];
  const hasData = scored.length > 0;
  const latest = scored[scored.length - 1];
  const first = scored[0];

  const textEquivalent =
    latest && first
      ? `Weekly average score over the last 12 weeks. The most recent week with a score averaged ${Math.round(latest.avg_score ?? 0)}% across ${latest.unit_count} scored ${unit}; the earliest averaged ${Math.round(first.avg_score ?? 0)}%.`
      : undefined;

  return (
    <ChartCard
      title="Whether scores are improving"
      measure={
        scoreOnly
          ? `Weekly average score, last 12 weeks · a ${mode === 'sales' ? 'sale' : 'call'} counts in the week it happened`
          : `Weekly average score and pass rate, last 12 weeks · a ${mode === 'sales' ? 'sale' : 'call'} counts in the week it happened`
      }
      state={stateOf(isLoading, isError, hasData)}
      emptyMessage="Nothing scored in the last 12 weeks"
      onRetry={() => refetch()}
      textEquivalent={textEquivalent}
    >
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data?.data} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={grid} vertical={false} />
          <XAxis
            dataKey="week_start"
            tick={{ fontSize: 11, fill: tick }}
            // `week_start` is a date-only 'YYYY-MM-DD' string already
            // truncated in Europe/London server-side (routes/dashboard.ts);
            // pin the zone here too so it doesn't shift a day for viewers
            // behind UTC.
            tickFormatter={londonDay}
          />
          <YAxis tick={{ fontSize: 11, fill: tick }} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            labelFormatter={(v) => `Week of ${new Date(v).toLocaleDateString('en-GB', { timeZone: 'Europe/London' })}`}
            formatter={(val) => `${Math.round(Number(val))}%`}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendText} />
          <Line
            type="monotone"
            dataKey="avg_score"
            stroke={primary}
            strokeWidth={2}
            dot={{ r: 3 }}
            name="Avg score"
            connectNulls
          />
          {/* Under score_only the server sends no pass rate at all, so there is
              nothing to draw even if this branch were reached. */}
          {!scoreOnly && (
            <Line
              type="monotone"
              dataKey="pass_rate"
              stroke={processing}
              strokeWidth={2}
              dot={{ r: 3 }}
              name="Pass rate"
              strokeDasharray="5 5"
              connectNulls
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ============================================================
// 3. Compliance by Scorecard (table with inline bars)
// ============================================================

function ScorecardBreakdownTable({
  agentFilter,
  mode,
}: {
  agentFilter: string | null;
  mode: 'sales' | 'calls';
}) {
  const qs = agentFilter ? `?agent_id=${agentFilter}` : '';
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['trends', 'by-scorecard', agentFilter],
    queryFn: () => api.get<{ data: ScorecardBreakdownRow[] }>(`/dashboard/trends/by-scorecard${qs}`),
  });

  const hasData = !!data?.data.length;
  // The unit column used to be headed CALLS while counting scored units — which
  // at a firm that scores sales are sales, not calls.
  const unitHeader = mode === 'sales' ? 'Sales' : 'Calls';

  return (
    <ChartCard
      title="Where each scorecard stands"
      measure="Every scored unit against it, all time"
      state={stateOf(isLoading, isError, hasData)}
      emptyMessage="Nothing scored against a scorecard yet"
      onRetry={() => refetch()}
    >
      <div className="overflow-x-auto">
        <table className="w-full">
          <caption className="sr-only">
            Scorecards by volume, average score and open critical breaches, all time.
          </caption>
          <thead>
            <tr>
              {['Scorecard', unitHeader, 'Avg score', 'Critical open'].map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="text-left py-2 text-table-header uppercase text-text-muted"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data?.data.map((row) => (
              <tr key={row.id} className="border-t border-border-light">
                <td className="py-3 text-table-cell text-text-primary font-medium">{row.name}</td>
                <td className="py-3 text-table-cell text-text-cell tabular-nums">
                  {row.unit_count.toLocaleString('en-GB')}
                </td>
                <td className="py-3">
                  {/* ScoreGauge, not a hand-rolled bar: it drops the green /
                      amber / red banding under score_only, which the old inline
                      bar did not — colouring a bar by pass threshold on a
                      tenant that is shielded from verdicts. */}
                  {row.avg_score != null ? (
                    <ScoreGauge score={row.avg_score} showBar />
                  ) : (
                    <span className="text-text-muted text-table-cell">No score</span>
                  )}
                </td>
                <td className="py-3 text-table-cell tabular-nums">
                  {row.critical_open > 0 ? (
                    <span className="text-fail font-semibold">{row.critical_open}</span>
                  ) : (
                    <span className="text-text-cell">0</span>
                  )}
                  <span className="block text-xs text-text-secondary">
                    of {row.critical_total.toLocaleString('en-GB')} raised
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}

// ============================================================
// 4. Breach Severity Trend (stacked bar chart)
// ============================================================

function BreachSeverityChart({ agentFilter }: { agentFilter: string | null }) {
  const qs = agentFilter ? `?agent_id=${agentFilter}&weeks=12` : '?weeks=12';
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['trends', 'breach-severity', agentFilter],
    queryFn: () => api.get<{ data: BreachSeverityPoint[] }>(`/dashboard/trends/breach-severity${qs}`),
  });

  const hasData = !!data?.data.some((d) => d.critical + d.high + d.medium + d.low > 0);
  const { grid, tick, fail, high, review, neutral } = useChartColors();

  const totals = (data?.data ?? []).reduce(
    (a, d) => ({
      critical: a.critical + d.critical,
      high: a.high + d.high,
      medium: a.medium + d.medium,
      low: a.low + d.low,
    }),
    { critical: 0, high: 0, medium: 0, low: 0 }
  );

  return (
    <ChartCard
      title="What is being flagged"
      measure="Breaches raised each week by severity, last 12 weeks"
      state={stateOf(isLoading, isError, hasData)}
      emptyMessage="No breaches raised in the last 12 weeks"
      onRetry={() => refetch()}
      textEquivalent={`Over the last 12 weeks: ${totals.critical} critical, ${totals.high} high, ${totals.medium} medium and ${totals.low} low breaches were raised.`}
    >
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data?.data} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={grid} vertical={false} />
          <XAxis
            dataKey="week_start"
            tick={{ fontSize: 11, fill: tick }}
            // `week_start` is a date-only 'YYYY-MM-DD' string already
            // truncated in Europe/London server-side (routes/dashboard.ts);
            // pin the zone here too so it doesn't shift a day for viewers
            // behind UTC.
            tickFormatter={londonDay}
          />
          <YAxis tick={{ fontSize: 11, fill: tick }} allowDecimals={false} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            labelFormatter={(v) => `Week of ${new Date(v).toLocaleDateString('en-GB', { timeZone: 'Europe/London' })}`}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendText} />
          <Bar dataKey="critical" stackId="s" fill={fail} name="Critical" />
          <Bar dataKey="high" stackId="s" fill={high} name="High" />
          <Bar dataKey="medium" stackId="s" fill={review} name="Medium" />
          <Bar dataKey="low" stackId="s" fill={neutral} name="Low" />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
