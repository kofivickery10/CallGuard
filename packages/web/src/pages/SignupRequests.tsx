import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

type SignupStatus = 'new' | 'contacted' | 'approved' | 'rejected' | 'churned';

interface SignupRequest {
  id: string;
  name: string;
  email: string;
  company: string;
  role: string | null;
  sector: string | null;
  expected_call_volume: string | null;
  message: string | null;
  status: SignupStatus;
  notes: string | null;
  approved_at: string | null;
  ip_address: string | null;
  created_at: string;
}

const STATUS_OPTIONS: { value: SignupStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'churned', label: 'Churned' },
];

const STATUS_CLASS: Record<SignupStatus, string> = {
  new: 'bg-processing-bg text-processing',
  contacted: 'bg-review-bg text-review',
  approved: 'bg-pass-bg text-pass',
  rejected: 'bg-fail-bg text-fail',
  churned: 'bg-table-header text-text-muted',
};

export function SignupRequests() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<SignupStatus | ''>('new');
  const [busyId, setBusyId] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (statusFilter) params.set('status', statusFilter);

  const { data, isLoading } = useQuery({
    queryKey: ['signup-requests', statusFilter],
    queryFn: () =>
      api.get<{ data: SignupRequest[] }>(
        `/signup-requests?${params.toString()}`
      ),
  });

  const updateStatus = async (id: string, status: SignupStatus) => {
    try {
      setBusyId(id);
      await api.patch(`/signup-requests/${id}/status`, { status });
      queryClient.invalidateQueries({ queryKey: ['signup-requests'] });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string, email: string) => {
    if (!confirm(`Delete signup request from ${email}?`)) return;
    setBusyId(id);
    try {
      await api.delete(`/signup-requests/${id}`);
      queryClient.invalidateQueries({ queryKey: ['signup-requests'] });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Trial signups</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            Trial requests from the public signup form on callguardai.co.uk. Approve to provision the org + admin user.
          </p>
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as SignupStatus | '')}
          className="bg-white border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>

      <div className="bg-white border border-border rounded-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Submitted</th>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Contact</th>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Company</th>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Sector / volume</th>
              <th className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Status</th>
              <th className="text-right px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && Array.from({ length: 5 }).map((_, i) => (
              <tr key={`s-${i}`} className="border-b border-border-light last:border-0">
                {Array.from({ length: 6 }).map((__, j) => (
                  <td key={j} className="px-5 py-3.5">
                    <div className="h-4 rounded bg-[length:800px_100%] animate-skeleton-shimmer" style={{ backgroundImage: 'linear-gradient(90deg, #f0f5f0 0%, #e2e8e2 50%, #f0f5f0 100%)', width: j === 2 ? '70%' : '40%' }} />
                  </td>
                ))}
              </tr>
            ))}

            {!isLoading && data?.data.length === 0 && (
              <tr><td colSpan={6} className="px-5 py-12 text-center text-text-muted text-table-cell">
                No signup requests {statusFilter ? `with status "${statusFilter}"` : 'yet'}.
              </td></tr>
            )}

            {data?.data.map((r) => (
              <tr key={r.id} className="border-b border-border-light last:border-0 hover:bg-table-header transition-colors align-top">
                <td className="px-5 py-3.5 text-[12px] text-text-muted whitespace-nowrap font-mono">
                  {new Date(r.created_at).toLocaleString()}
                </td>
                <td className="px-5 py-3.5 text-table-cell">
                  <div className="font-semibold text-text-primary">{r.name}</div>
                  <a href={`mailto:${r.email}`} className="text-primary hover:underline">{r.email}</a>
                  {r.role && <div className="text-text-muted text-[12px] mt-1">{r.role}</div>}
                </td>
                <td className="px-5 py-3.5 text-table-cell text-text-primary font-medium">
                  {r.company}
                </td>
                <td className="px-5 py-3.5 text-table-cell text-text-cell">
                  {r.sector || '--'}
                  {r.expected_call_volume && (
                    <div className="text-text-muted text-[12px] mt-1">{r.expected_call_volume} / month</div>
                  )}
                  {r.message && (
                    <details className="text-text-muted text-[12px] mt-1">
                      <summary className="cursor-pointer text-primary hover:underline">Message</summary>
                      <p className="mt-1 whitespace-pre-wrap">{r.message}</p>
                    </details>
                  )}
                </td>
                <td className="px-5 py-3.5">
                  <span className={`inline-block px-2 py-[2px] rounded text-[11px] font-bold uppercase tracking-wider ${STATUS_CLASS[r.status]}`}>
                    {r.status}
                  </span>
                </td>
                <td className="px-5 py-3.5 text-right">
                  <div className="inline-flex flex-wrap gap-1.5 justify-end">
                    {r.status === 'new' && (
                      <button onClick={() => updateStatus(r.id, 'contacted')} disabled={busyId === r.id} className="text-[12px] text-review hover:text-white hover:bg-review px-2 py-1 rounded border border-review/30 hover:border-review transition-colors disabled:opacity-50">
                        Mark contacted
                      </button>
                    )}
                    {r.status !== 'approved' && (
                      <button onClick={() => updateStatus(r.id, 'approved')} disabled={busyId === r.id} className="text-[12px] text-pass hover:text-white hover:bg-pass px-2 py-1 rounded border border-pass/30 hover:border-pass transition-colors disabled:opacity-50">
                        Approved
                      </button>
                    )}
                    {r.status !== 'rejected' && (
                      <button onClick={() => updateStatus(r.id, 'rejected')} disabled={busyId === r.id} className="text-[12px] text-fail hover:text-white hover:bg-fail px-2 py-1 rounded border border-fail/30 hover:border-fail transition-colors disabled:opacity-50">
                        Reject
                      </button>
                    )}
                    <button onClick={() => handleDelete(r.id, r.email)} disabled={busyId === r.id} className="text-[12px] text-text-muted hover:text-fail px-2 py-1 transition-colors disabled:opacity-50">
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
