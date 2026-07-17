import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';

interface UsageReport {
  period_days: number;
  totals: {
    cost_gbp: number;
    events: number;
    scored_calls: number;
    cost_per_call: number;
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
  daily: { day: string; cost_gbp: number }[];
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
  const [days, setDays] = useState(30);
  const [data, setData] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get<UsageReport>(`/superadmin/usage?days=${days}`)
      .then((d) => { setData(d); setError(''); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [days]);

  const maxDaily = data && data.daily.length ? Math.max(...data.daily.map((d) => d.cost_gbp), 0.0001) : 1;

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-page-title text-text-primary">Usage &amp; Costs</h2>
          <p className="text-sm text-text-muted mt-0.5">
            Live per-operation spend across Deepgram and Claude, converted to GBP.
          </p>
        </div>
        <div className="flex gap-1">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1.5 rounded-btn text-sm border ${
                days === d
                  ? 'border-primary bg-primary text-white font-semibold'
                  : 'border-border text-text-secondary hover:border-primary'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-fail text-sm">{error}</p>}
      {loading && !data && <p className="text-text-muted text-sm">Loading…</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card label={`Total cost (${data.period_days}d)`} value={gbp(data.totals.cost_gbp)} accent />
            <Card label="Scored calls" value={num(data.totals.scored_calls)} />
            <Card label="Cost / scored call" value={gbp(data.totals.cost_per_call)} />
            <Card label="Scorecard cache hit" value={`${(data.totals.cache_hit_ratio * 100).toFixed(0)}%`} />
          </div>

          <Section title="Daily cost">
            {data.daily.length === 0 ? (
              <Empty />
            ) : (
              <div className="flex items-end gap-1 h-28">
                {data.daily.map((d) => (
                  <div
                    key={d.day}
                    className="flex-1 flex flex-col justify-end"
                    title={`${d.day}: ${gbp(d.cost_gbp)}`}
                  >
                    <div
                      className="w-full bg-primary rounded-t"
                      style={{ height: `${Math.max(2, (d.cost_gbp / maxDaily) * 100)}%` }}
                    />
                  </div>
                ))}
              </div>
            )}
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

function Card({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`bg-card rounded-card p-4 border ${accent ? 'border-primary' : 'border-border'}`}>
      <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-1">{label}</p>
      <p className={`text-card-value ${accent ? 'text-primary' : 'text-text-primary'}`}>{value}</p>
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
  return <p className="text-text-muted text-sm">No usage recorded yet in this window.</p>;
}
