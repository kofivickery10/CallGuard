import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PLANS, PLAN_LABELS, type Plan } from '@callguard/shared';
import { api } from '../api/client';

interface TenantDetail {
  id: string;
  name: string;
  plan: string;
  adviser_channel: number | null;
  data_improvement_opt_in: boolean;
  created_at: string;
  stats: { user_count: number; active_seats: number; calls_scored: number };
}
interface TenantUser { id: string; name: string; email: string; role: string; is_staff: boolean; created_at: string }
interface PendingInvite { id: string; name: string; email: string; role: string; expires_at: string }

const ROLES = ['admin', 'supervisor', 'viewer', 'adviser'];

export function TenantDetail() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [error, setError] = useState('');

  const { data: t } = useQuery({
    queryKey: ['admin-tenant', id],
    queryFn: () => api.get<TenantDetail>(`/admin/tenants/${id}`),
  });
  const { data: usersData } = useQuery({
    queryKey: ['admin-tenant-users', id],
    queryFn: () => api.get<{ users: TenantUser[]; pending_invites: PendingInvite[] }>(`/admin/tenants/${id}/users`),
  });

  const [name, setName] = useState('');
  const [plan, setPlan] = useState<Plan>('growth');
  const [channel, setChannel] = useState<number | null>(null);
  useEffect(() => {
    if (t) { setName(t.name); setPlan(t.plan as Plan); setChannel(t.adviser_channel); }
  }, [t]);

  const save = useMutation({
    mutationFn: () => api.put(`/admin/tenants/${id}`, { name, plan, adviser_channel: channel }),
    onSuccess: () => { setError(''); queryClient.invalidateQueries({ queryKey: ['admin-tenant', id] }); queryClient.invalidateQueries({ queryKey: ['admin-tenants'] }); },
    onError: (e) => setError((e as Error).message),
  });

  const [resendMsg, setResendMsg] = useState('');
  const resend = useMutation({
    mutationFn: (inviteId: string) => api.post<{ email_sent: boolean }>(`/admin/invites/${inviteId}/resend`, {}),
    onSuccess: (r) => setResendMsg(r.email_sent ? 'Invite resent.' : 'Resend failed — email not sent.'),
    onError: (e) => setResendMsg((e as Error).message),
  });

  if (!t) return <div className="text-table-cell text-text-muted">Loading…</div>;

  return (
    <div className="max-w-[820px]">
      <Link to="/admin/tenants" className="text-[12px] text-text-muted hover:text-primary">← Tenants</Link>
      <h2 className="text-page-title text-text-primary mt-2 mb-1">{t.name}</h2>
      <p className="text-page-sub text-text-subtle mb-5 capitalize">{t.plan} plan · created {new Date(t.created_at).toLocaleDateString('en-GB')}</p>

      {/* Aggregate stats */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <Stat label="Users" value={t.stats.user_count} />
        <Stat label="Active seats (mo)" value={t.stats.active_seats} />
        <Stat label="Calls scored" value={t.stats.calls_scored} />
      </div>

      {/* Settings */}
      <div className="bg-white border border-border rounded-card p-5 mb-5">
        <h3 className="text-[13px] uppercase tracking-wider text-text-muted font-semibold mb-3">Settings</h3>
        {error && <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mb-3">{error}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12px] font-semibold text-text-secondary mb-1">Name</span>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="block text-[12px] font-semibold text-text-secondary mb-1">Plan</span>
            <select className={inputCls} value={plan} onChange={(e) => setPlan(e.target.value as Plan)}>
              {PLANS.map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-[12px] font-semibold text-text-secondary mb-1">Adviser channel</span>
            <select className={inputCls} value={channel === null ? 'auto' : String(channel)} onChange={(e) => setChannel(e.target.value === 'auto' ? null : Number(e.target.value))}>
              <option value="auto">Auto-detect</option>
              <option value="0">Left</option>
              <option value="1">Right</option>
            </select>
          </label>
        </div>
        <button onClick={() => save.mutate()} disabled={save.isPending} className="mt-4 bg-primary text-white px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-primary-hover disabled:opacity-50">
          {save.isPending ? 'Saving…' : 'Save settings'}
        </button>
      </div>

      {/* Users */}
      <div className="bg-white border border-border rounded-card p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[13px] uppercase tracking-wider text-text-muted font-semibold">Users</h3>
        </div>
        <table className="w-full mb-4">
          <tbody>
            {(usersData?.users ?? []).map((u) => (
              <tr key={u.id} className="border-b border-border-light">
                <td className="py-2 text-table-cell font-medium text-text-primary">{u.name}</td>
                <td className="py-2 text-table-cell text-text-muted">{u.email}</td>
                <td className="py-2 text-table-cell text-text-secondary capitalize text-right">{u.role}{u.is_staff ? ' · staff' : ''}</td>
              </tr>
            ))}
            {(usersData?.pending_invites ?? []).map((p) => (
              <tr key={p.id} className="border-b border-border-light">
                <td className="py-2 text-table-cell font-medium text-text-primary opacity-70">{p.name}</td>
                <td className="py-2 text-table-cell text-text-muted opacity-70">{p.email}</td>
                <td className="py-2 text-right whitespace-nowrap">
                  <span className="text-table-cell text-review capitalize mr-3">{p.role} · pending</span>
                  <button
                    onClick={() => resend.mutate(p.id)}
                    disabled={resend.isPending}
                    className="text-[12px] font-semibold text-primary hover:underline disabled:opacity-50"
                  >
                    Resend
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {resendMsg && <p className="text-[12px] text-text-muted -mt-2 mb-3">{resendMsg}</p>}
        <AddUser tenantId={id!} />
      </div>
    </div>
  );
}

function AddUser({ tenantId }: { tenantId: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [msg, setMsg] = useState('');

  const invite = useMutation({
    mutationFn: () => api.post<{ email_sent: boolean }>(`/admin/tenants/${tenantId}/users`, { name, email, role }),
    onSuccess: (r) => {
      setMsg(r.email_sent ? `Invite emailed to ${email}` : `Created, but email failed`);
      setName(''); setEmail('');
      queryClient.invalidateQueries({ queryKey: ['admin-tenant-users', tenantId] });
    },
    onError: (e) => setMsg((e as Error).message),
  });

  return (
    <div className="border-t border-border-light pt-3">
      <div className="text-[12px] font-semibold text-text-secondary mb-2">Add user (emailed invite)</div>
      <form
        onSubmit={(e) => { e.preventDefault(); if (name && email) invite.mutate(); }}
        className="flex flex-wrap gap-2 items-center"
      >
        <input className={`${inputCls} flex-1 min-w-[120px]`} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="email" className={`${inputCls} flex-1 min-w-[160px]`} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <button type="submit" disabled={invite.isPending} className="bg-primary text-white px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-primary-hover disabled:opacity-50">
          {invite.isPending ? '…' : 'Invite'}
        </button>
      </form>
      {msg && <p className="text-[12px] text-text-muted mt-2">{msg}</p>}
    </div>
  );
}

const inputCls = 'border border-border rounded-btn px-3 py-2 text-table-cell focus:outline-none focus:border-primary';
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white border border-border rounded-card p-4">
      <div className="text-card-label uppercase text-text-muted">{label}</div>
      <div className="text-card-value text-text-primary mt-1">{value}</div>
    </div>
  );
}
