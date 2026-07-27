import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { DateRangePicker } from '../components/DateRangePicker';
import { type DateRange, formatRange, rangeQuery } from '../lib/dateRange';

interface RangeStats {
  from: string;
  to: string;
  days: number;
  claude_cost_gbp: number;
  deepgram_cost_gbp: number;
  total_cost_gbp: number;
  scored_calls: number;
  scored_journeys: number;
  calls_ingested: number;
}

interface DashboardData {
  active_users_15min: number;
  calls_in_queue: number;
  scored_today: number;
  active_live_sessions: number;
  platform_claude_cost_mtd: number;
  platform_deepgram_cost_mtd: number;
  platform_mrr: number;
  range: RangeStats | null;
}

interface QueueStat {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  last_completed_at: string | null;
  error?: boolean;
}
interface HealthData {
  redis_ok: boolean;
  queues: QueueStat[];
  stuck_calls: number;
}

// A queue is unhealthy if Redis is down, the queue errored, jobs are stuck,
// or work is waiting but nothing has completed in the last 10 minutes.
function queueWarning(redisOk: boolean, q: QueueStat): boolean {
  if (!redisOk || q.error) return true;
  if (q.failed > 0) return true;
  if (q.waiting > 0 && q.last_completed_at) {
    return Date.now() - new Date(q.last_completed_at).getTime() > 10 * 60 * 1000;
  }
  return q.waiting > 0 && !q.last_completed_at;
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-card rounded-card p-5 shadow-sm border border-border">
      <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-1">{label}</p>
      <p className="text-card-value text-text-primary">{value}</p>
      {sub && <p className="text-xs text-text-muted mt-1">{sub}</p>}
    </div>
  );
}

export default function Dashboard() {
  const [range, setRange] = useState<DateRange>({ days: 7 });
  const [data, setData] = useState<DashboardData | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.get<DashboardData>(`/superadmin/dashboard?${rangeQuery(range)}`)
      // Default every numeric field so an older/partial API response degrades to
      // zeros rather than throwing on .toFixed() and blanking the page.
      .then((d) => setData({
        active_users_15min:         d.active_users_15min ?? 0,
        calls_in_queue:             d.calls_in_queue ?? 0,
        scored_today:               d.scored_today ?? 0,
        active_live_sessions:       d.active_live_sessions ?? 0,
        platform_claude_cost_mtd:   d.platform_claude_cost_mtd ?? 0,
        platform_deepgram_cost_mtd: d.platform_deepgram_cost_mtd ?? 0,
        platform_mrr:               d.platform_mrr ?? 0,
        range:                      d.range ?? null,
      }))
      .catch((e: Error) => setError(e.message));
    api.get<HealthData>('/superadmin/health')
      .then(setHealth)
      .catch(() => setHealth(null));
  }, [range]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (error) return <p className="text-fail text-sm p-6">{error}</p>;
  if (!data)  return <p className="text-text-muted text-sm p-6">Loading…</p>;

  const totalCostMtd = data.platform_claude_cost_mtd + data.platform_deepgram_cost_mtd;
  const grossMargin = data.platform_mrr - totalCostMtd;

  const r = data.range;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-page-title text-text-primary">Live Dashboard</h2>
        <p className="text-xs text-text-muted">Refreshes every 30 s</p>
      </div>

      {/* Revenue headline — always month-to-date, so MRR and cost are comparable */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-card rounded-card p-5 border border-primary">
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-1">Monthly recurring revenue</p>
          <p className="text-card-value text-primary">£{data.platform_mrr.toFixed(2)}</p>
          <p className="text-xs text-text-muted mt-1">Active seats × tier/override price</p>
        </div>
        <StatCard label="AI + transcription (MTD)" value={`£${totalCostMtd.toFixed(2)}`} sub="Claude + Deepgram estimate" />
        <StatCard label="Gross margin (MTD)" value={`£${grossMargin.toFixed(2)}`} sub="MRR − running cost" />
      </div>

      {/* Right now */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Active users (15 min)" value={data.active_users_15min} />
        <StatCard label="Calls in queue" value={data.calls_in_queue} />
        <StatCard label="Scored today" value={data.scored_today} sub="Calls + sales scored" />
        <StatCard label="Live sessions" value={data.active_live_sessions} />
      </div>

      {/* Selected range */}
      <div className="space-y-3">
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Selected range</h3>
            <p className="text-xs text-text-muted mt-0.5">
              {r ? formatRange(r.from, r.to) : 'Choose a range'}
            </p>
          </div>
          <DateRangePicker value={range} onChange={setRange} presets={[1, 7, 30]} />
        </div>

        {r && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <StatCard label="Cost in range" value={`£${r.total_cost_gbp.toFixed(2)}`} sub="Claude + Deepgram" />
            <StatCard label="Claude" value={`£${r.claude_cost_gbp.toFixed(2)}`} sub="Scoring, cleanup, insights" />
            <StatCard label="Deepgram" value={`£${r.deepgram_cost_gbp.toFixed(2)}`} sub="Transcription" />
            <StatCard
              label="Scored in range"
              value={r.scored_calls + r.scored_journeys}
              sub={`${r.scored_calls} call${r.scored_calls === 1 ? '' : 's'} · ${r.scored_journeys} sale${r.scored_journeys === 1 ? '' : 's'}`}
            />
            <StatCard label="Calls ingested" value={r.calls_ingested} sub="New audio received" />
          </div>
        )}
      </div>

      {/* System health */}
      {health && (
        <div className="bg-card rounded-card border border-border p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-text-primary">System health</h2>
            <div className="flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${health.redis_ok ? 'bg-pass' : 'bg-fail'}`} />
                Redis {health.redis_ok ? 'up' : 'down'}
              </span>
              {health.stuck_calls > 0 && (
                <span className="text-fail font-semibold">{health.stuck_calls} call{health.stuck_calls === 1 ? '' : 's'} stuck &gt;15 min</span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {health.queues.map((q) => {
              const warn = queueWarning(health.redis_ok, q);
              return (
                <div key={q.name} className={`rounded-btn p-3 border ${warn ? 'border-fail bg-fail-bg' : 'border-border-light bg-page'}`}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className={`w-2 h-2 rounded-full ${warn ? 'bg-fail' : 'bg-pass'}`} />
                    <span className="text-xs font-semibold capitalize text-text-primary">{q.name}</span>
                  </div>
                  <p className="text-xs text-text-muted">
                    {q.active} active · {q.waiting} waiting{q.failed > 0 && <span className="text-fail font-semibold"> · {q.failed} failed</span>}
                  </p>
                  <p className="text-[11px] text-text-muted mt-0.5">
                    {q.last_completed_at ? `last done ${new Date(q.last_completed_at).toLocaleTimeString('en-GB')}` : 'no completed jobs'}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
