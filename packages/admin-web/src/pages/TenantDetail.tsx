import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useDialog } from '../components/DialogProvider';
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
  adviser_channel: number | null;
  scoring_scope: string;
  min_scoreable_seconds: number;
  min_scoreable_words: number;
  pass_threshold: number;
  retention_days: number;
  transcription_mode: string;
  deepgram_region: string;
}

interface ScoringForm {
  adviser_channel: number | null;
  scoring_scope: string;
  min_scoreable_seconds: number;
  min_scoreable_words: number;
  pass_threshold: number;
  retention_days: number;
  transcription_mode: string;
  deepgram_region: string;
}

const SCOPE_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: 'sales_only', label: 'Sales only', hint: 'Score journeys once a sale is confirmed. Every call is still transcribed.' },
  { value: 'over_threshold', label: 'Over length threshold', hint: 'Score every call once it clears the length threshold below.' },
  { value: 'everything', label: 'Everything', hint: 'Score every transcribed call, regardless of length.' },
];

const CHANNEL_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Auto-detect' },
  { value: 0, label: 'Left channel' },
  { value: 1, label: 'Right channel' },
];
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
  billing_exempt: boolean;
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
  const navigate = useNavigate();
  const { confirm, notify } = useDialog();
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
  const [resetting2fa, setResetting2fa] = useState<string | null>(null);
  const [billingSaving, setBillingSaving] = useState<string | null>(null);
  const [featSaving, setFeatSaving] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState('');
  const [seedOpen, setSeedOpen] = useState(false);
  const [seedName, setSeedName] = useState('');
  const [seedEmail, setSeedEmail] = useState('');
  const [seedSkip2fa, setSeedSkip2fa] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [seedErr, setSeedErr] = useState('');
  const [seedResult, setSeedResult] = useState<{ admin_email: string; temp_password: string; two_factor_exempt: boolean } | null>(null);
  const [scoringForm, setScoringForm] = useState<ScoringForm | null>(null);
  const [savingScoring, setSavingScoring] = useState(false);
  const [scoringMsg, setScoringMsg] = useState('');

  useEffect(() => {
    if (!id) return;
    api.get<TenantDetailData>(`/superadmin/tenants/${id}`)
      .then((d) => {
        setData(d);
        setPlanValue(d.org.plan);
        setStatusValue(d.org.status);
        setNotes(d.org.subscription_notes ?? '');
        setPriceOverride(d.org.seat_price_override ?? '');
        setScoringForm({
          adviser_channel: d.org.adviser_channel ?? null,
          scoring_scope: d.org.scoring_scope ?? 'sales_only',
          min_scoreable_seconds: d.org.min_scoreable_seconds ?? 15,
          min_scoreable_words: d.org.min_scoreable_words ?? 30,
          pass_threshold: d.org.pass_threshold ?? 70,
          retention_days: d.org.retention_days ?? 1825,
          transcription_mode: d.org.transcription_mode ?? 'mono_diarize',
          deepgram_region: d.org.deepgram_region ?? 'eu',
        });
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
      await notify(e instanceof Error ? e.message : 'Failed to set feature');
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

  const saveScoring = async () => {
    if (!id || !scoringForm) return;
    setSavingScoring(true); setScoringMsg('');
    try {
      const updated = await api.put<Partial<OrgDetail>>(`/superadmin/tenants/${id}/scoring-settings`, scoringForm);
      setData((prev) => prev ? { ...prev, org: { ...prev.org, ...updated } } : prev);
      setScoringMsg('Call & scoring settings saved');
    } catch (e) {
      setScoringMsg(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSavingScoring(false);
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

  const seedAdmin = async () => {
    if (!id) return;
    setSeeding(true); setSeedErr('');
    try {
      const r = await api.post<{ user_id: string; admin_email: string; temp_password: string; two_factor_exempt: boolean }>(
        `/superadmin/tenants/${id}/admin`, { admin_name: seedName.trim(), admin_email: seedEmail.trim(), skip_2fa: seedSkip2fa }
      );
      setSeedResult({ admin_email: r.admin_email, temp_password: r.temp_password, two_factor_exempt: r.two_factor_exempt });
      // Refresh the users table so the new admin shows.
      api.get<TenantDetailData>(`/superadmin/tenants/${id}`).then(setData).catch(() => {});
    } catch (e) {
      setSeedErr(e instanceof Error ? e.message : 'Failed to seed admin');
    } finally {
      setSeeding(false);
    }
  };

  const deleteTenant = async () => {
    if (!id) return;
    setDeleting(true); setDeleteErr('');
    try {
      await api.delete(`/superadmin/tenants/${id}`, { confirm_name: deleteConfirm });
      navigate('/tenants', { replace: true });
    } catch (e) {
      setDeleteErr(e instanceof Error ? e.message : 'Failed to delete tenant');
      setDeleting(false);
    }
  };

  const impersonate = async () => {
    if (!id || !(await confirm('Open a 1-hour impersonation session as this tenant\'s admin?'))) return;
    try {
      const r = await api.post<{ token: string; url: string; note: string }>(`/superadmin/tenants/${id}/impersonate`, {});
      // Opens the tenant app directly with the session already established —
      // previously this just showed the raw JWT in a prompt(), which ops then
      // had to manually paste into devtools localStorage to use.
      window.open(r.url, '_blank', 'noopener');
    } catch (e) {
      await notify(e instanceof Error ? e.message : 'Failed');
    }
  };

  const resetUserTwoFactor = async (userId: string, name: string) => {
    if (!(await confirm(`Reset 2FA for ${name}? They will need to re-enrol on next login.`, { danger: true }))) return;
    setResetting2fa(userId);
    try {
      await api.post(`/superadmin/users/${userId}/reset-2fa`, {});
      await notify(`2FA reset for ${name}.`);
    } catch (e) {
      await notify(e instanceof Error ? e.message : 'Failed to reset 2FA');
    } finally {
      setResetting2fa(null);
    }
  };

  const setUserBillingExempt = async (userId: string, exempt: boolean) => {
    if (!id) return;
    setBillingSaving(userId);
    try {
      const result = await api.put<{ user_id: string; billing_exempt: boolean }>(
        `/superadmin/tenants/${id}/users/${userId}/billing-exempt`,
        { exempt }
      );
      setData((prev) => prev ? {
        ...prev,
        users: prev.users.map((u) =>
          u.id === userId ? { ...u, billing_exempt: result.billing_exempt } : u
        ),
      } : prev);
    } catch (e) {
      await notify(e instanceof Error ? e.message : 'Failed to update billing exemption');
    } finally {
      setBillingSaving(null);
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
      await notify(e instanceof Error ? e.message : 'Failed to set tier');
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
        <h2 className="text-page-title text-text-primary">{org.name}</h2>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Total calls',    value: stats.total_calls },
          { label: 'Scored calls',   value: stats.scored_calls },
          { label: 'Failed calls',   value: stats.failed_calls },
          { label: 'Audio (minutes)', value: durationMins },
        ].map(({ label, value }) => (
          <div key={label} className="bg-card rounded-card p-4 border border-border">
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-1">{label}</p>
            <p className="text-card-value text-text-primary">{value}</p>
          </div>
        ))}
      </div>

      {/* Seat history */}
      {seat_history.length > 0 && (
        <div className="bg-card rounded-card border border-border p-4">
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
        <div className="bg-card rounded-card border border-border p-4">
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
      <div className="bg-card rounded-card border border-border p-4 space-y-4">
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
          <button onClick={impersonate} className="border border-border text-text-secondary px-4 py-2 rounded-btn text-sm hover:bg-sidebar-hover">
            Impersonate admin
          </button>
          <button
            onClick={() => { setSeedOpen(true); setSeedName(''); setSeedEmail(''); setSeedSkip2fa(false); setSeedErr(''); setSeedResult(null); }}
            className="border border-border text-text-secondary px-4 py-2 rounded-btn text-sm hover:bg-sidebar-hover"
            title="Create a bootstrap admin login for this tenant — e.g. a temporary setup account, removed before go-live"
          >
            Seed admin login
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
      <div className="bg-card rounded-card border border-border p-4">
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

      {/* Call recording & scoring policy — staff-controlled, not tenant self-serve */}
      {scoringForm && (
        <div className="bg-card rounded-card border border-border p-4 space-y-5">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Call recording &amp; scoring policy</h2>
            <p className="text-xs text-text-muted mt-0.5">
              Configured by CallGuard staff, not the tenant. Carries cost, retention/compliance and
              data-residency implications.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1.5">
              Adviser recording channel
            </label>
            <div className="flex flex-wrap gap-2">
              {CHANNEL_OPTIONS.map((opt) => {
                const active = scoringForm.adviser_channel === opt.value;
                return (
                  <button
                    key={String(opt.value)}
                    type="button"
                    onClick={() => setScoringForm({ ...scoringForm, adviser_channel: opt.value })}
                    className={`px-3 py-2 rounded-btn text-sm border transition-colors ${
                      active
                        ? 'border-primary bg-primary-light text-pass font-semibold'
                        : 'border-border text-text-secondary hover:border-primary/50'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1.5">Scoring scope</label>
            <div className="flex flex-wrap gap-2">
              {SCOPE_OPTIONS.map((opt) => {
                const active = scoringForm.scoring_scope === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    title={opt.hint}
                    onClick={() => setScoringForm({ ...scoringForm, scoring_scope: opt.value })}
                    className={`px-3 py-2 rounded-btn text-sm border transition-colors ${
                      active
                        ? 'border-primary bg-primary-light text-pass font-semibold'
                        : 'border-border text-text-secondary hover:border-primary/50'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-text-muted mt-1.5">
              {SCOPE_OPTIONS.find((o) => o.value === scoringForm.scoring_scope)?.hint}
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <ScoringNumberField
              label="Skip under (seconds)"
              value={scoringForm.min_scoreable_seconds}
              onChange={(v) => setScoringForm({ ...scoringForm, min_scoreable_seconds: v })}
            />
            <ScoringNumberField
              label="Skip under (words)"
              value={scoringForm.min_scoreable_words}
              onChange={(v) => setScoringForm({ ...scoringForm, min_scoreable_words: v })}
            />
            <ScoringNumberField
              label="Pass threshold (%)"
              value={scoringForm.pass_threshold}
              min={0}
              max={100}
              onChange={(v) => setScoringForm({ ...scoringForm, pass_threshold: v })}
            />
            <ScoringNumberField
              label="Retention (days)"
              value={scoringForm.retention_days}
              min={30}
              onChange={(v) => setScoringForm({ ...scoringForm, retention_days: v })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1.5">Transcription mode</label>
              <select
                value={scoringForm.transcription_mode}
                onChange={(e) => setScoringForm({ ...scoringForm, transcription_mode: e.target.value })}
                className="w-full border border-border rounded-btn px-3 py-2 text-sm"
              >
                <option value="mono_diarize">Mono (diarise speakers)</option>
                <option value="stereo_multichannel">Split-stereo (separate channels)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1.5">Deepgram region</label>
              <select
                value={scoringForm.deepgram_region}
                onChange={(e) => setScoringForm({ ...scoringForm, deepgram_region: e.target.value })}
                className="w-full border border-border rounded-btn px-3 py-2 text-sm"
              >
                <option value="eu">EU (UK/EU data residency)</option>
                <option value="us">US</option>
              </select>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={saveScoring}
              disabled={savingScoring}
              className="bg-primary text-white px-4 py-2 rounded-btn text-sm font-semibold hover:bg-primary-hover disabled:opacity-60"
            >
              {savingScoring ? 'Saving…' : 'Save call & scoring settings'}
            </button>
            {scoringMsg && <p className="text-sm text-pass">{scoringMsg}</p>}
          </div>
        </div>
      )}

      {/* Failed / stuck calls */}
      {failed.length > 0 && (
        <div className="bg-card rounded-card border border-border overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-text-primary">Failed &amp; stuck calls ({failed.length})</h2>
            <p className="text-xs text-text-muted mt-0.5">Calls that failed or have sat in a processing state over 15 minutes.</p>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-table-header border-b border-border">
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
      <div className="bg-card rounded-card border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-text-primary">Users ({users.length})</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Tier override bumps a user above the org plan — they pay the higher tier rate. Mark an
            internal/setup login <span className="font-medium">billing-exempt</span> to drop it from
            this tenant's billable seat count.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-table-header border-b border-border">
            <tr>
              {['Name', 'Email', 'Role', 'Last active', 'Tier override', 'Billing', ''].map((h) => (
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
                <td className="px-4 py-2">
                  <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
                    <input
                      type="checkbox"
                      checked={u.billing_exempt}
                      disabled={billingSaving === u.id}
                      onChange={(e) => setUserBillingExempt(u.id, e.target.checked)}
                      className="disabled:opacity-60"
                    />
                    Exempt
                  </label>
                </td>
                <td className="px-4 py-2">
                  <button
                    onClick={() => resetUserTwoFactor(u.id, u.name)}
                    disabled={resetting2fa === u.id}
                    className="text-xs text-primary hover:underline disabled:opacity-60"
                    title="Reset 2FA — for a user locked out of their authenticator and backup codes"
                  >
                    {resetting2fa === u.id ? 'Resetting…' : 'Reset 2FA'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Danger zone — permanent hard delete */}
      <div className="border border-fail/40 rounded-card p-6 space-y-3">
        <h2 className="text-sm font-semibold text-fail uppercase tracking-wider">Danger zone</h2>
        <p className="text-sm text-text-secondary">
          Permanently delete <span className="font-semibold text-text-primary">{org.name}</span> and
          all of its data — calls, scores, scorecards, breaches, knowledge base, users and audit log.
          This cannot be undone. To retire a tenant reversibly, set its status to{' '}
          <span className="font-medium">cancelled</span> instead.
        </p>
        <button
          onClick={() => { setDeleteOpen(true); setDeleteConfirm(''); setDeleteErr(''); }}
          className="border border-fail text-fail px-4 py-2 rounded-btn text-sm font-semibold hover:bg-fail-bg"
        >
          Delete tenant…
        </button>
      </div>

      {seedOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border rounded-card shadow-lg w-full max-w-md p-6 space-y-4">
            <h3 className="text-lg font-semibold text-text-primary">Seed an admin login</h3>
            {seedResult ? (
              <>
                <p className="text-sm text-text-secondary">
                  Admin created for <span className="font-semibold">{org.name}</span>. Share these over a
                  secure channel — the temp password is shown once.{' '}
                  {seedResult.two_factor_exempt
                    ? 'This login is 2FA-exempt — remove it before go-live.'
                    : 'They\'ll change it and enrol 2FA on first login.'}
                </p>
                <div className="bg-sidebar-hover rounded-btn p-3 text-sm space-y-1">
                  <div><span className="text-text-muted">Email:</span> <span className="font-mono">{seedResult.admin_email}</span></div>
                  <div><span className="text-text-muted">Temp password:</span> <span className="font-mono font-semibold">{seedResult.temp_password}</span></div>
                </div>
                <div className="flex justify-end pt-1">
                  <button onClick={() => setSeedOpen(false)} className="bg-primary text-white px-4 py-2 rounded-btn text-sm font-semibold hover:bg-primary-hover">Done</button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-text-secondary">
                  Creates an <span className="font-medium">admin</span> user for this tenant with a one-time
                  temporary password. Use it to configure the account; remove it (Team table) before go-live.
                </p>
                <div>
                  <label className="block text-xs font-medium text-text-muted mb-1">Name</label>
                  <input type="text" value={seedName} onChange={(e) => setSeedName(e.target.value)} placeholder="Setup Admin" autoFocus className="w-full border border-border rounded-btn px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-muted mb-1">Email</label>
                  <input type="email" value={seedEmail} onChange={(e) => setSeedEmail(e.target.value)} placeholder="setup@yourdomain.com" className="w-full border border-border rounded-btn px-3 py-2 text-sm" />
                </div>
                <label className="flex items-start gap-2 text-sm text-text-secondary">
                  <input type="checkbox" checked={seedSkip2fa} onChange={(e) => setSeedSkip2fa(e.target.checked)} className="mt-0.5" />
                  <span>
                    Skip 2FA for this login
                    <span className="block text-xs text-text-muted">Bypasses mandatory two-factor enrolment. Only for a temporary internal setup account — remove it before go-live.</span>
                  </span>
                </label>
                {seedErr && <p className="text-sm text-fail">{seedErr}</p>}
                <div className="flex justify-end gap-3 pt-1">
                  <button onClick={() => setSeedOpen(false)} disabled={seeding} className="border border-border text-text-secondary px-4 py-2 rounded-btn text-sm hover:bg-sidebar-hover disabled:opacity-60">Cancel</button>
                  <button
                    onClick={seedAdmin}
                    disabled={seeding || !seedName.trim() || !seedEmail.trim()}
                    className="bg-primary text-white px-4 py-2 rounded-btn text-sm font-semibold hover:bg-primary-hover disabled:opacity-40"
                  >
                    {seeding ? 'Creating…' : 'Create admin'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {deleteOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border rounded-card shadow-lg w-full max-w-md p-6 space-y-4">
            <h3 className="text-lg font-semibold text-text-primary">Delete this tenant?</h3>
            <p className="text-sm text-text-secondary">
              This permanently removes <span className="font-semibold">{org.name}</span> and everything
              belonging to it. This action is irreversible. Type the tenant name to confirm:
            </p>
            <input
              type="text"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={org.name}
              autoFocus
              className="w-full border border-border rounded-btn px-3 py-2 text-sm"
            />
            {deleteErr && <p className="text-sm text-fail">{deleteErr}</p>}
            <div className="flex justify-end gap-3 pt-1">
              <button
                onClick={() => setDeleteOpen(false)}
                disabled={deleting}
                className="border border-border text-text-secondary px-4 py-2 rounded-btn text-sm hover:bg-sidebar-hover disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                onClick={deleteTenant}
                disabled={deleting || deleteConfirm !== org.name}
                className="bg-fail text-white px-4 py-2 rounded-btn text-sm font-semibold hover:opacity-90 disabled:opacity-40"
              >
                {deleting ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ScoringNumberField({
  label,
  value,
  onChange,
  min = 0,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-text-muted mb-1.5">{label}</label>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        onBlur={(e) => {
          // Snap back into range on blur so a cleared/0 retention field can't be
          // saved below its floor — the purge job treats retention_days=0 as
          // "delete everything older than now". Server enforces the same floor.
          const n = Number(e.target.value) || 0;
          const clamped = Math.min(max ?? Infinity, Math.max(min ?? 0, n));
          if (clamped !== value) onChange(clamped);
        }}
        className="w-full border border-border rounded-btn px-3 py-2 text-sm"
      />
    </div>
  );
}
