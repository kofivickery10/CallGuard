import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useTableControls, SortHead, TablePagination, TableSearch } from '../components/DataTable';

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

  const table = useTableControls(rows, {
    initialSortKey: 'monthly_income',
    initialSortDir: 'desc',
    searchFields: ['org_name', 'plan'],
    pageSize: 25,
    sortValue: (r, key) => {
      const cost = r.claude_cost_estimate + r.deepgram_cost_estimate;
      switch (key) {
        case 'active_seats': return r.active_seats;
        case 'monthly_income': return r.monthly_income;
        case 'cost': return cost;
        case 'margin': return r.monthly_income - cost;
        default: return String(r[key as keyof BillingRow] ?? '').toLowerCase();
      }
    },
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-page-title text-text-primary">Billing Overview</h2>
        <div className="flex items-center gap-2">
          <TableSearch value={table.search} onChange={table.setSearch} placeholder="Search tenants…" />
          <label className="text-sm text-text-muted">Month</label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="border border-border rounded-btn px-3 py-1.5 text-sm bg-card text-text-primary focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
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
          <div key={label} className={`bg-card rounded-card p-4 border ${accent ? 'border-primary' : 'border-border'}`}>
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-1">{label}</p>
            <p className={`text-card-value ${accent ? 'text-primary' : 'text-text-primary'}`}>{value}</p>
          </div>
        ))}
      </div>

      <div className="bg-card rounded-card border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-table-header border-b border-border">
            <tr>
              <SortHead label="Organisation" columnKey="org_name" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
              <SortHead label="Plan" columnKey="plan" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
              <SortHead label="Active seats" columnKey="active_seats" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
              <SortHead label="Monthly income" columnKey="monthly_income" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
              <SortHead label="Running cost" columnKey="cost" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
              <SortHead label="Margin" columnKey="margin" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {table.pageRows.map((r) => {
              const cost = r.claude_cost_estimate + r.deepgram_cost_estimate;
              const margin = r.monthly_income - cost;
              // Flag tenants whose processing cost has eaten most of their seat
              // revenue (or who run cost with no income at all).
              const loss = margin < 0;
              const thin = !loss && r.monthly_income > 0 && cost / r.monthly_income > 0.5;
              const noIncome = r.monthly_income === 0 && cost > 0;
              const alert = loss || noIncome;
              return (
                <tr key={r.org_id} className={`hover:bg-sidebar-hover ${alert ? 'bg-fail-bg/40' : ''}`}>
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
                  <td className="px-4 py-3 text-text-secondary" title={`Claude £${r.claude_cost_estimate.toFixed(2)} · Deepgram £${r.deepgram_cost_estimate.toFixed(2)}`}>
                    £{cost.toFixed(2)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`font-semibold ${loss ? 'text-fail' : thin ? 'text-review' : 'text-pass'}`}>£{margin.toFixed(2)}</span>
                    {alert && (
                      <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider text-fail bg-fail-bg px-1.5 py-0.5 rounded">
                        {noIncome ? 'cost, no income' : 'loss'}
                      </span>
                    )}
                    {thin && (
                      <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider text-review bg-review-bg px-1.5 py-0.5 rounded">thin</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Link to={`/tenants/${r.org_id}`} className="text-primary hover:underline text-xs font-medium">
                      Detail
                    </Link>
                  </td>
                </tr>
              );
            })}
            {table.total === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-text-muted">
                  {rows.length === 0 ? `No data for ${month}` : 'No tenants match your search'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <TablePagination page={table.page} totalPages={table.totalPages} total={table.total} onPage={table.setPage} noun="tenants" />
      </div>
    </div>
  );
}
