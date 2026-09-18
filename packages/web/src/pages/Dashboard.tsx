import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth, useScoreOnly } from '../context/AuthContext';
import { ScoreGauge } from '../components/ScoreGauge';
import { CountUp } from '../components/CountUp';
import { AgentFilter } from '../components/AgentFilter';
import { TrendCharts } from '../components/TrendCharts';
import { ORG_WIDE_ROLES } from '@callguard/shared';
import type {
  AgentLeaderboardResponse,
  BreachSummary,
  CallAdviserOption,
  DashboardRecentResponse,
  DashboardSummary,
  RecentCallRow,
  RecentSaleRow,
} from '@callguard/shared';

// ============================================================
// The dashboard answers four questions, in the order a compliance manager asks
// them: how much have we scored and how is it going (the tiles), which way is
// it moving (the trends), who is driving it (the leaderboard), and what has
// just come through (the recent panel).
//
// Every figure says what it is measured over. The tiles are all-time and used
// to say nothing, while sitting directly above charts captioned "last 30 days"
// and "last 12 weeks".
// ============================================================

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function formatInt(n: number): string {
  return n.toLocaleString('en-GB');
}

// ============================================================
// Stat tiles
// ============================================================

interface Stat {
  // Identity, NOT position. The icon used to be picked by array index, and the
  // score-only branch drops the Pass Rate tile and shifts everything down one —
  // so "Open Breaches 18" rendered a green tick in a circle.
  key: string;
  label: string;
  value: number | string | null;
  // What the figure is measured over, and anything that qualifies it.
  caption?: string;
  suffix?: string;
  // Counting up suits a total climbing to its value. A breach count is not a
  // score to celebrate reaching, so those render at once.
  animate?: boolean;
  tone?: 'warning' | 'critical';
  to?: string;
  icon: string[];
}

const ICONS = {
  total_calls: [
    'M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3',
  ],
  scored: ['M9 11l3 3L22 4', 'M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11'],
  avg_score: ['M22 12l-4 0-3 9-6-18-3 9-4 0'],
  pass_rate: ['M12 2a10 10 0 100 20 10 10 0 000-20zM9 12l2 2 4-4'],
  waiting: ['M12 2a10 10 0 100 20 10 10 0 000-20z', 'M12 6v6l4 2'],
  open_breaches: [
    'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z',
    'M12 9v4',
    'M12 17h.01',
  ],
  critical: ['M12 2l7 4v6c0 4.97-3.05 8.06-7 10-3.95-1.94-7-5.03-7-10V6l7-4z', 'M12 8v4', 'M12 16h.01'],
};

// Tailwind reads these as literal strings, so the column counts must be spelled
// out rather than built from a template.
const TILE_COLS: Record<number, string | undefined> = {
  3: 'grid-cols-2 sm:grid-cols-3',
  4: 'grid-cols-2 sm:grid-cols-4',
  5: 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-5',
  6: 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-6',
  // Seven only once there is room for it: at lg the captions wrap to four
  // lines and the row stops being readable.
  7: 'grid-cols-2 sm:grid-cols-4 xl:grid-cols-7',
};

function StatValue({ stat }: { stat: Stat }) {
  if (stat.value == null) return <>–</>;
  if (typeof stat.value === 'string') return <>{stat.value}</>;
  if (stat.animate === false) {
    return <span className="tabular-nums">{formatInt(stat.value)}{stat.suffix ?? ''}</span>;
  }
  return <CountUp value={stat.value} suffix={stat.suffix ?? ''} />;
}

function StatTile({ stat }: { stat: Stat }) {
  const valueColor =
    stat.tone === 'critical' ? 'text-fail' : stat.tone === 'warning' ? 'text-review' : 'text-text-primary';

  const body = (
    <>
      <div className="flex justify-between items-start gap-2">
        <span className="text-card-label uppercase text-text-muted">{stat.label}</span>
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="w-[18px] h-[18px] shrink-0 stroke-icon-muted"
          fill="none"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {stat.icon.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      </div>
      <div className={`text-card-value mt-2.5 ${valueColor}`}>
        <StatValue stat={stat} />
      </div>
      {stat.caption && (
        <div className="text-xs leading-snug mt-1 text-text-secondary">{stat.caption}</div>
      )}
    </>
  );

  const shell = 'bg-card border border-border rounded-card shadow-card p-5 block';

  if (stat.to) {
    return (
      <Link
        to={stat.to}
        className={`${shell} hover:border-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40`}
      >
        {body}
      </Link>
    );
  }
  return <div className={shell}>{body}</div>;
}

function TileSkeleton() {
  return (
    <div className="bg-card border border-border rounded-card shadow-card p-5" aria-hidden="true">
      <div
        className="h-3 w-1/2 rounded bg-[length:800px_100%] animate-skeleton-shimmer"
        style={{
          backgroundImage:
            'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
        }}
      />
      <div
        className="h-6 w-2/3 mt-3 rounded bg-[length:800px_100%] animate-skeleton-shimmer"
        style={{
          backgroundImage:
            'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
        }}
      />
    </div>
  );
}

// The shared inline failure banner (DESIGN_SYSTEM §4). Every panel on this page
// had a loading and an empty state and no error state at all: a failed request
// rendered "No calls yet — upload your first call" to a firm with 8,848 calls.
function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="px-5 py-6 flex flex-wrap items-center gap-3">
      <span className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">
        Couldn&rsquo;t load {what}.
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        Try again
      </button>
    </div>
  );
}

function PanelHeader({
  title,
  measure,
  linkTo,
  linkLabel,
}: {
  title: string;
  measure: string;
  linkTo: string;
  linkLabel: string;
}) {
  return (
    <div className="px-5 py-4 border-b border-border flex flex-wrap justify-between items-baseline gap-x-4 gap-y-1">
      <div>
        <h3 className="text-section-title text-text-primary">{title}</h3>
        <p className="text-xs text-text-secondary mt-0.5">{measure}</p>
      </div>
      <Link
        to={linkTo}
        className="text-table-cell text-primary-ink font-semibold hover:underline px-2 py-1.5 -mr-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {linkLabel}
      </Link>
    </div>
  );
}

const TH =
  'text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border';

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr className="border-b border-border-light last:border-0">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-5 py-3.5">
          <div
            className="h-4 rounded bg-[length:800px_100%] animate-skeleton-shimmer"
            style={{
              backgroundImage:
                'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
              width: i === 0 ? '60%' : '40%',
            }}
          />
        </td>
      ))}
    </tr>
  );
}

// ============================================================
// What a recent sale is waiting for — the sales register's vocabulary
// (pages/Journeys.tsx), shortened to the one line this panel has room for.
// ============================================================

function saleState(row: RecentSaleRow): { title: string; detail?: string } {
  const adviser = row.agent_name ?? 'the adviser';
  if (row.status === 'pending') return { title: 'Waiting to score' };
  if (row.status === 'scoring') return { title: 'Scoring' };
  if (row.status === 'failed') return { title: 'Score it again', detail: 'scoring did not finish' };
  if (row.status === 'skipped') return { title: 'Not taken up', detail: 'so it is not scored' };
  if (row.items_to_review > 0) {
    return {
      title: `Review ${row.items_to_review} ${plural(row.items_to_review, 'checkpoint', 'checkpoints')}`,
      detail: 'held for a person',
    };
  }
  if (row.feedback_status === 'awaiting') return { title: `Awaiting ${adviser}` };
  if (row.feedback_status === 'awaiting_remediation') return { title: `Chase ${adviser}` };
  if (row.items_failed > 0 && row.feedback_status === 'not_fed_back') {
    return {
      title: 'Feed back',
      detail: `${row.items_failed} ${plural(row.items_failed, 'finding', 'findings')} for ${adviser}`,
    };
  }
  return {
    title: 'Done',
    detail: row.feedback_status === 'acknowledged' ? `${adviser} acknowledged` : 'nothing to feed back',
  };
}

function shortDate(iso: string | null): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function formatClock(seconds: number | null): string {
  if (seconds == null) return '–';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

// ============================================================

export function Dashboard() {
  const { user } = useAuth();
  const scoreOnly = useScoreOnly();
  // Every trend endpoint is requireOrgView, which admits supervisor and viewer.
  // Gating this page on role === 'admin' left a compliance supervisor — the
  // person the charts are FOR — with three tiles and a table.
  const orgWide = !!user && ORG_WIDE_ROLES.includes(user.role as never);
  const canUpload = ['admin', 'supervisor', 'adviser'].includes(user?.role ?? '');
  const [agentFilter, setAgentFilter] = useState<string | null>(null);

  const queryParams = agentFilter ? `?agent_id=${agentFilter}` : '';

  const summaryQ = useQuery({
    queryKey: ['dashboard', 'summary', agentFilter],
    queryFn: () => api.get<DashboardSummary>(`/dashboard/summary${queryParams}`),
  });

  const recentQ = useQuery({
    queryKey: ['dashboard', 'recent', agentFilter],
    queryFn: () => api.get<DashboardRecentResponse>(`/dashboard/recent?limit=5${agentFilter ? `&agent_id=${agentFilter}` : ''}`),
  });

  const leaderboardQ = useQuery({
    queryKey: ['dashboard', 'leaderboard'],
    queryFn: () => api.get<AgentLeaderboardResponse>('/dashboard/agent-leaderboard'),
    enabled: orgWide,
  });

  const breachQ = useQuery({
    queryKey: ['breach-summary'],
    queryFn: () => api.get<BreachSummary>('/breaches/summary'),
    enabled: orgWide,
  });

  // The filter's options come from /calls/advisers, not /agents: the latter is
  // admin-only and would 403 the supervisors this page now serves.
  const advisersQ = useQuery({
    queryKey: ['call-advisers'],
    queryFn: () => api.get<{ data: CallAdviserOption[] }>('/calls/advisers'),
    enabled: orgWide,
  });

  const summary = summaryQ.data;
  const mode = summary?.mode ?? 'sales';
  const unit = mode === 'sales' ? 'sale' : 'call';
  const units = mode === 'sales' ? 'sales' : 'calls';

  // Said by the server, off the scoping it actually applied. Only an adviser is
  // narrowed to their own work; a supervisor used to be shown every call in the
  // firm under the heading "Your performance".
  const scopeLine =
    summary?.scope === 'own'
      ? 'Your own scored work, all time unless a panel says otherwise'
      : summary?.scope === 'adviser'
        ? 'One adviser, all time unless a panel says otherwise'
        : 'Your whole firm, all time unless a panel says otherwise';

  const held = summary?.items_to_review ?? 0;

  const baseStats: Stat[] = summary
    ? [
        {
          key: 'total_calls',
          label: 'Total calls',
          value: summary.total_calls,
          caption: 'All time',
          icon: ICONS.total_calls,
        },
        {
          key: 'scored',
          label: 'Scored',
          value: mode === 'sales' ? summary.scored_sales : summary.scored_units,
          caption:
            mode === 'sales'
              ? `${formatInt(summary.scored_calls)} calls covered · all time`
              : 'All time',
          icon: ICONS.scored,
        },
        {
          key: 'avg_score',
          label: 'Avg score',
          value: summary.average_score != null ? Math.round(summary.average_score) : null,
          suffix: '%',
          caption:
            held > 0
              ? `Across ${formatInt(summary.scored_units)} scored ${units} · ${formatInt(held)} held ${plural(held, 'checkpoint sits', 'checkpoints sit')} outside it`
              : `Across ${formatInt(summary.scored_units)} scored ${units}, all time`,
          icon: ICONS.avg_score,
        },
        // Pass Rate is verdict-derived — the server withholds it under
        // score_only, so there is nothing to render.
        ...(scoreOnly || summary.pass_rate == null
          ? []
          : [
              {
                key: 'pass_rate',
                label: 'Pass rate',
                value: Math.round(summary.pass_rate),
                suffix: '%',
                caption: `Of ${formatInt(summary.units_with_verdict ?? 0)} ${units} carrying a verdict`,
                icon: ICONS.pass_rate,
              } as Stat,
            ]),
        {
          key: 'waiting',
          label: 'Waiting on you',
          value: held,
          animate: false,
          tone: held > 0 ? 'warning' : undefined,
          caption:
            held === 0
              ? 'No checkpoint is held'
              : summary.oldest_review_days != null && summary.oldest_review_days > 0
                ? `Held checkpoints · oldest ${summary.oldest_review_days} ${plural(summary.oldest_review_days, 'day', 'days')} ago`
                : 'Held checkpoints · raised today',
          to: '/review-queue',
          icon: ICONS.waiting,
        },
      ]
    : [];

  // What actually happened to the breaches — the register holds far more than
  // the open count, and "Needs attention / Review required" said nothing.
  const raised = breachQ.data
    ? Object.values(breachQ.data.by_status).reduce((a, b) => a + b, 0)
    : 0;
  const closed = breachQ.data
    ? breachQ.data.by_status.resolved + breachQ.data.by_status.noted
    : 0;
  const actioned = breachQ.data
    ? breachQ.data.by_status.acknowledged +
      breachQ.data.by_status.coached +
      breachQ.data.by_status.escalated
    : 0;
  const criticalOpen = breachQ.data?.by_severity.critical ?? 0;

  const breachStats: Stat[] = breachQ.data
    ? [
        {
          key: 'open_breaches',
          label: 'Open breaches',
          value: breachQ.data.total_open,
          animate: false,
          tone: breachQ.data.total_open > 0 ? 'warning' : undefined,
          caption: `${formatInt(raised)} raised, ${formatInt(closed)} closed`,
          to: '/breaches',
          icon: ICONS.open_breaches,
        },
        {
          key: 'critical',
          label: 'Critical open',
          value: criticalOpen,
          animate: false,
          tone: criticalOpen > 0 ? 'critical' : undefined,
          caption: `${formatInt(actioned)} of ${formatInt(raised)} ever acknowledged or escalated`,
          to: '/breaches?severity=critical',
          icon: ICONS.critical,
        },
      ]
    : [];

  const stats = orgWide ? [...baseStats, ...breachStats] : baseStats;
  const cols = TILE_COLS[stats.length] ?? TILE_COLS[4];
  const skeletonCount = orgWide ? (scoreOnly ? 6 : 7) : scoreOnly ? 4 : 5;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Dashboard</h2>
          <p className="text-page-sub text-text-subtle mt-1">{scopeLine}</p>
        </div>
        {orgWide && (
          <AgentFilter
            value={agentFilter}
            onChange={setAgentFilter}
            options={advisersQ.data?.data ?? []}
            label="Filter the dashboard by adviser"
          />
        )}
      </div>

      {/* Where the firm stands */}
      {summaryQ.isError ? (
        <div className="bg-card border border-border rounded-card shadow-card mb-7">
          <LoadError what="the headline figures" onRetry={() => summaryQ.refetch()} />
        </div>
      ) : (
        <div
          className={`grid gap-4 mb-7 ${summaryQ.isLoading ? TILE_COLS[skeletonCount] ?? TILE_COLS[4] : cols}`}
        >
          {summaryQ.isLoading
            ? Array.from({ length: skeletonCount }).map((_, i) => <TileSkeleton key={i} />)
            : stats.map((stat) => <StatTile key={stat.key} stat={stat} />)}
        </div>
      )}

      {/* Which way it is moving */}
      {orgWide && <TrendCharts agentFilter={agentFilter} mode={mode} />}

      {/* Who is driving it */}
      {orgWide && !agentFilter && (
        <div className="bg-card border border-border rounded-card shadow-card overflow-hidden mb-5">
          <PanelHeader
            title="How each adviser is scoring"
            measure={`Average across every scored ${unit} credited to them, all time`}
            linkTo="/team"
            linkLabel="View team"
          />
          {leaderboardQ.isError ? (
            <LoadError what="adviser scores" onRetry={() => leaderboardQ.refetch()} />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px]">
                  <caption className="sr-only">
                    Advisers by average score across every scored {unit} credited to them, all time.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TH}>Adviser</th>
                      <th scope="col" className={TH}>{mode === 'sales' ? 'Sales scored' : 'Calls scored'}</th>
                      <th scope="col" className={TH}>Avg score</th>
                      {!scoreOnly && <th scope="col" className={TH}>Pass rate</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboardQ.isLoading &&
                      Array.from({ length: 4 }).map((_, i) => (
                        <SkeletonRow key={i} cols={scoreOnly ? 3 : 4} />
                      ))}
                    {!leaderboardQ.isLoading &&
                      leaderboardQ.data?.data.map((adviser) => (
                        <tr key={adviser.id} className="hover:bg-table-header transition-colors border-b border-border-light last:border-0">
                          <td className="px-5 py-3 text-table-cell text-text-cell font-medium">{adviser.name}</td>
                          <td className="px-5 py-3 text-table-cell text-text-cell tabular-nums">
                            {formatInt(adviser.scored_units)}
                          </td>
                          <td className="px-5 py-3">
                            {adviser.average_score != null ? (
                              <ScoreGauge score={adviser.average_score} showBar />
                            ) : (
                              <span className="text-text-muted text-table-cell">Nothing scored yet</span>
                            )}
                          </td>
                          {!scoreOnly && (
                            <td className="px-5 py-3 text-table-cell text-text-cell tabular-nums">
                              {adviser.pass_rate != null ? `${Math.round(adviser.pass_rate)}%` : '–'}
                            </td>
                          )}
                        </tr>
                      ))}
                    {!leaderboardQ.isLoading && leaderboardQ.data?.data.length === 0 && (
                      <tr>
                        <td
                          colSpan={scoreOnly ? 3 : 4}
                          className="px-5 py-12 text-center text-text-muted text-table-cell"
                        >
                          Nothing is credited to an adviser yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {/* The rows used to sum to less than the tile above and say nothing
                  about why: a sale closing on a call with no adviser is in the
                  firm's average and in nobody's row. */}
              {!!leaderboardQ.data?.unattributed_units && (
                <p className="px-5 py-3 border-t border-border-light text-table-cell text-text-secondary">
                  {formatInt(leaderboardQ.data.unattributed_units)} scored{' '}
                  {plural(leaderboardQ.data.unattributed_units, unit, units)}{' '}
                  {plural(leaderboardQ.data.unattributed_units, 'is', 'are')} credited to no adviser, so{' '}
                  {plural(leaderboardQ.data.unattributed_units, 'it is', 'they are')} in the firm&rsquo;s
                  average above but in no row here.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* What has just come through */}
      <div className="bg-card border border-border rounded-card shadow-card overflow-hidden">
        <PanelHeader
          title={mode === 'sales' ? 'What has just come through' : 'The latest calls'}
          measure={mode === 'sales' ? 'The five most recent sales, newest first' : 'The five most recent calls, newest first'}
          linkTo={mode === 'sales' ? '/journeys' : '/calls'}
          linkLabel={mode === 'sales' ? 'View all sales' : 'View all calls'}
        />
        {recentQ.isError ? (
          <LoadError what={mode === 'sales' ? 'recent sales' : 'recent calls'} onRetry={() => recentQ.refetch()} />
        ) : mode === 'sales' ? (
          <RecentSales
            rows={recentQ.data?.mode === 'sales' ? recentQ.data.data : undefined}
            loading={recentQ.isLoading}
          />
        ) : (
          <RecentCalls
            rows={recentQ.data?.mode === 'calls' ? recentQ.data.data : undefined}
            loading={recentQ.isLoading}
            canUpload={canUpload}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================

function RecentSales({ rows, loading }: { rows?: RecentSaleRow[]; loading: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px]">
        <caption className="sr-only">The five most recent sales, newest first.</caption>
        <thead>
          <tr>
            <th scope="col" className={TH}>Customer</th>
            <th scope="col" className={TH}>Adviser</th>
            <th scope="col" className={TH}>Score</th>
            <th scope="col" className={TH}>Next step</th>
            <th scope="col" className={TH}>Sale date</th>
          </tr>
        </thead>
        <tbody>
          {loading && Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} cols={5} />)}
          {!loading &&
            rows?.map((row) => {
              const step = saleState(row);
              return (
                <tr key={row.id} className="hover:bg-table-header transition-colors border-b border-border-light last:border-0">
                  <td className="px-5 py-3.5">
                    <Link
                      to={`/journeys/${row.id}`}
                      className="text-primary-ink font-semibold text-table-cell hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                    >
                      {row.customer_name ?? 'Unnamed customer'}
                    </Link>
                  </td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">{row.agent_name ?? '–'}</td>
                  <td className="px-5 py-3.5">
                    {row.overall_score != null ? (
                      <ScoreGauge score={row.overall_score} showBar />
                    ) : (
                      <span className="text-text-muted text-table-cell">Not scored</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-table-cell">
                    <span className="block text-text-primary font-medium">{step.title}</span>
                    {step.detail && <span className="block text-xs text-text-secondary">{step.detail}</span>}
                  </td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell whitespace-nowrap tabular-nums">
                    {shortDate(row.sale_date)}
                  </td>
                </tr>
              );
            })}
          {!loading && (!rows || rows.length === 0) && (
            <tr>
              <td colSpan={5} className="px-5 py-12 text-center text-text-muted text-table-cell">
                No sales yet. They arrive from your CRM as they are closed.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function RecentCalls({
  rows,
  loading,
  canUpload,
}: {
  rows?: RecentCallRow[];
  loading: boolean;
  canUpload: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px]">
        <caption className="sr-only">The five most recent calls, newest first.</caption>
        <thead>
          <tr>
            <th scope="col" className={TH}>Call</th>
            <th scope="col" className={TH}>Adviser</th>
            <th scope="col" className={TH}>Length</th>
            <th scope="col" className={TH}>Score</th>
            <th scope="col" className={TH}>When</th>
          </tr>
        </thead>
        <tbody>
          {loading && Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} cols={5} />)}
          {!loading &&
            rows?.map((row) => (
              <tr key={row.id} className="hover:bg-table-header transition-colors border-b border-border-light last:border-0">
                <td className="px-5 py-3.5">
                  <Link
                    to={`/calls/${row.id}`}
                    className="text-primary-ink font-semibold text-table-cell hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                  >
                    {row.customer_name ?? row.file_name}
                  </Link>
                </td>
                <td className="px-5 py-3.5 text-table-cell text-text-cell">{row.agent_name ?? '–'}</td>
                <td className="px-5 py-3.5 text-table-cell text-text-cell tabular-nums">
                  {formatClock(row.duration_seconds)}
                </td>
                <td className="px-5 py-3.5">
                  {row.overall_score != null ? (
                    <ScoreGauge score={row.overall_score} showBar />
                  ) : (
                    <span className="text-text-muted text-table-cell">Not scored</span>
                  )}
                </td>
                <td className="px-5 py-3.5 text-table-cell text-text-cell whitespace-nowrap tabular-nums">
                  {shortDate(row.called_at)}
                </td>
              </tr>
            ))}
          {!loading && (!rows || rows.length === 0) && (
            <tr>
              <td colSpan={5} className="px-5 py-12 text-center text-text-muted text-table-cell">
                No calls yet. They arrive from your dialler as they&rsquo;re recorded
                {/* A viewer cannot upload, and used to be invited to. */}
                {canUpload && (
                  <>
                    , or you can{' '}
                    <Link to="/calls/upload" className="text-primary-ink font-semibold hover:underline">
                      upload one
                    </Link>
                  </>
                )}
                .
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
