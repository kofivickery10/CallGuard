import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { PASS_THRESHOLD } from '@callguard/shared';
import { useTheme } from '../lib/theme';

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

interface JourneyCall {
  id: string;
  call_date: string | null;
  created_at: string;
  agent_name: string | null;
  overall_score: number | null;
  pass: boolean | null;
  coaching_summary: string | null;
  breach_count: string;
}

export default function CustomerProfile() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [editMode, setEditMode] = useState(false);
  const [editName, setEditName] = useState('');
  const [editCrmId, setEditCrmId] = useState('');

  const { data: customerData } = useQuery({
    queryKey: ['customer', id],
    queryFn: () => api.get<{ customer: Customer }>(`/customers/${id}`),
    enabled: !!id,
  });

  const { data: journeyData } = useQuery({
    queryKey: ['customer-journey', id],
    queryFn: () => api.get<{ customer_id: string; calls: JourneyCall[] }>(`/customers/${id}/journey`),
    enabled: !!id && (user?.role !== 'adviser'),
  });

  const updateMutation = useMutation({
    mutationFn: (body: { name?: string; external_crm_id?: string }) =>
      api.put(`/customers/${id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', id] });
      setEditMode(false);
    },
  });

  const customer = customerData?.customer;
  const calls = journeyData?.calls ?? [];
  const { theme } = useTheme();
  const chartTick = theme === 'dark' ? '#8a9c8d' : '#8a9e8a';

  if (!customer) {
    return <div className="p-6 text-text-muted text-table-cell">Loading…</div>;
  }

  const avgScore = customer.avg_score ? parseFloat(customer.avg_score) : null;
  const chartData = calls
    .filter((c) => c.overall_score !== null)
    .map((c, i) => ({
      call: i + 1,
      score: c.overall_score,
      date: new Date(c.call_date || c.created_at).toLocaleDateString('en-GB'),
    }));

  const startEdit = () => {
    setEditName(customer.name ?? '');
    setEditCrmId(customer.external_crm_id ?? '');
    setEditMode(true);
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link to="/customers" className="text-sm text-primary hover:underline">← Customers</Link>
          {editMode ? (
            <div className="mt-2 flex items-center gap-2">
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Customer name"
                className="border border-border rounded-btn px-3 py-1.5 text-sm"
              />
              <input
                value={editCrmId}
                onChange={(e) => setEditCrmId(e.target.value)}
                placeholder="CRM ID"
                className="border border-border rounded-btn px-3 py-1.5 text-sm w-36"
              />
              <button
                onClick={() => updateMutation.mutate({ name: editName || undefined, external_crm_id: editCrmId || undefined })}
                className="bg-primary text-white px-3 py-1.5 rounded-btn text-sm font-medium hover:bg-primary-hover"
              >
                Save
              </button>
              <button onClick={() => setEditMode(false)} className="text-sm text-text-muted hover:text-text-secondary">
                Cancel
              </button>
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-3">
              <h1 className="text-page-title">{customer.name || 'Unknown customer'}</h1>
              {user?.role !== 'adviser' && (
                <button onClick={startEdit} className="text-xs text-primary hover:underline">Edit</button>
              )}
            </div>
          )}
          <p className="text-page-sub text-text-secondary mt-0.5">{customer.phone_normalized}</p>
          {customer.external_crm_id && (
            <p className="text-table-cell text-text-muted mt-0.5">CRM: {customer.external_crm_id}</p>
          )}
        </div>

        {/* KPI strip */}
        <div className="flex gap-6 text-right">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Calls</p>
            <p className="text-2xl font-bold text-text-primary">{customer.call_count}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Avg score</p>
            <p className={`text-2xl font-bold ${avgScore !== null ? (avgScore >= PASS_THRESHOLD ? 'text-pass' : 'text-fail') : 'text-text-muted'}`}>
              {avgScore !== null ? `${avgScore.toFixed(1)}%` : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">First seen</p>
            <p className="text-sm font-medium text-text-primary">{new Date(customer.first_seen_at).toLocaleDateString('en-GB')}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Last seen</p>
            <p className="text-sm font-medium text-text-primary">{new Date(customer.last_seen_at).toLocaleDateString('en-GB')}</p>
          </div>
        </div>
      </div>

      {/* Score trend chart */}
      {chartData.length > 1 && (
        <div className="bg-card rounded-card border border-border p-5">
          <h2 className="text-[15px] font-semibold text-text-primary mb-4">Score trend</h2>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={chartData}>
              <XAxis dataKey="call" tick={{ fontSize: 11, fill: chartTick }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: chartTick }} />
              <Tooltip
                contentStyle={{ background: 'rgb(var(--cg-card))', border: '1px solid rgb(var(--cg-border))', borderRadius: 6, fontSize: 12 }}
                labelStyle={{ color: 'rgb(var(--cg-text-primary))' }}
                formatter={(v) => [`${Number(v).toFixed(1)}%`, 'Score']}
                labelFormatter={(l) => `Call ${l}`}
              />
              <ReferenceLine y={PASS_THRESHOLD} stroke="#c0392b" strokeDasharray="3 3" />
              <Line type="monotone" dataKey="score" stroke="#4a9e6e" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Journey timeline (supervisors/admins only) */}
      {user?.role !== 'adviser' && (
        <div className="bg-card rounded-card border border-border overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <h2 className="text-[15px] font-semibold text-text-primary">Call journey ({calls.length})</h2>
          </div>
          {calls.length === 0 ? (
            <p className="px-5 py-8 text-center text-text-muted text-table-cell">No scored calls yet</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-table-header border-b border-border">
                <tr>
                  {['Date', 'Adviser', 'Score', 'Result', 'Breaches', 'Coaching snippet', ''].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 text-table-header uppercase tracking-wider text-text-muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {calls.map((c) => {
                  const date = new Date(c.call_date || c.created_at).toLocaleDateString('en-GB');
                  const resultClass = c.pass === null ? '' : c.pass ? 'text-pass font-semibold' : 'text-fail font-semibold';
                  return (
                    <tr key={c.id} className="hover:bg-page">
                      <td className="px-4 py-3 text-table-cell text-text-secondary">{date}</td>
                      <td className="px-4 py-3 text-table-cell text-text-primary">{c.agent_name || '—'}</td>
                      <td className="px-4 py-3 text-table-cell font-medium">
                        {c.overall_score !== null ? `${c.overall_score.toFixed(1)}%` : '—'}
                      </td>
                      <td className={`px-4 py-3 text-table-cell ${resultClass}`}>
                        {c.pass === null ? '—' : c.pass ? 'Pass' : 'Fail'}
                      </td>
                      <td className="px-4 py-3 text-table-cell text-text-secondary">{c.breach_count}</td>
                      <td className="px-4 py-3 text-table-cell text-text-muted max-w-xs truncate">
                        {c.coaching_summary ? `"${c.coaching_summary}"` : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <Link to={`/calls/${c.id}`} className="text-primary hover:underline text-xs font-medium">View</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
