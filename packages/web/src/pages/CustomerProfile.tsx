import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { PASS_THRESHOLD } from '@callguard/shared';
import type { JourneyListItem, CallStatus } from '@callguard/shared';
import { useTheme } from '../lib/theme';
import { formatPhone, formatDuration } from '../lib/format';
import { JourneyStatusBadge } from '../components/JourneyStatusBadge';
import { CallStatusBadge } from '../components/CallStatusBadge';

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

interface JourneyCall {
  id: string;
  call_date: string | null;
  created_at: string;
  agent_name: string | null;
  status: CallStatus;
  duration_seconds: number | null;
  overall_score: number | null;
  pass: boolean | null;
  coaching_summary: string | null;
  breach_count: string;
}

const inputClass =
  'px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary disabled:opacity-60 focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';

export default function CustomerProfile() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { notify } = useDialog();
  const [editMode, setEditMode] = useState(false);
  const [editName, setEditName] = useState('');
  const [editCrmId, setEditCrmId] = useState('');

  const { data: customerData, isLoading, isError } = useQuery({
    queryKey: ['customer', id],
    queryFn: () => api.get<{ customer: Customer }>(`/customers/${id}`),
    enabled: !!id,
  });

  const { data: journeyData } = useQuery({
    queryKey: ['customer-journey', id],
    queryFn: () => api.get<{ customer_id: string; calls: JourneyCall[] }>(`/customers/${id}/journey`),
    enabled: !!id && (user?.role !== 'adviser'),
  });

  const canAction = user?.role === 'admin' || user?.role === 'supervisor';

  const { data: journeysData } = useQuery({
    queryKey: ['customer-journeys', id],
    queryFn: () => api.get<{ data: JourneyListItem[] }>(`/journeys?customer_id=${id}&limit=50`),
    enabled: !!id && canAction,
    refetchInterval: (query) => {
      const rows = query.state.data?.data ?? [];
      return rows.some((j) => j.status === 'pending' || j.status === 'scoring') ? 4000 : false;
    },
  });
  const journeys = journeysData?.data ?? [];

  const triggerMutation = useMutation({
    mutationFn: () => api.post<{ journey_id?: string; message?: string }>('/journeys/trigger', { customer_id: id }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['customer-journeys', id] });
      if (!res.journey_id && res.message) void notify(res.message);
    },
    onError: (err) => void notify('Failed to trigger journey: ' + (err instanceof Error ? err.message : 'unknown error')),
  });

  const updateMutation = useMutation({
    mutationFn: (body: { name: string; external_crm_id?: string }) =>
      api.put(`/customers/${id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', id] });
      setEditMode(false);
    },
  });

  const customer = customerData?.customer;
  const calls = journeyData?.calls ?? [];
  const { theme } = useTheme();
  // Resolve chart colours from the CSS tokens at render time so Recharts (which
  // can't read var() in SVG attributes) still follows the theme. `theme` in the
  // deps re-resolves them after the dark class flips on <html>.
  const chartColors = useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    const token = (name: string) => `rgb(${css.getPropertyValue(name).trim()})`;
    return {
      tick: token('--cg-text-muted'),
      primary: token('--cg-primary'),
      fail: token('--cg-fail'),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-20" role="status" aria-label="Loading customer">
        <div className="w-10 h-10 border-[3px] border-border border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (isError || !customer) {
    return (
      <div className="space-y-4">
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">
          Customer not found or failed to load.
        </div>
        <Link
          to="/customers"
          className="inline-flex items-center gap-1 text-table-cell text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Customers
        </Link>
      </div>
    );
  }

  const lastJourneyScore = customer.last_journey_score != null ? Math.round(parseFloat(customer.last_journey_score)) : null;

  // Chart: prefer the journey-level score trend when this customer has scored
  // journeys; otherwise fall back to per-call scores.
  const journeyChartData = journeys
    .filter((j) => j.overall_score != null && j.scored_at != null)
    .sort((a, b) => new Date(a.scored_at as string).getTime() - new Date(b.scored_at as string).getTime())
    .map((j, i) => ({
      idx: i + 1,
      score: Number(j.overall_score),
      date: new Date(j.scored_at as string).toLocaleDateString('en-GB'),
    }));
  const callChartData = calls
    .filter((c) => c.overall_score !== null)
    .map((c, i) => ({
      idx: i + 1,
      score: c.overall_score,
      date: new Date(c.call_date || c.created_at).toLocaleDateString('en-GB'),
    }));
  const usingJourneyChart = journeyChartData.length > 0;
  const chartData = usingJourneyChart ? journeyChartData : callChartData;

  const startEdit = () => {
    setEditName(customer.name ?? '');
    setEditCrmId(customer.external_crm_id ?? '');
    updateMutation.reset();
    setEditMode(true);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <Link
            to="/customers"
            className="inline-flex items-center gap-1 text-table-cell text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            Customers
          </Link>
          {editMode ? (
            <div className="mt-2">
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Customer name"
                  aria-label="Customer name"
                  className={inputClass}
                />
                <input
                  value={editCrmId}
                  onChange={(e) => setEditCrmId(e.target.value)}
                  placeholder="CRM ID"
                  aria-label="CRM ID"
                  className={`${inputClass} w-36`}
                />
                <button
                  onClick={() =>
                    // Send name even when empty — the API clears the name on an
                    // explicit empty string.
                    updateMutation.mutate({ name: editName.trim(), external_crm_id: editCrmId.trim() || undefined })
                  }
                  disabled={updateMutation.isPending}
                  className="px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {updateMutation.isPending ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={() => setEditMode(false)}
                  className="text-table-cell text-text-muted hover:text-text-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Cancel
                </button>
              </div>
              {updateMutation.isError && (
                <p className="text-sm text-fail mt-1">
                  Could not save changes{updateMutation.error instanceof Error ? ` — ${updateMutation.error.message}` : ''}.
                </p>
              )}
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-3">
              <h2 className="text-page-title text-text-primary">{customer.name || formatPhone(customer.phone_normalized)}</h2>
              {user?.role !== 'adviser' && (
                <button
                  onClick={startEdit}
                  className="text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Edit
                </button>
              )}
              {canAction && (
                <button
                  onClick={() => triggerMutation.mutate()}
                  disabled={triggerMutation.isPending}
                  className="px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  title="Assemble this customer's calls into a journey and score them together"
                >
                  {triggerMutation.isPending ? 'Scoring…' : 'Score journey'}
                </button>
              )}
            </div>
          )}
          <p className="text-page-sub text-text-subtle mt-0.5">
            {customer.name ? formatPhone(customer.phone_normalized) : 'No name yet'}
          </p>
          {customer.external_crm_id && (
            <p className="text-table-cell text-text-muted mt-0.5">CRM: {customer.external_crm_id}</p>
          )}
        </div>

        {/* KPI strip */}
        <div className="flex gap-6 text-right">
          <div>
            <p className="text-card-label uppercase text-text-muted">Calls</p>
            <p className="text-card-value text-text-primary">{customer.call_count}</p>
          </div>
          <div>
            <p className="text-card-label uppercase text-text-muted">Journeys scored</p>
            <p className="text-card-value text-text-primary">{customer.journey_count}</p>
          </div>
          <div>
            <p className="text-card-label uppercase text-text-muted">Last journey</p>
            {lastJourneyScore !== null ? (
              <p className="text-card-value text-text-primary">
                {lastJourneyScore}%{' '}
                <span className={`text-table-cell font-semibold ${customer.last_journey_pass == null ? 'text-review' : customer.last_journey_pass ? 'text-pass' : 'text-fail'}`}>
                  {customer.last_journey_pass == null ? 'Review' : customer.last_journey_pass ? 'Pass' : 'Fail'}
                </span>
              </p>
            ) : (
              <>
                <p className="text-card-value text-text-muted">—</p>
                <p className="text-[12px] text-text-muted">awaiting sale</p>
              </>
            )}
          </div>
          <div>
            <p className="text-card-label uppercase text-text-muted">First seen</p>
            <p className="text-sm font-medium text-text-primary">{new Date(customer.first_seen_at).toLocaleDateString('en-GB')}</p>
          </div>
          <div>
            <p className="text-card-label uppercase text-text-muted">Last seen</p>
            <p className="text-sm font-medium text-text-primary">{new Date(customer.last_seen_at).toLocaleDateString('en-GB')}</p>
          </div>
        </div>
      </div>

      {/* Score trend chart */}
      {chartData.length > 1 && (
        <div className="bg-card border border-border rounded-card p-5">
          <h3 className="text-section-title text-text-primary mb-4">
            Score trend {usingJourneyChart ? '(journeys)' : '(calls)'}
          </h3>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={chartData}>
              <XAxis dataKey="idx" tick={{ fontSize: 11, fill: chartColors.tick }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: chartColors.tick }} />
              <Tooltip
                contentStyle={{ background: 'rgb(var(--cg-card))', border: '1px solid rgb(var(--cg-border))', borderRadius: 6, fontSize: 12 }}
                labelStyle={{ color: 'rgb(var(--cg-text-primary))' }}
                formatter={(v) => [`${Number(v).toFixed(1)}%`, 'Score']}
                labelFormatter={(l) => `${usingJourneyChart ? 'Journey' : 'Call'} ${l}`}
              />
              <ReferenceLine y={PASS_THRESHOLD} stroke={chartColors.fail} strokeDasharray="3 3" />
              <Line type="monotone" dataKey="score" stroke={chartColors.primary} strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Scored journeys for this customer (supervisors/admins only) */}
      {canAction && (
        <div className="bg-card border border-border rounded-card overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <h3 className="text-section-title text-text-primary">Journeys ({journeys.length})</h3>
          </div>
          {journeys.length === 0 ? (
            <p className="px-5 py-12 text-center text-text-muted text-table-cell">
              No scored journeys yet — journeys assemble when a sale completes in your CRM, or use Score journey above.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    {['Scored', 'Calls', 'Branch', 'Score', 'Result', 'Status', ''].map((h, i) => (
                      <th key={`${h}-${i}`} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {journeys.map((j) => (
                    <tr key={j.id} className="hover:bg-table-header transition-colors border-b border-border-light last:border-0">
                      <td className="px-5 py-3.5 text-table-cell text-text-secondary">
                        {j.scored_at ? new Date(j.scored_at).toLocaleDateString('en-GB') : '—'}
                      </td>
                      <td className="px-5 py-3.5 text-table-cell text-text-cell tabular-nums">{j.call_count}</td>
                      <td className="px-5 py-3.5 text-table-cell text-text-secondary">{j.branch || '—'}</td>
                      <td className="px-5 py-3.5 text-table-cell font-medium tabular-nums">
                        {j.overall_score != null ? `${Number(j.overall_score).toFixed(1)}%` : '—'}
                      </td>
                      <td className={`px-5 py-3.5 text-table-cell ${j.pass == null ? 'text-text-muted' : j.pass ? 'text-pass font-semibold' : 'text-fail font-semibold'}`}>
                        {j.pass == null ? '—' : j.pass ? 'Pass' : 'Fail'}
                      </td>
                      <td className="px-5 py-3.5">
                        <JourneyStatusBadge status={j.status} />
                      </td>
                      <td className="px-5 py-3.5">
                        <Link
                          to={`/journeys/${j.id}`}
                          className="text-primary hover:underline text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Journey timeline (supervisors/admins only) */}
      {user?.role !== 'adviser' && (
        <div className="bg-card border border-border rounded-card overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <h3 className="text-section-title text-text-primary">Call journey ({calls.length})</h3>
          </div>
          {calls.length === 0 ? (
            <p className="px-5 py-12 text-center text-text-muted text-table-cell">No calls yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px]">
                <thead>
                  <tr>
                    {['Date', 'Adviser', 'Duration', 'Status', 'Score', 'Result', 'Breaches', 'Coaching snippet', ''].map((h, i) => (
                      <th key={`${h}-${i}`} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {calls.map((c) => {
                    const date = new Date(c.call_date || c.created_at).toLocaleDateString('en-GB');
                    const resultClass = c.pass === null ? 'text-text-muted' : c.pass ? 'text-pass font-semibold' : 'text-fail font-semibold';
                    return (
                      <tr key={c.id} className="hover:bg-table-header transition-colors border-b border-border-light last:border-0">
                        <td className="px-5 py-3.5 text-table-cell text-text-secondary whitespace-nowrap">{date}</td>
                        <td className="px-5 py-3.5 text-table-cell text-text-primary">{c.agent_name || '—'}</td>
                        <td className="px-5 py-3.5 text-table-cell text-text-cell tabular-nums">{formatDuration(c.duration_seconds)}</td>
                        <td className="px-5 py-3.5">
                          <CallStatusBadge status={c.status} pass={c.pass} />
                        </td>
                        <td className="px-5 py-3.5 text-table-cell font-medium tabular-nums">
                          {c.overall_score !== null ? `${c.overall_score.toFixed(1)}%` : '—'}
                        </td>
                        <td className={`px-5 py-3.5 text-table-cell ${resultClass}`}>
                          {c.pass === null ? '—' : c.pass ? 'Pass' : 'Fail'}
                        </td>
                        <td className="px-5 py-3.5 text-table-cell text-text-secondary tabular-nums">{c.breach_count}</td>
                        <td className="px-5 py-3.5 text-table-cell text-text-muted max-w-xs truncate">
                          {c.coaching_summary ? `"${c.coaching_summary}"` : '—'}
                        </td>
                        <td className="px-5 py-3.5">
                          <Link
                            to={`/calls/${c.id}`}
                            className="text-primary hover:underline text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
