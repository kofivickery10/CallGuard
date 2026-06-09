import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { api } from '../api/client';

interface Overview {
  tenants: { total: number; active: number };
  usage: {
    total_users: number;
    active_agents: number;
    scored_today: number;
    scored_week: number;
    scored_month: number;
  };
  pass_rate: { current: number | null; previous: number | null; improvement: number | null };
  jobs: {
    available: boolean;
    totals: { active: number; waiting: number; delayed: number; failed: number } | null;
    by_queue: Record<string, { active?: number; waiting?: number; delayed?: number; failed?: number }> | null;
  };
}
interface PassRatePoint { bucket: string; scored: number; pass_rate: string | number }

type Bucket = 'day' | 'week' | 'month';

export function SuperadminOverview() {
  const [bucket, setBucket] = useState<Bucket>('day');

  const { data: ov } = useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => api.get<Overview>('/admin/overview'),
    refetchInterval: 15000,
  });
  const { data: series } = useQuery({
    queryKey: ['admin-pass-rate', bucket],
    queryFn: () => api.get<{ bucket: string; data: PassRatePoint[] }>(`/admin/pass-rate?bucket=${bucket}`),
  });

  const fmt = (dateStr: string) => {
    // Server returns a plain YYYY-MM-DD (UK-local bucket start); render in UTC
    // so the label matches the date string exactly (no extra tz shift).
    const d = new Date(`${dateStr}T00:00:00Z`);
    if (bucket === 'month') return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  };
  const chartData = (series?.data ?? []).map((p) => ({
    label: fmt(p.bucket),
    pass_rate: Number(p.pass_rate),
    scored: p.scored,
  }));

  const imp = ov?.pass_rate.improvement;

  return (
    <div className="max-w-[1100px]">
      <div className="mb-5">
        <h2 className="text-page-title text-text-primary">Platform overview</h2>
        <p className="text-page-sub text-text-subtle mt-1">
          Aggregate metrics across all tenants. No call content, transcripts or personal data is shown here.
        </p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Kpi label="Tenants" value={ov?.tenants.total ?? '—'} sub={`${ov?.tenants.active ?? 0} active (30d)`} />
        <Kpi label="Active agents (mo)" value={ov?.usage.active_agents ?? '—'} sub={`${ov?.usage.total_users ?? 0} users total`} />
        <Kpi label="Calls scored (mo)" value={ov?.usage.scored_month ?? '—'} sub={`${ov?.usage.scored_today ?? 0} today · ${ov?.usage.scored_week ?? 0} this wk`} />
        <Kpi
          label="Pass rate (30d)"
          value={ov?.pass_rate.current != null ? `${ov.pass_rate.current}%` : '—'}
          sub={
            imp == null
              ? 'no prior period'
              : `${imp >= 0 ? '▲' : '▼'} ${Math.abs(imp)} pts vs prev 30d`
          }
          subTone={imp == null ? 'muted' : imp >= 0 ? 'pass' : 'fail'}
        />
      </div>

      {/* Pass-rate trend */}
      <div className="bg-white border border-border rounded-card p-5 mb-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[13px] uppercase tracking-wider text-text-muted font-semibold">Pass rate trend</h3>
          <div className="flex gap-1">
            {(['day', 'week', 'month'] as Bucket[]).map((b) => (
              <button
                key={b}
                onClick={() => setBucket(b)}
                className={`px-2.5 py-1 rounded-btn text-[12px] font-medium capitalize transition-colors ${
                  bucket === b ? 'bg-primary-light text-pass font-semibold' : 'text-text-muted hover:bg-sidebar-hover'
                }`}
              >
                {b === 'day' ? 'Daily' : b === 'week' ? 'Weekly' : 'Monthly'}
              </button>
            ))}
          </div>
        </div>
        <div style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f5f0" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8a9e8a' }} tickLine={false} axisLine={{ stroke: '#e2e8e2' }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#8a9e8a' }} tickLine={false} axisLine={false} unit="%" width={44} />
              <Tooltip
                formatter={(value, name) => (name === 'pass_rate' ? [`${value}%`, 'Pass rate'] : [String(value), 'Scored'])}
                contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8e2' }}
              />
              <Line type="monotone" dataKey="pass_rate" stroke="#4a9e6e" strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Processing jobs */}
      <div className="bg-white border border-border rounded-card p-5">
        <h3 className="text-[13px] uppercase tracking-wider text-text-muted font-semibold mb-3">Processing jobs (live)</h3>
        {!ov?.jobs.available || !ov.jobs.totals ? (
          <p className="text-[12px] text-text-muted">Queue metrics unavailable (Redis not reachable).</p>
        ) : (
          <>
            <div className="flex gap-6 mb-4">
              <JobStat label="Active" value={ov.jobs.totals.active} tone={ov.jobs.totals.active > 0 ? 'processing' : 'muted'} />
              <JobStat label="Waiting" value={ov.jobs.totals.waiting} tone={ov.jobs.totals.waiting > 0 ? 'review' : 'muted'} />
              <JobStat label="Delayed" value={ov.jobs.totals.delayed} tone="muted" />
              <JobStat label="Failed" value={ov.jobs.totals.failed} tone={ov.jobs.totals.failed > 0 ? 'fail' : 'muted'} />
            </div>
            <div className="border-t border-border-light pt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
              {ov.jobs.by_queue &&
                Object.entries(ov.jobs.by_queue).map(([name, c]) => (
                  <div key={name} className="text-[12px]">
                    <div className="font-semibold text-text-primary capitalize">{name}</div>
                    <div className="text-text-muted mt-0.5">
                      {(c.active || 0)} active · {(c.waiting || 0)} queued
                      {(c.failed || 0) > 0 && <span className="text-fail"> · {c.failed} failed</span>}
                    </div>
                  </div>
                ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, subTone = 'muted' }: { label: string; value: number | string; sub?: string; subTone?: 'muted' | 'pass' | 'fail' }) {
  const tone = subTone === 'pass' ? 'text-pass' : subTone === 'fail' ? 'text-fail' : 'text-text-muted';
  return (
    <div className="bg-white border border-border rounded-card p-4">
      <div className="text-card-label uppercase text-text-muted">{label}</div>
      <div className="text-card-value text-text-primary mt-1">{value}</div>
      {sub && <div className={`text-[11px] mt-1 ${tone}`}>{sub}</div>}
    </div>
  );
}

function JobStat({ label, value, tone }: { label: string; value: number; tone: 'processing' | 'review' | 'fail' | 'muted' }) {
  const color =
    tone === 'processing' ? 'text-processing' : tone === 'review' ? 'text-review' : tone === 'fail' ? 'text-fail' : 'text-text-muted';
  return (
    <div>
      <div className={`text-[24px] font-bold leading-none ${color}`}>{value}</div>
      <div className="text-[11px] text-text-muted mt-1">{label}</div>
    </div>
  );
}
