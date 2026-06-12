import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

interface BillingRow {
  org_id: string;
  org_name: string;
  plan: string;
  month: string;
  active_seats: number;
  seat_price_override: number | null;
  monthly_income: number;
  claude_cost_estimate: number;
  deepgram_cost_estimate: number;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

export default function Billing() {
  const [month, setMonth] = useState(currentMonth());
  const [rows, setRows]   = useState<BillingRow[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ month: string; billing: BillingRow[] }>(`/superadmin/billing?month=${month}`)
      .then((r) => setRows(r.billing))
      .catch((e: Error) => setError(e.message));
  }, [month]);

  const totalSeats = rows.reduce((a, r) => a + r.active_seats, 0);
  const totalIncome = rows.reduce((a, r) => a + r.monthly_income, 0);
  const totalClaude = rows.reduce((a, r) => a + r.claude_cost_estimate, 0);
  const totalDeepgram = rows.reduce((a, r) => a + r.deepgram_cost_estimate, 0);
  const grossMargin = totalIncome - totalClaude - totalDeepgram;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold text-text-primary">Billing Overview</h1>
        <div className="flex items-center gap-2">
          <label className="text-sm text-text-muted">Month</label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="border border-border rounded-btn px-3 py-1.5 text-sm"
          />
        </div>
      </div>

      {error && <p className="text-fail text-sm">{error}</p>}

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Monthly income',        value: `£${totalIncome.toFixed(2)}`, accent: true },
          { label: 'Total active seats',    value: String(totalSeats) },
          { label: 'AI/transcription cost', value: `£${(totalClaude + totalDeepgram).toFixed(2)}` },
          { label: 'Gross margin',          value: `£${grossMargin.toFixed(2)}` },
        ].map(({ label, value, accent }) => (
          <div key={label} className={`bg-white rounded-card p-4 border ${accent ? 'border-primary' : 'border-border'}`}>
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-1">{label}</p>
            <p className={`text-2xl font-bold ${accent ? 'text-primary' : 'text-text-primary'}`}>{value}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-card border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-border">
            <tr>
              {['Organisation', 'Plan', 'Active seats', 'Monthly income', 'Claude est.', 'Deepgram est.', ''].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.org_id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-text-primary">{r.org_name}</td>
                <td className="px-4 py-3 capitalize text-text-secondary">{r.plan}</td>
                <td className="px-4 py-3 text-text-secondary">{r.active_seats}</td>
                <td className="px-4 py-3 font-semibold text-text-primary">
                  £{r.monthly_income.toFixed(2)}
                  {r.seat_price_override != null && (
                    <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                      £{r.seat_price_override.toFixed(0)}/seat
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-text-secondary">£{r.claude_cost_estimate.toFixed(2)}</td>
                <td className="px-4 py-3 text-text-secondary">£{r.deepgram_cost_estimate.toFixed(2)}</td>
                <td className="px-4 py-3">
                  <Link to={`/tenants/${r.org_id}`} className="text-primary hover:underline text-xs font-medium">
                    Detail
                  </Link>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-text-muted">
                  No data for {month}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
