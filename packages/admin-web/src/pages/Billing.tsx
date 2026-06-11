import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

interface BillingRow {
  org_id: string;
  org_name: string;
  plan: string;
  month: string;
  active_seats: number;
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
  const totalClaude = rows.reduce((a, r) => a + r.claude_cost_estimate, 0);
  const totalDeepgram = rows.reduce((a, r) => a + r.deepgram_cost_estimate, 0);

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
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Total active seats',    value: totalSeats },
          { label: 'Claude cost estimate',  value: `£${totalClaude.toFixed(2)}` },
          { label: 'Deepgram cost estimate', value: `£${totalDeepgram.toFixed(2)}` },
        ].map(({ label, value }) => (
          <div key={label} className="bg-white rounded-card p-4 border border-border">
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-1">{label}</p>
            <p className="text-2xl font-bold text-text-primary">{value}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-card border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-border">
            <tr>
              {['Organisation', 'Plan', 'Active seats', 'Claude est.', 'Deepgram est.', 'Total est.', ''].map((h) => (
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
                <td className="px-4 py-3 text-text-secondary">£{r.claude_cost_estimate.toFixed(2)}</td>
                <td className="px-4 py-3 text-text-secondary">£{r.deepgram_cost_estimate.toFixed(2)}</td>
                <td className="px-4 py-3 font-medium text-text-primary">
                  £{(r.claude_cost_estimate + r.deepgram_cost_estimate).toFixed(2)}
                </td>
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
