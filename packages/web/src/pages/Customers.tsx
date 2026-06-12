import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { hasFeature } from '@callguard/shared';

interface Customer {
  id: string;
  phone_normalized: string;
  name: string | null;
  external_crm_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  call_count: number;
  avg_score: string | null;
}

interface CustomersResponse {
  customers: Customer[];
  total: number;
  page: number;
  limit: number;
}

export default function Customers() {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const enabled = hasFeature(user?.organization_plan ?? null, 'customer_journey');

  const params = new URLSearchParams({ page: String(page), limit: '50' });
  if (search) params.set('search', search);

  const { data, isLoading } = useQuery({
    queryKey: ['customers', page, search],
    queryFn: () => api.get<CustomersResponse>(`/customers?${params}`),
    enabled,
  });

  if (!enabled) {
    return (
      <div className="p-6">
        <div className="bg-white border border-border rounded-card p-8 text-center max-w-md mx-auto">
          <p className="text-text-subtle text-table-cell mb-2">Customer journey tracking is available on the Core plan and above.</p>
          {user?.role === 'admin' && (
            <Link to="/settings/organization" className="text-primary font-medium hover:underline text-table-cell">Upgrade plan</Link>
          )}
        </div>
      </div>
    );
  }

  const customers = data?.customers ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-page-title">Customers</h1>
          <p className="text-page-sub text-text-secondary">{total} customer{total !== 1 ? 's' : ''} tracked</p>
        </div>
        <input
          type="search"
          placeholder="Search by name or phone…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="border border-border rounded-btn px-3 py-2 text-table-cell w-64 focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      <div className="bg-white rounded-card border border-border overflow-hidden">
        <table className="w-full">
          <thead className="bg-table-header border-b border-border">
            <tr>
              {['Customer', 'Phone', 'CRM ID', 'Calls', 'Avg score', 'Last seen'].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-table-header uppercase tracking-wider text-text-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-text-muted text-table-cell">Loading…</td></tr>
            )}
            {!isLoading && customers.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-text-muted text-table-cell">No customers yet. They appear when calls with a customer phone are ingested.</td></tr>
            )}
            {customers.map((c) => {
              const score = c.avg_score ? parseFloat(c.avg_score) : null;
              const scoreClass = score === null ? 'text-text-muted' : score >= 70 ? 'text-pass font-semibold' : 'text-fail font-semibold';
              return (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link to={`/customers/${c.id}`} className="text-primary font-medium hover:underline text-table-cell">
                      {c.name || 'Unknown'}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-table-cell text-text-secondary">{c.phone_normalized}</td>
                  <td className="px-4 py-3 text-table-cell text-text-muted">{c.external_crm_id || '—'}</td>
                  <td className="px-4 py-3 text-table-cell text-text-secondary">{c.call_count}</td>
                  <td className={`px-4 py-3 text-table-cell ${scoreClass}`}>
                    {score !== null ? `${score.toFixed(1)}%` : '—'}
                  </td>
                  <td className="px-4 py-3 text-table-cell text-text-muted">
                    {new Date(c.last_seen_at).toLocaleDateString('en-GB')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {total > 50 && (
        <div className="flex items-center gap-2 justify-end">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 text-table-cell border border-border rounded-btn disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-table-cell text-text-muted">Page {page}</span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={page * 50 >= total}
            className="px-3 py-1.5 text-table-cell border border-border rounded-btn disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
