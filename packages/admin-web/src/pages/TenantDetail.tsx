import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import { PLANS, PLAN_LABELS, SEAT_PRICING } from '@callguard/shared';
import type { Plan } from '@callguard/shared';

interface OrgDetail {
  id: string;
  name: string;
  plan: string;
  status: string;
  created_at: string;
  suspended_at: string | null;
  subscription_notes: string | null;
  seat_price_override: string | null;
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
  const [error, setError] = useState('');
  const [planValue, setPlanValue] = useState('');
  const [statusValue, setStatusValue] = useState('');
  const [notes, setNotes] = useState('');
  const [priceOverride, setPriceOverride] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [tierSaving, setTierSaving] = useState<string | null>(null);

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
  }, [id]);

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
