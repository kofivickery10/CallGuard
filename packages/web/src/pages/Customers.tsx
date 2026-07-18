import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { hasFeature } from '@callguard/shared';
import { formatPhone } from '../lib/format';

interface Customer {
  id: string;
  phone_normalized: string;
  name: string | null;
  external_crm_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  call_count: number;
  journey_count: number;
  last_journey_score: string | null;
  last_journey_pass: boolean | null;
  last_journey_at: string | null;
}

interface CustomersResponse {
  customers: Customer[];
  total: number;
  page: number;
  limit: number;
}

const COLUMNS = ['Customer', 'CRM ID', 'Calls', 'Sales', 'Last sale', 'Last seen'];

function LastJourneyCell({ customer }: { customer: Customer }) {
  if (customer.last_journey_score == null) {
    return <span className="text-text-muted">Awaiting sale</span>;
  }
  const badge =
    customer.last_journey_pass == null
      ? { label: 'Review', className: 'bg-review-bg text-review' }
      : customer.last_journey_pass
        ? { label: 'Pass', className: 'bg-pass-bg text-pass' }
        : { label: 'Fail', className: 'bg-fail-bg text-fail' };
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-medium tabular-nums text-text-cell">
        {Math.round(parseFloat(customer.last_journey_score))}%
      </span>
      <span className={`px-2.5 py-[3px] rounded-full text-badge font-semibold ${badge.className}`}>
        {badge.label}
      </span>
    </span>
  );
}

export default function Customers() {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const enabled = hasFeature(user?.organization_plan ?? null, 'customer_journey');

  const params = new URLSearchParams({ page: String(page), limit: '50' });
  if (search) params.set('search', search);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['customers', page, search],
    queryFn: () => api.get<CustomersResponse>(`/customers?${params}`),
    enabled,
  });

  if (!enabled) {
    return (
      <div className="bg-card border border-border rounded-card p-8 text-center max-w-md mx-auto">
        <p className="text-text-subtle text-table-cell mb-2">Customer tracking is available on the Core plan and above.</p>
        {user?.role === 'admin' && (
          <Link to="/settings/organization" className="text-primary font-medium hover:underline text-table-cell focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">Upgrade plan</Link>
        )}
      </div>
    );
  }

  const customers = data?.customers ?? [];
  const total = data?.total ?? 0;
  const limit = data?.limit ?? 50;
  const totalPages = total > 0 ? Math.ceil(total / limit) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-page-title text-text-primary">Customers</h2>
          <p className="text-page-sub text-text-subtle mt-1">{total} customer{total !== 1 ? 's' : ''} tracked</p>
        </div>
        <input
          type="search"
          placeholder="Search by name or phone…"
          aria-label="Search customers by name or phone"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="border border-border bg-card text-text-primary rounded-btn px-3 py-2 text-table-cell w-64 focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        />
      </div>

      <div className="bg-card border border-border rounded-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px]">
            <thead>
              <tr>
                {COLUMNS.map((h) => (
                  <th key={h} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isError ? (
                <tr>
                  <td colSpan={COLUMNS.length} className="px-5 py-5">
                    <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">
                      Could not load customers — try refreshing.
                    </div>
                  </td>
                </tr>
              ) : isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={`skeleton-${i}`} className="border-b border-border-light last:border-0">
                    {COLUMNS.map((__, j) => (
                      <td key={j} className="px-5 py-3.5">
                        <div
                          className="h-4 rounded bg-[length:800px_100%] animate-skeleton-shimmer"
                          style={{
                            backgroundImage:
                              'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
                            width: j === 0 ? '70%' : j === 4 ? '60%' : '40%',
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                ))
              ) : customers.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length} className="px-5 py-12 text-center text-text-muted text-table-cell">
                    No customers yet. They appear when calls with a customer phone are ingested.
                  </td>
                </tr>
              ) : (
                customers.map((c) => (
                  <tr key={c.id} className="hover:bg-table-header transition-colors border-b border-border-light last:border-0">
                    <td className="px-5 py-3.5">
                      <Link
                        to={`/customers/${c.id}`}
                        className="text-primary font-medium hover:underline text-table-cell focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      >
                        {c.name || formatPhone(c.phone_normalized)}
                      </Link>
                      <p className="text-table-cell text-text-muted mt-0.5">
                        {c.name ? formatPhone(c.phone_normalized) : 'No name yet'}
                      </p>
                    </td>
                    <td className="px-5 py-3.5 text-table-cell text-text-muted">{c.external_crm_id || '—'}</td>
                    <td className="px-5 py-3.5 text-table-cell text-text-secondary tabular-nums">{c.call_count}</td>
                    <td className="px-5 py-3.5 text-table-cell text-text-secondary tabular-nums">{c.journey_count}</td>
                    <td className="px-5 py-3.5 text-table-cell">
                      <LastJourneyCell customer={c} />
                    </td>
                    <td className="px-5 py-3.5 text-table-cell text-text-muted whitespace-nowrap">
                      {new Date(c.last_seen_at).toLocaleDateString('en-GB')}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-border bg-table-header">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Previous
            </button>
            <span className="text-xs text-text-muted">{page} / {totalPages}</span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
