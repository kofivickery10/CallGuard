import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import { PLANS, PLAN_LABELS, SEAT_PRICING, FEATURES } from '@callguard/shared';
import type { Plan } from '@callguard/shared';

// Only features that actually gate by plan are worth overriding; ones available
// on every tier are derived here so the UI stays in step with the shared map.
const GATED_FEATURES = (Object.keys(FEATURES) as (keyof typeof FEATURES)[])
  .filter((f) => FEATURES[f].length < PLANS.length);

const FEATURE_LABELS: Record<string, string> = {
  live_streaming: 'Live streaming',
  live_coaching: 'Live coaching',
  dedicated_support: 'Dedicated support',
  white_label: 'White-label',
};

interface OrgDetail {
  id: string;
  name: string;
  plan: string;
  status: string;
  created_at: string;
  suspended_at: string | null;
  subscription_notes: string | null;
  seat_price_override: string | null;
  feature_overrides: Record<string, boolean>;
}
interface MonthBreakdown {
  month: string;
  active_seats: number;
  calls: number;
  claude_cost_estimate: number;
  deepgram_cost_estimate: number;
}
interface FailedCall {
  id: string;
  status: string;
  file_name: string | null;
  external_id: string | null;
  agent_name: string | null;
  customer_phone: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  stuck: boolean;
}
interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  last_active_at: string | null;
  plan_override: string | null;
}
interface CallStats {
  total_calls: string;
  scored_calls: string;
  failed_calls: string;
  total_duration_seconds: string;
}
interface SeatMonth {
  month: string;
  active_seats: string;
}
interface TenantDetailData {
  org: OrgDetail;
  users: User[];
  call_stats: CallStats;
  seat_history: SeatMonth[];
}

export default function TenantDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<TenantDetailData | null>(null);
  const [trend, setTrend] = useState<MonthBreakdown[]>([]);
  const [failed, setFailed] = useState<FailedCall[]>([]);
  const [error, setError] = useState('');
  const [planValue, setPlanValue] = useState('');
  const [statusValue, setStatusValue] = useState('');
  const [notes, setNotes] = useState('');
  const [priceOverride, setPriceOverride] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [tierSaving, setTierSaving] = useState<string | null>(null);
  const [featSaving, setFeatSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api.get<TenantDetailData>(`/superadmin/tenants/${id}`)
      .then((d) => {
        setData(d);
        setPlanValue(d.org.plan);
        setStatusValue(d.org.status);
        setNotes(d.org.subscription_notes ?? '');
        setPriceOverride(d.org.seat_price_override ?? '');
      })
      .catch((e: Error) => setError(e.message));
    api.get<{ breakdown: MonthBreakdown[] }>(`/superadmin/billing/${id}`)
      .then((r) => setTrend(r.breakdown))
      .catch(() => setTrend([]));
    api.get<{ calls: FailedCall[] }>(`/superadmin/tenants/${id}/failed-calls`)
      .then((r) => setFailed(r.calls))
      .catch(() => setFailed([]));
  }, [id]);

  const setFeature = async (feature: string, value: boolean | null) => {
    if (!id) return;
    setFeatSaving(feature);
    try {
      const r = await api.put<{ feature_overrides: Record<string, boolean> }>(
        `/superadmin/tenants/${id}/features`, { feature, value }
      );
      setData((prev) => prev ? { ...prev, org: { ...prev.org, feature_overrides: r.feature_overrides } } : prev);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to set feature');
    } finally {
      setFeatSaving(null);
    }
  };

  const saveSeatPrice = async () => {
    if (!id) return;
    setSaving(true); setSaveMsg('');
    try {
      const value = priceOverride.trim() === '' ? null : Number(priceOverride);
      await api.put(`/superadmin/tenants/${id}/seat-price`, { seat_price_override: value });
      setSaveMsg(value == null ? 'Seat price reset to tier default' : `Seat price set to £${value}/seat`);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  const savePlan = async () => {
    if (!id) return;
    setSaving(true); setSaveMsg('');
    try {
      await api.put(`/superadmin/tenants/${id}/plan`, { plan: planValue, subscription_notes: notes });
      setSaveMsg('Plan updated');
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  const saveStatus = async () => {
    if (!id) return;
    setSaving(true); setSaveMsg('');
    try {
      await api.put(`/superadmin/tenants/${id}/status`, { status: statusValue });
      setSaveMsg('Status updated');
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  const impersonate = async () => {
    if (!id || !confirm('Issue a 1-hour impersonation token?')) return;
    try {
      const r = await api.post<{ token: string; note: string }>(`/superadmin/tenants/${id}/impersonate`, {});
      prompt('Copy this token (expires 1 hour):', r.token);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  const setUserTier = async (userId: string, tier: string | null) => {
    if (!id) return;
    setTierSaving(userId);
    try {
      const result = await api.put<{ user_id: string; plan_override: string | null }>(
        `/superadmin/tenants/${id}/users/${userId}/tier`,
        { tier }
      );
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          users: prev.users.map((u) =>
            u.id === userId ? { ...u, plan_override: result.plan_override } : u
          ),
        };
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to set tier');
    } finally {
      setTierSaving(null);
    }
  };

  if (error)  return <p className="text-fail text-sm p-6">{error}</p>;
  if (!data)  return <p className="text-text-muted text-sm p-6">Loading…</p>;

  const { org, users, call_stats: stats, seat_history } = data;
  const durationMins = Math.round(Number(stats.total_duration_seconds) / 60);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/tenants" className="text-sm text-primary hover:underline">← Tenants</Link>
        <h1 className="text-xl font-bold text-text-primary">{org.name}</h1>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Total calls',    value: stats.total_calls },
          { label: 'Scored calls',   value: stats.scored_calls },
          { label: 'Failed calls',   value: stats.failed_calls },
          { label: 'Audio (minutes)', value: durationMins },
        ].map(({ label, value }) => (
          <div key={label} className="bg-white rounded-card p-4 border border-border">
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-1">{label}</p>
            <p className="text-2xl font-bold text-text-primary">{value}</p>
          </div>
        ))}
      </div>

      {/* Seat history */}
      {seat_history.length > 0 && (
        <div className="bg-white rounded-card border border-border p-4">
          <h2 className="text-sm font-semibold text-text-primary mb-3">Active seats per month</h2>
          <div className="flex gap-3 flex-wrap">
            {seat_history.map((m) => (
              <div key={m.month} className="text-center">
                <p className="text-lg font-bold text-text-primary">{m.active_seats}</p>
                <p className="text-xs text-text-muted">{m.month}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Usage & cost trend (last 12 months) */}
      {trend.length > 0 && (
        <div className="bg-white rounded-card border border-border p-4">
          <h2 className="text-sm font-semibold text-text-primary mb-3">Usage &amp; cost trend</h2>
          {(() => {
            const maxCalls = Math.max(...trend.map((m) => m.calls), 1);
            const maxCost = Math.max(...trend.map((m) => m.claude_cost_estimate + m.deepgram_cost_estimate), 0.0001);
            return (
              <div className="flex items-end gap-3 overflow-x-auto pb-1">
                {trend.map((m) => {
                  const cost = m.claude_cost_estimate + m.deepgram_cost_estimate;
                  return (
                    <div key={m.month} className="flex flex-col items-center gap-1 shrink-0 w-12" title={`${m.calls} calls · £${cost.toFixed(2)} cost · ${m.active_seats} seats`}>
                      <div className="flex items-end gap-0.5 h-24">
                        <div className="w-3 bg-primary rounded-t" style={{ height: `${Math.max((m.calls / maxCalls) * 96, 2)}px` }} />
                        <div className="w-3 bg-chart-secondary rounded-t" style={{ height: `${Math.max((cost / maxCost) * 96, 2)}px` }} />
                      </div>
                      <span className="text-[10px] text-text-muted">{m.month.slice(2)}</span>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <div className="flex gap-4 mt-2 text-xs text-text-muted">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-primary rounded-sm" /> Calls</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-chart-secondary rounded-sm" /> Running cost</span>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="bg-white rounded-card border border-border p-4 space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Subscription</h2>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Plan</label>
            <select
              value={planValue}
              onChange={(e) => setPlanValue(e.target.value)}
              className="border border-border rounded-btn px-3 py-2 text-sm"
            >
              {PLANS.map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
            </select>
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-text-muted mb-1">Notes</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Invoice #123, annual discount"
              className="w-full border border-border rounded-btn px-3 py-2 text-sm"
            />
          </div>
          <button onClick={savePlan} disabled={saving} className="bg-primary text-white px-4 py-2 rounded-btn text-sm font-semibold hover:bg-primary-hover disabled:opacity-60">
            Save plan
          </button>
        </div>
        <div className="flex gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Status</label>
            <select
              value={statusValue}
              onChange={(e) => setStatusValue(e.target.value)}
              className="border border-border rounded-btn px-3 py-2 text-sm"
            >
              {['active', 'suspended', 'cancelled'].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <button onClick={saveStatus} disabled={saving} className="bg-primary text-white px-4 py-2 rounded-btn text-sm font-semibold hover:bg-primary-hover disabled:opacity-60">
            Save status
          </button>
          <button onClick={impersonate} className="border border-border text-text-secondary px-4 py-2 rounded-btn text-sm hover:bg-gray-50">
            Impersonate admin
          </button>
        </div>
        <div className="flex gap-3 items-end pt-2 border-t border-border">
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Seat price override (£/seat/mo)</label>
            <input
              type="number"
              min="0"
              step="1"
              value={priceOverride}
              onChange={(e) => setPriceOverride(e.target.value)}
              placeholder={`Default £${SEAT_PRICING[org.plan as Plan] ?? '—'}`}
              className="border border-border rounded-btn px-3 py-2 text-sm w-48"
            />
          </div>
          <button onClick={saveSeatPrice} disabled={saving} className="bg-primary text-white px-4 py-2 rounded-btn text-sm font-semibold hover:bg-primary-hover disabled:opacity-60">
            Save price
          </button>
          <p className="text-xs text-text-muted pb-2">
            Blank = the {PLAN_LABELS[org.plan as Plan] ?? org.plan} default (£{SEAT_PRICING[org.plan as Plan] ?? '—'}/seat). Set a value to give this tenant a negotiated rate.
          </p>
        </div>
        {saveMsg && <p className="text-sm text-pass">{saveMsg}</p>}
      </div>

      {/* Feature overrides */}
      <div className="bg-white rounded-card border border-border p-4">
        <h2 className="text-sm font-semibold text-text-primary">Feature overrides</h2>
        <p className="text-xs text-text-muted mt-0.5 mb-3">
          Grant or deny a plan-gated feature for this tenant, beyond their plan. Leave on “Plan default” to follow the tier.
        </p>
        <div className="space-y-2">
          {GATED_FEATURES.map((f) => {
            const ov = org.feature_overrides ?? {};
            const current = Object.prototype.hasOwnProperty.call(ov, f) ? (ov[f] ? 'grant' : 'deny') : 'default';
            const onTier = (FEATURES[f] as readonly string[]).includes(org.plan);
            return (
              <div key={f} className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-sm text-text-primary">{FEATURE_LABELS[f] ?? f}</span>
                  <span className="ml-2 text-xs text-text-muted">{onTier ? 'on this plan' : 'not on this plan'}</span>
                </div>
                <select
                  value={current}
                  disabled={featSaving === f}
                  onChange={(e) => {
                    const v = e.target.value;
                    setFeature(f, v === 'default' ? null : v === 'grant');
                  }}
                  className="border border-border rounded px-2 py-1 text-xs disabled:opacity-60"
                >
                  <option value="default">Plan default</option>
                  <option value="grant">Grant</option>
                  <option value="deny">Deny</option>
                </select>
              </div>
            );
          })}
        </div>
      </div>

      {/* Failed / stuck calls */}
      {failed.length > 0 && (
        <div className="bg-white rounded-card border border-border overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-text-primary">Failed &amp; stuck calls ({failed.length})</h2>
            <p className="text-xs text-text-muted mt-0.5">Calls that failed or have sat in a processing state over 15 minutes.</p>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-border">
              <tr>
                {['Call', 'Status', 'Agent', 'Error', 'Last update'].map((h) => (
                  <th key={h} className="text-left px-4 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {failed.map((c) => (
                <tr key={c.id} className="align-top">
                  <td className="px-4 py-2 font-mono text-xs text-text-secondary">{c.external_id || c.file_name || c.id.slice(0, 8)}</td>
                  <td className="px-4 py-2">
                    <span className={`text-[11px] font-semibold uppercase px-2 py-0.5 rounded ${c.status === 'failed' ? 'bg-fail-bg text-fail' : 'bg-review-bg text-review'}`}>
                      {c.stuck ? 'stuck' : c.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-text-secondary">{c.agent_name ?? '—'}</td>
                  <td className="px-4 py-2 text-text-muted max-w-xs truncate" title={c.error_message ?? ''}>{c.error_message ?? '—'}</td>
                  <td className="px-4 py-2 text-text-muted whitespace-nowrap">{new Date(c.updated_at).toLocaleString('en-GB')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Users */}
      <div className="bg-white rounded-card border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-text-primary">Users ({users.length})</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Tier override bumps a user above the org plan — they pay the higher tier rate.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-border">
            <tr>
              {['Name', 'Email', 'Role', 'Last active', 'Tier override'].map((h) => (
                <th key={h} className="text-left px-4 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-2 text-text-primary">{u.name}</td>
                <td className="px-4 py-2 text-text-secondary">{u.email}</td>
                <td className="px-4 py-2 text-text-muted capitalize">{u.role}</td>
                <td className="px-4 py-2 text-text-muted">
                  {u.last_active_at ? new Date(u.last_active_at).toLocaleString('en-GB') : '—'}
                </td>
                <td className="px-4 py-2">
                  <select
                    value={u.plan_override ?? ''}
                    disabled={tierSaving === u.id}
                    onChange={(e) => setUserTier(u.id, e.target.value || null)}
                    className="border border-border rounded px-2 py-1 text-xs disabled:opacity-60"
                  >
                    <option value="">— Org plan —</option>
                    {PLANS.map((p) => (
                      <option key={p} value={p}>{PLAN_LABELS[p]}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
