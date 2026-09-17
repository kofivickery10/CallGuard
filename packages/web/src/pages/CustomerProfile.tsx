import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth, useScoreOnly } from '../context/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { PASS_THRESHOLD, summariseCustomerCompliance } from '@callguard/shared';
import type { JourneyListItem, CallStatus, CustomerProfileResponse } from '@callguard/shared';
import { useTheme } from '../lib/theme';
import { formatPhone, formatDuration } from '../lib/format';
import { JourneyStatusBadge } from '../components/JourneyStatusBadge';
import { CallStatusBadge } from '../components/CallStatusBadge';

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

const primaryBtn =
  'px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary-ink text-on-solid hover:bg-primary-ink-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';

const fmtDate = (raw: string | null | undefined) =>
  raw ? new Date(raw).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

// Compact stroke-SVG icon for a KPI card corner (DESIGN_SYSTEM §5).
function CardIcon({ paths }: { paths: string[] }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="w-[18px] h-[18px] stroke-icon-muted shrink-0"
      fill="none"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export default function CustomerProfile() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const scoreOnly = useScoreOnly();
  const queryClient = useQueryClient();
  const { notify } = useDialog();
  const [editMode, setEditMode] = useState(false);
  const [editName, setEditName] = useState('');
  const [editCrmId, setEditCrmId] = useState('');

  const { data: customerData, isLoading, isError } = useQuery({
    queryKey: ['customer', id],
    queryFn: () => api.get<CustomerProfileResponse>(`/customers/${id}`),
    enabled: !!id,
  });

  const { data: journeyData } = useQuery({
    queryKey: ['customer-journey', id],
    queryFn: () => api.get<{ customer_id: string; calls: JourneyCall[] }>(`/customers/${id}/journey`),
    enabled: !!id && (user?.role !== 'adviser'),
  });

  const canAction = user?.role === 'admin' || user?.role === 'supervisor';
  // Viewers read sales everywhere else (GET /journeys is requireOrgView), so
  // they read them here too. Only acting on them is admin/supervisor.
  const canViewSales = canAction || user?.role === 'viewer';

  const { data: journeysData } = useQuery({
    queryKey: ['customer-journeys', id],
    queryFn: () => api.get<{ data: JourneyListItem[] }>(`/journeys?customer_id=${id}&limit=50`),
    enabled: !!id && canViewSales,
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
      // Always give feedback: the endpoint is idempotent, so a click on an
      // already-scored sale is a no-op and would otherwise look broken.
      if (res.message) void notify(res.message);
    },
    onError: (err) => void notify('Failed to score the sale: ' + (err instanceof Error ? err.message : 'unknown error')),
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
  // Null for an adviser: the API withholds the firm's findings from them.
  const compliance = customerData?.compliance ?? null;
  const mode = customerData?.mode ?? 'sales';
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
          className="inline-flex items-center gap-1 text-table-cell text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
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

  // Where the customer stands (§7 — the words carry the state; colour only
  // adds to them). Three states, never "Clean" for someone nobody assessed.
  const complianceSummary = compliance ? summariseCustomerCompliance(compliance, mode) : null;
  const complianceValueClass = complianceSummary
    ? {
        neutral: 'text-text-secondary',
        pass: 'text-pass',
        review: 'text-review',
        fail: 'text-fail',
      }[complianceSummary.tone]
    : '';
  // A firm that scores sales records its breaches against the sale, so a
  // per-call breach count reads 0 on every call beside a sale with findings.
  const showCallBreaches = mode === 'calls';

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
            className="inline-flex items-center gap-1 text-table-cell text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            Customers
          </Link>
          <h2 className="text-page-title text-text-primary mt-2">
            {customer.name || formatPhone(customer.phone_normalized)}
          </h2>
          <p className="text-page-sub text-text-subtle mt-0.5">
            {customer.name ? formatPhone(customer.phone_normalized) : 'No name yet'}
          </p>
          {customer.external_crm_id && (
            <p className="text-table-cell text-text-muted mt-0.5">CRM: {customer.external_crm_id}</p>
          )}
        </div>

        {/* Header actions */}
        <div className="flex items-center gap-2">
          {canAction && !editMode && (
            <button
              onClick={startEdit}
              className="px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Edit
            </button>
          )}
          {canAction && (
            <button
              onClick={() => triggerMutation.mutate()}
              disabled={triggerMutation.isPending}
              className={primaryBtn}
              title="Score this customer's calls together as one sale"
            >
              {triggerMutation.isPending ? 'Scoring…' : 'Score sale'}
            </button>
          )}
        </div>
      </div>

      {/* Edit form (inline; clears name on an explicit empty string) */}
      {editMode && (
        <div className="bg-card border border-border rounded-card p-5">
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
              className={primaryBtn}
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
            <p className="text-sm text-fail mt-2">
              Could not save changes{updateMutation.error instanceof Error ? ` — ${updateMutation.error.message}` : ''}.
            </p>
          )}
        </div>
      )}

      {/* KPI / summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {/* Calls */}
        <div className="bg-card border border-border rounded-card p-5">
          <div className="flex justify-between items-center">
            <p className="text-card-label uppercase text-text-muted">Calls</p>
            <CardIcon paths={['M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3']} />
          </div>
          <p className="text-card-value text-text-primary mt-2.5 tabular-nums">{customer.call_count}</p>
        </div>

        {/* Sales scored — withheld from advisers by the API */}
        {customer.journey_count !== null && (
        <div className="bg-card border border-border rounded-card p-5">
          <div className="flex justify-between items-center">
            <p className="text-card-label uppercase text-text-muted">Sales scored</p>
            <CardIcon paths={['M9 11l3 3L22 4', 'M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11']} />
          </div>
          <p className="text-card-value text-text-primary mt-2.5 tabular-nums">{customer.journey_count}</p>
        </div>
        )}

        {/* Last sale — withheld from advisers by the API */}
        {customer.journey_count !== null && (
        <div className="bg-card border border-border rounded-card p-5">
          <div className="flex justify-between items-center">
            <p className="text-card-label uppercase text-text-muted">Last sale</p>
            <CardIcon paths={['M22 12l-4 0-3 9-6-18-3 9-4 0']} />
          </div>
          {lastJourneyScore !== null ? (
            <>
              <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                <span className="text-card-value text-text-primary tabular-nums">{lastJourneyScore}%</span>
                {!scoreOnly && (
                  <span
                    className={`inline-block px-2.5 py-[3px] rounded-full text-badge font-semibold ${
                      customer.last_journey_pass == null
                        ? 'bg-review-bg text-review'
                        : customer.last_journey_pass
                          ? 'bg-pass-bg text-pass'
                          : 'bg-fail-bg text-fail'
                    }`}
                  >
                    {customer.last_journey_pass == null ? 'Review' : customer.last_journey_pass ? 'Pass' : 'Fail'}
                  </span>
                )}
              </div>
              {customer.last_journey_at && (
                <p className="text-[12px] text-text-muted mt-1">{fmtDate(customer.last_journey_at)}</p>
              )}
            </>
          ) : (
            <>
              <p className="text-card-value text-text-muted mt-2.5">—</p>
              <p className="text-[12px] text-text-muted mt-1">awaiting sale</p>
            </>
          )}
        </div>
        )}

        {/* Compliance snapshot — withheld from advisers by the API */}
        {complianceSummary && (
        <div className="bg-card border border-border rounded-card p-5">
          <div className="flex justify-between items-center">
            <p className="text-card-label uppercase text-text-muted">Compliance</p>
            <CardIcon paths={['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z']} />
          </div>
          {complianceSummary.state === 'open' ? (
            <p className={`text-card-value mt-2.5 tabular-nums ${complianceValueClass}`}>
              {complianceSummary.open_total} <span className="text-sm font-medium">open</span>
            </p>
          ) : (
            <p className={`text-lg font-semibold mt-2.5 ${complianceValueClass}`}>{complianceSummary.headline}</p>
          )}
          <p className="text-xs text-text-muted mt-1">{complianceSummary.detail}</p>
        </div>
        )}

        {/* First seen */}
        <div className="bg-card border border-border rounded-card p-5">
          <div className="flex justify-between items-center">
            <p className="text-card-label uppercase text-text-muted">First seen</p>
            <CardIcon paths={['M12 22a10 10 0 100-20 10 10 0 000 20z', 'M12 6v6l4 2']} />
          </div>
          <p className="text-lg font-semibold text-text-primary mt-2.5 tabular-nums">{fmtDate(customer.first_seen_at)}</p>
        </div>

        {/* Last seen */}
        <div className="bg-card border border-border rounded-card p-5">
          <div className="flex justify-between items-center">
            <p className="text-card-label uppercase text-text-muted">Last seen</p>
            <CardIcon paths={['M12 22a10 10 0 100-20 10 10 0 000 20z', 'M12 6v6l4 2']} />
          </div>
          <p className="text-lg font-semibold text-text-primary mt-2.5 tabular-nums">{fmtDate(customer.last_seen_at)}</p>
        </div>
      </div>

      {/* Score trend chart */}
      {chartData.length > 1 && (
        <div className="bg-card border border-border rounded-card p-5">
          <h3 className="text-section-title text-text-primary mb-4">
            Score trend {usingJourneyChart ? '(sales)' : '(calls)'}
          </h3>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={chartData}>
              <XAxis dataKey="idx" tick={{ fontSize: 11, fill: chartColors.tick }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: chartColors.tick }} />
              <Tooltip
                contentStyle={{ background: 'rgb(var(--cg-card))', border: '1px solid rgb(var(--cg-border))', borderRadius: 6, fontSize: 12 }}
                labelStyle={{ color: 'rgb(var(--cg-text-primary))' }}
                formatter={(v) => [`${Number(v).toFixed(1)}%`, 'Score']}
                labelFormatter={(l) => `${usingJourneyChart ? 'Sale' : 'Call'} ${l}`}
              />
              {!scoreOnly && <ReferenceLine y={PASS_THRESHOLD} stroke={chartColors.fail} strokeDasharray="3 3" />}
              <Line type="monotone" dataKey="score" stroke={chartColors.primary} strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Scored sales for this customer (admins, supervisors and viewers) */}
      {canViewSales && (
        <div className="bg-card border border-border rounded-card overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <h3 className="text-section-title text-text-primary">Sales ({journeys.length})</h3>
            <p className="text-page-sub text-text-subtle mt-0.5">Multi-call sales scored as one compliance unit.</p>
          </div>
          {journeys.length === 0 ? (
            <p className="px-5 py-12 text-center text-text-muted text-table-cell">
              No scored sales yet — a sale is scored when it completes in your CRM{canAction ? ', or use Score sale above' : ''}.
            </p>
          ) : (
            // relative: the sr-only "Actions" header is absolutely positioned,
            // and without a positioned ancestor inside this scroller it lays
            // out against <main> instead — escaping the scroll and widening
            // the whole page on a phone.
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[720px]">
                <thead>
                  <tr>
                    {[...(scoreOnly ? [] : ['Result']), 'Score', 'Branch', 'Calls', 'Status', 'Scored', ''].map((h, i) => (
                      <th key={`${h}-${i}`} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">
                        {h || <span className="sr-only">Actions</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {journeys.map((j) => {
                    const failed = j.pass === false && !scoreOnly;
                    return (
                      <tr
                        key={j.id}
                        className={`hover:bg-table-header transition-colors border-b border-border-light last:border-0 border-l-[3px] ${
                          failed ? 'border-l-fail bg-fail-bg/30' : 'border-l-transparent'
                        }`}
                      >
                        {!scoreOnly && (
                          <td className="px-5 py-3.5">
                            {j.pass == null ? (
                              <span className="text-text-muted text-table-cell">—</span>
                            ) : (
                              <span
                                className={`inline-block px-2.5 py-[3px] rounded-full text-badge font-semibold ${
                                  j.pass ? 'bg-pass-bg text-pass' : 'bg-fail-bg text-fail'
                                }`}
                              >
                                {j.pass ? 'Pass' : 'Fail'}
                              </span>
                            )}
                          </td>
                        )}
                        <td className={`px-5 py-3.5 text-table-cell font-semibold tabular-nums ${failed ? 'text-fail' : 'text-text-cell'}`}>
                          {j.overall_score != null ? `${Number(j.overall_score).toFixed(1)}%` : '—'}
                        </td>
                        <td className="px-5 py-3.5 text-table-cell text-text-secondary">{j.branch || '—'}</td>
                        <td className="px-5 py-3.5 text-table-cell text-text-cell tabular-nums">{j.call_count}</td>
                        <td className="px-5 py-3.5">
                          <JourneyStatusBadge status={j.status} />
                        </td>
                        <td className="px-5 py-3.5 text-table-cell text-text-muted whitespace-nowrap">
                          {j.scored_at ? new Date(j.scored_at).toLocaleDateString('en-GB') : '—'}
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <Link
                            to={`/journeys/${j.id}`}
                            className="text-primary-ink text-table-cell font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
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

      {/* Call history timeline (supervisors/admins only) */}
      {user?.role !== 'adviser' && (
        <div className="bg-card border border-border rounded-card overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <h3 className="text-section-title text-text-primary">Call history ({calls.length})</h3>
            <p className="text-page-sub text-text-subtle mt-0.5">Every call recorded for this customer.</p>
          </div>
          {calls.length === 0 ? (
            <p className="px-5 py-12 text-center text-text-muted text-table-cell">No calls yet</p>
          ) : (
            // relative: see the sales table above.
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[820px]">
                <thead>
                  <tr>
                    {['Date', 'Adviser', 'Duration', 'Status', 'Score', ...(scoreOnly ? [] : ['Result']), ...(showCallBreaches ? ['Breaches'] : []), 'Coaching snippet', ''].map((h, i) => (
                      <th key={`${h}-${i}`} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">
                        {h || <span className="sr-only">Actions</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {calls.map((c) => {
                    const failed = c.pass === false && !scoreOnly;
                    const breachN = Number(c.breach_count) || 0;
                    return (
                      <tr
                        key={c.id}
                        className={`hover:bg-table-header transition-colors border-b border-border-light last:border-0 border-l-[3px] ${
                          failed ? 'border-l-fail bg-fail-bg/30' : 'border-l-transparent'
                        }`}
                      >
                        <td className="px-5 py-3.5 text-table-cell text-text-secondary whitespace-nowrap">
                          {new Date(c.call_date || c.created_at).toLocaleDateString('en-GB')}
                        </td>
                        <td className="px-5 py-3.5 text-table-cell text-text-primary">{c.agent_name || '—'}</td>
                        <td className="px-5 py-3.5 text-table-cell text-text-cell tabular-nums">{formatDuration(c.duration_seconds)}</td>
                        <td className="px-5 py-3.5">
                          <CallStatusBadge status={c.status} pass={c.pass} />
                        </td>
                        <td className={`px-5 py-3.5 text-table-cell font-semibold tabular-nums ${failed ? 'text-fail' : 'text-text-cell'}`}>
                          {c.overall_score !== null ? `${c.overall_score.toFixed(1)}%` : '—'}
                        </td>
                        {!scoreOnly && (
                          <td className="px-5 py-3.5">
                            {c.pass == null ? (
                              <span className="text-text-muted text-table-cell">—</span>
                            ) : (
                              <span
                                className={`inline-block px-2.5 py-[3px] rounded-full text-badge font-semibold ${
                                  c.pass ? 'bg-pass-bg text-pass' : 'bg-fail-bg text-fail'
                                }`}
                              >
                                {c.pass ? 'Pass' : 'Fail'}
                              </span>
                            )}
                          </td>
                        )}
                        {showCallBreaches && (
                          <td className={`px-5 py-3.5 text-table-cell tabular-nums ${breachN > 0 ? 'text-fail font-semibold' : 'text-text-muted'}`}>
                            {breachN}
                          </td>
                        )}
                        <td className="px-5 py-3.5 text-table-cell text-text-muted max-w-xs truncate">
                          {c.coaching_summary ? `"${c.coaching_summary}"` : '—'}
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <Link
                            to={`/calls/${c.id}`}
                            className="text-primary-ink text-table-cell font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
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
