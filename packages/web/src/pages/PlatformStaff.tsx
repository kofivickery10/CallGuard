import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';

interface StaffUser {
  id: string;
  name: string;
  email: string;
  is_superadmin: boolean;
  created_at: string;
}
interface PendingStaff {
  id: string;
  name: string;
  email: string;
  is_superadmin: boolean;
  expires_at: string;
}

export function PlatformStaff() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [showInvite, setShowInvite] = useState(false);
  const [msg, setMsg] = useState('');

  const { data } = useQuery({
    queryKey: ['admin-staff'],
    queryFn: () => api.get<{ staff: StaffUser[]; pending_invites: PendingStaff[] }>('/admin/staff'),
  });
  const staff = data?.staff ?? [];
  const pending = data?.pending_invites ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin-staff'] });

  const setLevel = useMutation({
    mutationFn: (v: { id: string; is_superadmin: boolean }) =>
      api.put(`/admin/staff/${v.id}`, { is_superadmin: v.is_superadmin }),
    onSuccess: () => { setMsg(''); invalidate(); },
    onError: (e) => setMsg((e as Error).message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/staff/${id}`),
    onSuccess: () => { setMsg(''); invalidate(); },
    onError: (e) => setMsg((e as Error).message),
  });

  return (
    <div className="max-w-[840px]">
      <div className="flex items-start justify-between mb-5">
        <div>
          <h2 className="text-page-title text-text-primary">Platform staff</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            CallGuard team members. <strong>Support</strong> can use the support inbox and see read-only platform
            analytics. <strong>Superadmins</strong> can also provision tenants and manage staff.
          </p>
        </div>
        <button
          onClick={() => setShowInvite(true)}
          className="bg-primary text-white px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-primary-hover transition-colors"
        >
          + Invite staff
        </button>
      </div>

      {msg && <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mb-3">{msg}</div>}

      <div className="bg-white border border-border rounded-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-table-header border-b border-border">
              {['Name', 'Email', 'Level', ''].map((h, idx) => (
                <th key={idx} className="text-left text-table-header uppercase text-text-muted px-4 py-2.5">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => {
              const isSelf = s.id === user?.id;
              return (
                <tr key={s.id} className="border-b border-border-light">
                  <td className="px-4 py-3 text-table-cell font-semibold text-text-primary">{s.name}{isSelf && <span className="text-text-muted font-normal"> (you)</span>}</td>
                  <td className="px-4 py-3 text-table-cell text-text-muted">{s.email}</td>
                  <td className="px-4 py-3">
                    <span className={`text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded ${s.is_superadmin ? 'bg-primary-light text-pass' : 'bg-table-header text-text-muted'}`}>
                      {s.is_superadmin ? 'Superadmin' : 'Support'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {!isSelf && (
                      <>
                        <button
                          onClick={() => setLevel.mutate({ id: s.id, is_superadmin: !s.is_superadmin })}
                          disabled={setLevel.isPending}
                          className="text-[12px] font-semibold text-primary hover:underline mr-3 disabled:opacity-50"
                        >
                          {s.is_superadmin ? 'Make support' : 'Make superadmin'}
                        </button>
                        <button
                          onClick={() => { if (confirm(`Revoke platform access for ${s.email}?`)) revoke.mutate(s.id); }}
                          disabled={revoke.isPending}
                          className="text-[12px] font-semibold text-fail hover:underline disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {pending.map((p) => (
              <tr key={p.id} className="border-b border-border-light">
                <td className="px-4 py-3 text-table-cell font-semibold text-text-primary opacity-70">{p.name}</td>
                <td className="px-4 py-3 text-table-cell text-text-muted opacity-70">{p.email}</td>
                <td className="px-4 py-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    {p.is_superadmin ? 'Superadmin' : 'Support'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-[12px] text-review">invite pending</td>
              </tr>
            ))}
            {staff.length === 0 && pending.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-table-cell text-text-muted">No staff yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showInvite && <InviteStaffModal onClose={() => setShowInvite(false)} onDone={invalidate} />}
    </div>
  );
}

function InviteStaffModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [level, setLevel] = useState<'support' | 'superadmin'>('support');
  const [done, setDone] = useState<{ email_sent: boolean; email_error?: string } | null>(null);

  const invite = useMutation({
    mutationFn: () => api.post<{ email_sent: boolean; email_error?: string }>('/admin/staff', { name, email, level }),
    onSuccess: (r) => { setDone(r); onDone(); },
  });

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        {done ? (
          <div>
            <h3 className="text-[16px] font-bold text-text-primary mb-2">Staff invited</h3>
            <p className={`text-table-cell ${done.email_sent ? 'text-text-secondary' : 'text-fail'}`}>
              {done.email_sent
                ? `An invitation was emailed to ${email}.`
                : `Invited, but the email failed${done.email_error ? `: ${done.email_error}` : ''}. Resend from the list once email is configured.`}
            </p>
            <button onClick={onClose} className="mt-4 w-full bg-primary text-white px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-primary-hover">Done</button>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); if (name && email) invite.mutate(); }}>
            <h3 className="text-[16px] font-bold text-text-primary mb-4">Invite platform staff</h3>
            <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required /></Field>
            <Field label="Email"><input type="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
            <Field label="Level">
              <select className={inputCls} value={level} onChange={(e) => setLevel(e.target.value as 'support' | 'superadmin')}>
                <option value="support">Support — inbox + read-only analytics</option>
                <option value="superadmin">Superadmin — full access</option>
              </select>
            </Field>
            {invite.isError && <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mb-3">{(invite.error as Error).message}</div>}
            <div className="flex gap-2 mt-1">
              <button type="button" onClick={onClose} className="flex-1 border border-border text-text-secondary px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-sidebar-hover">Cancel</button>
              <button type="submit" disabled={invite.isPending} className="flex-1 bg-primary text-white px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-primary-hover disabled:opacity-50">
                {invite.isPending ? 'Inviting…' : 'Send invite'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

const inputCls = 'w-full border border-border rounded-btn px-3 py-2 text-table-cell focus:outline-none focus:border-primary';
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block mb-3">
      <span className="block text-[12px] font-semibold text-text-secondary mb-1">{label}</span>
      {children}
    </label>
  );
}
