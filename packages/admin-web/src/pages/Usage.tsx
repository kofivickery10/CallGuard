import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { DateRangePicker } from '../components/DateRangePicker';
import { type DateRange, formatDay, formatRange, rangeQuery } from '../lib/dateRange';

interface UsageReport {
  period_days: number;
  from: string;
  to: string;
  totals: {
    cost_gbp: number;
    events: number;
    scored_calls: number;
    scored_journeys: number;
    scored_units: number;
    cost_per_unit: number;
    cache_hit_ratio: number;
  };
  by_provider: { provider: string; events: number; cost_gbp: number }[];
  by_operation: {
    operation: string; events: number;
    input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_creation_tokens: number;
    cost_gbp: number;
  }[];
  by_model: { model_id: string; events: number; input_tokens: number; output_tokens: number; cost_gbp: number }[];
  daily: { day: string; cost_gbp: number; events: number }[];
  top_tenants: { organization_id: string | null; name: string; cost_gbp: number; events: number }[];
}

const gbp = (n: number) => `£${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
const num = (n: number) => n.toLocaleString();

const OP_LABELS: Record<string, string> = {
  transcribe: 'Transcription (Deepgram)',
  cleanup: 'Transcript cleanup',
  score: 'Scoring',
  verify: 'Breach verify',
  live_score: 'Live scoring',
  insights: 'AI insights',
};

export default function Usage() {
  const [range, setRange] = useState<DateRange>({ days: 30 });
  const [data, setData] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get<UsageReport>(`/superadmin/usage?${rangeQuery(range)}`)
      .then((d) => { setData(d); setError(''); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [range]);

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-page-title text-text-primary">Usage &amp; Costs</h2>
          <p className="text-sm text-text-muted mt-0.5">
            Per-operation spend across Deepgram and Claude, converted to GBP.
            {data && <> Showing {formatRange(data.from, data.to)}.</>}
            {loading && data && <span className="text-text-muted"> Updating…</span>}
          </p>
        </div>
        <DateRangePicker value={range} onChange={setRange} presets={[7, 30, 90]} />
      </div>

      {error && <p className="text-fail text-sm">{error}</p>}
      {loading && !data && <p className="text-text-muted text-sm">Loading…</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card label={`Total cost (${data.period_days}d)`} value={gbp(data.totals.cost_gbp)} accent />
            <Card
              label="Scored in range"
              value={num(data.totals.scored_units)}
              sub={`${num(data.totals.scored_calls)} call${data.totals.scored_calls === 1 ? '' : 's'} · ${num(data.totals.scored_journeys)} sale${data.totals.scored_journeys === 1 ? '' : 's'}`}
            />
            <Card
              label="Cost / scored item"
              value={data.totals.scored_units > 0 ? gbp(data.totals.cost_per_unit) : '—'}
              sub={data.totals.scored_units > 0 ? undefined : 'nothing scored in range'}
            />
            <Card label="Scorecard cache hit" value={`${(data.totals.cache_hit_ratio * 100).toFixed(0)}%`} />
          </div>

          <Section title="Daily cost">
            <DailyChart daily={data.daily} />
          </Section>

          <Section title="By operation">
            {data.by_operation.length === 0 ? <Empty /> : (
              <Table head={['Operation', 'Calls', 'Input tok', 'Output tok', 'Cache read', 'Cost']}>
                {data.by_operation.map((r) => (
                  <tr key={r.operation} className="border-t border-border-light">
                    <td className="py-2 text-text-primary">{OP_LABELS[r.operation] ?? r.operation}</td>
                    <td className="text-text-secondary">{num(r.events)}</td>
                    <td className="text-text-secondary">{num(r.input_tokens)}</td>
                    <td className="text-text-secondary">{num(r.output_tokens)}</td>
                    <td className="text-text-secondary">{num(r.cache_read_tokens)}</td>
                    <td className="text-text-primary font-semibold">{gbp(r.cost_gbp)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>

          <div className="grid md:grid-cols-2 gap-4">
            <Section title="By provider">
              {data.by_provider.length === 0 ? <Empty /> : (
                <Table head={['Provider', 'Calls', 'Cost']}>
                  {data.by_provider.map((r) => (
                    <tr key={r.provider} className="border-t border-border-light">
                      <td className="py-2 text-text-primary capitalize">{r.provider}</td>
                      <td className="text-text-secondary">{num(r.events)}</td>
                      <td className="text-text-primary font-semibold">{gbp(r.cost_gbp)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Section>
            <Section title="By model">
              {data.by_model.length === 0 ? <Empty /> : (
                <Table head={['Model', 'Calls', 'Cost']}>
                  {data.by_model.map((r) => (
                    <tr key={r.model_id} className="border-t border-border-light">
                      <td className="py-2 text-text-primary text-xs">{r.model_id}</td>
                      <td className="text-text-secondary">{num(r.events)}</td>
                      <td className="text-text-primary font-semibold">{gbp(r.cost_gbp)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Section>
          </div>

          <Section title="Top tenants by cost">
            {data.top_tenants.length === 0 ? <Empty /> : (
              <Table head={['Tenant', 'Calls', 'Cost']}>
                {data.top_tenants.map((r) => (
                  <tr key={r.organization_id ?? 'platform'} className="border-t border-border-light">
                    <td className="py-2 text-text-primary">{r.name}</td>
                    <td className="text-text-secondary">{num(r.events)}</td>
                    <td className="text-text-primary font-semibold">{gbp(r.cost_gbp)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Card({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`bg-card rounded-card p-4 border ${accent ? 'border-primary' : 'border-border'}`}>
      <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-1">{label}</p>
      <p className={`text-card-value ${accent ? 'text-primary' : 'text-text-primary'}`}>{value}</p>
      {sub && <p className="text-xs text-text-muted mt-1">{sub}</p>}
    </div>
  );
}

/**
 * One bar per day in the window, including the zero days — the API zero-fills the
 * series, so gaps are visible instead of being closed up. Quiet days keep a
 * hairline so the axis reads as a timeline rather than a set of floating bars.
 */
function DailyChart({ daily }: { daily: { day: string; cost_gbp: number; events: number }[] }) {
  const first = daily[0];
  const last = daily[daily.length - 1];
  if (!first || !last) return <Empty />;

  const max = Math.max(...daily.map((d) => d.cost_gbp));
  const total = daily.reduce((sum, d) => sum + d.cost_gbp, 0);
  if (max <= 0) return <Empty />;

  const peak = daily.reduce((a, b) => (b.cost_gbp > a.cost_gbp ? b : a));
  const middle = daily[Math.floor((daily.length - 1) / 2)] ?? first;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-xs text-text-muted">
        <span>Peak <span className="text-text-primary font-semibold">{gbp(max)}</span> on {formatDay(peak.day)}</span>
        <span><span className="text-text-primary font-semibold">{gbp(total)}</span> across {daily.length} day{daily.length === 1 ? '' : 's'}</span>
      </div>

      <div
        className="flex items-end gap-px h-28"
        role="img"
        aria-label={`Daily cost from ${formatDay(first.day)} to ${formatDay(last.day)}. Total ${gbp(total)}, peak ${gbp(max)} on ${formatDay(peak.day)}.`}
      >
        {daily.map((d) => (
          <div
            key={d.day}
            className="flex-1 min-w-[2px] h-full flex flex-col justify-end"
            title={`${formatDay(d.day)}: ${gbp(d.cost_gbp)} · ${num(d.events)} operation${d.events === 1 ? '' : 's'}`}
          >
            {d.cost_gbp > 0 ? (
              <div
                className="w-full bg-primary rounded-t"
                style={{ height: `${Math.max(3, (d.cost_gbp / max) * 100)}%` }}
              />
            ) : (
              <div className="w-full h-px bg-border" />
            )}
          </div>
        ))}
      </div>

      <div className="flex justify-between text-[11px] text-text-muted">
        <span>{formatDay(first.day)}</span>
        {daily.length > 2 && <span>{formatDay(middle.day)}</span>}
        {daily.length > 1 && <span>{formatDay(last.day)}</span>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-card rounded-card border border-border p-5">
      <h3 className="text-xs uppercase tracking-wider text-text-muted font-semibold mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table className="w-full text-sm text-left">
      <thead>
        <tr className="text-xs uppercase tracking-wider text-text-muted">
          {head.map((h) => (
            <th key={h} className="pb-2 font-semibold">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Empty() {
  return <p className="text-text-muted text-sm">No usage recorded in this range.</p>;
}
