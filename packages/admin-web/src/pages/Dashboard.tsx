import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { DateRangePicker } from '../components/DateRangePicker';
import FailedJobsModal from '../components/FailedJobsModal';
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
  /** Whole retained failed set — BullMQ keeps these indefinitely, so it is history, not a live signal. */
  failed: number;
  /** Failures in the last hour. This is what "something is wrong now" looks like. */
  failed_recent: number;
  failed_recent_capped: boolean;
  last_completed_at: string | null;
  error?: boolean;
}
interface WorkerHealth {
  /** null = this API build doesn't report liveness. Distinct from false, which means genuinely down. */
  ok: boolean | null;
  last_beat_at: string | null;
  age_seconds: number | null;
  detail?: string;
}
interface StuckSummary {
  calls: number;
  journeys: number;
  by_status: Record<string, number>;
  oldest_at: string | null;
}
interface HealthData {
  redis_ok: boolean;
  worker: WorkerHealth;
  queues: QueueStat[];
  stuck: StuckSummary;
}

// A queue is unhealthy if its infrastructure is down, it errored, something
// failed in the last hour, or work is waiting but nothing has completed in the
// last 10 minutes. Deliberately NOT keyed on the retained `failed` total: those
// jobs never expire, so any past failure used to pin the card red forever.
function queueWarning(redisOk: boolean, workerOk: boolean | null, q: QueueStat): boolean {
  // workerOk === null is "not reported", which is not evidence of a fault.
  if (!redisOk || workerOk === false || q.error) return true;
  if (q.failed_recent > 0) return true;
  if (q.waiting > 0 && q.last_completed_at) {
    return Date.now() - new Date(q.last_completed_at).getTime() > 10 * 60 * 1000;
  }
  return q.waiting > 0 && !q.last_completed_at;
}

// The admin console is hosted separately from the API, so a deploy can leave a
// new bundle talking to an older API (or the reverse). Fill in every field the
// panel reads, rather than letting one missing object throw and blank the whole
// health strip — the one screen you need most when a deploy has gone wrong.
function normaliseHealth(h: Partial<HealthData>): HealthData {
  return {
    redis_ok: h.redis_ok ?? false,
    // Unknown, not down — an older API simply doesn't report it, and crying
    // "worker down" at a healthy system is its own kind of broken panel.
    worker: h.worker ?? {
      ok: null,
      last_beat_at: null,
      age_seconds: null,
      detail: 'This API build does not report worker liveness.',
    },
    queues: (h.queues ?? []).map((q) => ({
      ...q,
      failed: q.failed ?? 0,
      failed_recent: q.failed_recent ?? 0,
      failed_recent_capped: q.failed_recent_capped ?? false,
    })),
    stuck: h.stuck ?? { calls: 0, journeys: 0, by_status: {}, oldest_at: null },
  };
}

// "transcribed" → "2 transcribed", "journey:pending" → "1 sale pending".
function describeStuck(byStatus: Record<string, number>): string {
  return Object.entries(byStatus)
    .map(([key, n]) => (key.startsWith('journey:') ? `${n} sale ${key.slice(8)}` : `${n} ${key}`))
    .join(', ');
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
  const [healthError, setHealthError] = useState('');
  const [error, setError] = useState('');
  const [failedQueue, setFailedQueue] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairNote, setRepairNote] = useState('');

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
    // Health failing is reported in place rather than silently blanking the
    // panel — an unreachable health endpoint is itself a health signal.
    api.get<Partial<HealthData>>('/superadmin/health')
      .then((h) => {
        setHealth(normaliseHealth(h));
        setHealthError('');
      })
      .catch((e: Error) => setHealthError(e.message));
  }, [range]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const runRepair = async () => {
    setRepairing(true);
    setRepairNote('');
    try {
      await api.post('/superadmin/maintenance/stuck-repair', {});
      setRepairNote('Repair sweep queued. The counts update as the worker picks the jobs up.');
      // Give the worker a moment to drain before re-reading the counts.
      setTimeout(load, 5_000);
    } catch (err) {
      setRepairNote(err instanceof Error ? err.message : 'Could not queue the repair sweep');
    } finally {
      setRepairing(false);
    }
  };

  if (error) return <p className="text-fail text-sm p-6">{error}</p>;
  if (!data)  return <p className="text-text-muted text-sm p-6">Loading…</p>;

  const stuckTotal = health ? health.stuck.calls + health.stuck.journeys : 0;

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
      {healthError && !health && (
        <div className="bg-card rounded-card border border-border p-5">
          <h2 className="text-section-title text-text-primary mb-1">System health</h2>
          <p className="text-table-cell text-fail">Could not read system health: {healthError}</p>
        </div>
      )}
      {health && (
        <div className="bg-card rounded-card border border-border p-5">
          <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
            <h2 className="text-section-title text-text-primary">System health</h2>
            <div className="flex items-center gap-4 text-badge">
              <span className="flex items-center gap-1.5 text-text-secondary">
                <span
                  className={`w-2 h-2 rounded-full ${
                    health.worker.ok === null ? 'bg-text-muted' : health.worker.ok ? 'bg-pass' : 'bg-fail'
                  }`}
                />
                {health.worker.ok === null
                  ? 'Worker status unknown'
                  : health.worker.ok
                    ? `Worker up${health.worker.age_seconds !== null ? ` · beat ${health.worker.age_seconds}s ago` : ''}`
                    : `Worker down${health.worker.age_seconds !== null ? ` · last beat ${health.worker.age_seconds}s ago` : ''}`}
              </span>
              <span className="flex items-center gap-1.5 text-text-secondary">
                <span className={`w-2 h-2 rounded-full ${health.redis_ok ? 'bg-pass' : 'bg-fail'}`} />
                Redis {health.redis_ok ? 'up' : 'down'}
              </span>
            </div>
          </div>

          {/* Health loaded once and is now failing to refresh. Say so, rather
              than leaving frozen numbers that read as a healthy quiet system —
              the exact way this panel used to mislead. */}
          {healthError && (
            <div className="rounded-btn border border-review bg-review-bg p-3 mb-3">
              <p className="text-table-cell text-text-primary font-semibold">
                These figures are stale — the last refresh failed.
              </p>
              <p className="text-badge text-text-secondary mt-0.5">{healthError}</p>
            </div>
          )}

          {/* A dead worker is the one fault that makes every other number
              meaningless — say so outright rather than leaving four idle-looking
              queue cards to imply everything is fine. */}
          {health.worker.ok === false && (
            <div className="rounded-btn border border-fail bg-fail-bg p-3 mb-3">
              <p className="text-table-cell text-fail font-semibold">
                No worker heartbeat — nothing is being transcribed or scored.
              </p>
              <p className="text-badge text-text-secondary mt-0.5">
                {health.worker.detail ?? 'The worker process is down or cannot reach Redis. Check pm2 (callguard-worker).'}
              </p>
            </div>
          )}

          {/* Stuck work, with the fix one click away. Everything counted here is
              something the repair sweep can actually re-enqueue. */}
          <div className={`rounded-btn border p-3 mb-3 ${stuckTotal > 0 ? 'border-review bg-review-bg' : 'border-border-light bg-page'}`}>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                {stuckTotal > 0 ? (
                  <>
                    <p className="text-table-cell text-text-primary font-semibold">
                      {stuckTotal} item{stuckTotal === 1 ? '' : 's'} stuck ({describeStuck(health.stuck.by_status)})
                    </p>
                    <p className="text-badge text-text-secondary mt-0.5">
                      Oldest {health.stuck.oldest_at ? new Date(health.stuck.oldest_at).toLocaleString('en-GB') : 'unknown'}.
                      The repair sweep runs every 10 minutes and re-enqueues these.
                    </p>
                  </>
                ) : (
                  <p className="text-table-cell text-text-secondary">
                    No stuck work. Calls resting for a sale trigger are not counted.
                  </p>
                )}
              </div>
              <button
                onClick={runRepair}
                disabled={repairing}
                aria-label="Run the stuck-work repair sweep now"
                className="text-badge px-3 py-1.5 rounded-btn border border-border text-text-secondary font-semibold hover:bg-sidebar-hover disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {repairing ? 'Repairing…' : 'Run repair now'}
              </button>
            </div>
            {repairNote && <p className="text-badge text-text-muted mt-2">{repairNote}</p>}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            {health.queues.map((q) => {
              const warn = queueWarning(health.redis_ok, health.worker.ok, q);
              return (
                <div key={q.name} className={`rounded-btn p-3 border ${warn ? 'border-fail bg-fail-bg' : 'border-border-light bg-page'}`}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className={`w-2 h-2 rounded-full ${warn ? 'bg-fail' : 'bg-pass'}`} />
                    <span className="text-badge capitalize text-text-primary">{q.name}</span>
                  </div>
                  <p className="text-badge font-normal text-text-muted">
                    {q.active} active · {q.waiting} waiting
                    {q.delayed > 0 && ` · ${q.delayed} delayed`}
                  </p>
                  {q.failed_recent > 0 && (
                    <p className="text-badge text-fail mt-0.5">
                      {q.failed_recent}{q.failed_recent_capped ? '+' : ''} failed in the last hour
                    </p>
                  )}
                  <p className="text-badge font-normal text-text-muted mt-0.5">
                    {q.last_completed_at ? `last done ${new Date(q.last_completed_at).toLocaleTimeString('en-GB')}` : 'no completed jobs'}
                  </p>
                  {q.failed > 0 && (
                    <button
                      onClick={() => setFailedQueue(q.name)}
                      aria-label={`Inspect ${q.failed} retained failed jobs on the ${q.name} queue`}
                      className="text-badge font-normal text-text-secondary underline underline-offset-2 mt-1 hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary rounded"
                    >
                      {q.failed} retained failure{q.failed === 1 ? '' : 's'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {failedQueue && (
        <FailedJobsModal
          queue={failedQueue}
          onClose={() => setFailedQueue(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
