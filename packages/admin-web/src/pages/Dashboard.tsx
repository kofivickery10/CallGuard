import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';

interface DashboardData {
  active_users_15min: number;
  calls_in_queue: number;
  calls_processed_today: number;
  active_live_sessions: number;
  platform_claude_cost_mtd: number;
  platform_deepgram_cost_mtd: number;
  platform_mrr: number;
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-white rounded-card p-5 shadow-sm border border-border">
      <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-1">{label}</p>
      <p className="text-3xl font-bold text-text-primary">{value}</p>
      {sub && <p className="text-xs text-text-muted mt-1">{sub}</p>}
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.get<DashboardData>('/superadmin/dashboard')
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (error) return <p className="text-fail text-sm p-6">{error}</p>;
  if (!data)  return <p className="text-text-muted text-sm p-6">Loading…</p>;

  const totalCostMtd = data.platform_claude_cost_mtd + data.platform_deepgram_cost_mtd;
  const grossMargin = data.platform_mrr - totalCostMtd;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text-primary">Live Dashboard</h1>
        <p className="text-xs text-text-muted">Refreshes every 30 s</p>
      </div>

      {/* Revenue headline */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-card p-5 border border-primary">
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-1">Monthly recurring revenue</p>
          <p className="text-3xl font-bold text-primary">£{data.platform_mrr.toFixed(2)}</p>
          <p className="text-xs text-text-muted mt-1">Active seats × tier/override price</p>
        </div>
        <StatCard label="AI + transcription (MTD)" value={`£${totalCostMtd.toFixed(2)}`} sub="Claude + Deepgram estimate" />
        <StatCard label="Gross margin (MTD)" value={`£${grossMargin.toFixed(2)}`} sub="MRR − running cost" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard label="Active users (15 min)" value={data.active_users_15min} />
        <StatCard label="Calls in queue" value={data.calls_in_queue} />
        <StatCard label="Calls processed today" value={data.calls_processed_today} />
        <StatCard label="Live sessions" value={data.active_live_sessions} />
        <StatCard
          label="Claude cost (MTD)"
          value={`£${data.platform_claude_cost_mtd.toFixed(2)}`}
          sub="Estimated from token usage"
        />
        <StatCard
          label="Deepgram cost (MTD)"
          value={`£${data.platform_deepgram_cost_mtd.toFixed(2)}`}
          sub="Estimated from call duration"
        />
      </div>
    </div>
  );
}
