import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PLANS, PLAN_LABELS, type Plan } from '@callguard/shared';
import { api } from '../api/client';

interface Tenant {
  id: string;
  name: string;
  plan: string;
  created_at: string;
  user_count: number;
  active_seats: number;
  calls_scored: number;
}

export function Tenants() {
  const [showCreate, setShowCreate] = useState(false);
  const { data } = useQuery({
    queryKey: ['admin-tenants'],
    queryFn: () => api.get<{ data: Tenant[] }>('/admin/tenants'),
  });
  const tenants = data?.data ?? [];

  return (
    <div className="max-w-[1000px]">
      <div className="flex items-start justify-between mb-5">
        <div>
          <h2 className="text-page-title text-text-primary">Tenants</h2>
          <p className="text-page-sub text-text-subtle mt-1">Provision and manage customer organisations.</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="bg-primary text-white px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-primary-hover transition-colors"
        >
          + New tenant
        </button>
      </div>

      <div className="bg-white border border-border rounded-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-table-header border-b border-border">
              {['Tenant', 'Plan', 'Users', 'Active seats', 'Calls scored', 'Created'].map((h) => (
                <th key={h} className="text-left text-table-header uppercase text-text-muted px-4 py-2.5">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <tr key={t.id} className="border-b border-border-light hover:bg-sidebar-hover transition-colors">
                <td className="px-4 py-3">
                  <Link to={`/admin/tenants/${t.id}`} className="text-table-cell font-semibold text-text-primary hover:text-primary">
                    {t.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-table-cell text-text-secondary capitalize">{t.plan}</td>
                <td className="px-4 py-3 text-table-cell text-text-secondary">{t.user_count}</td>
                <td className="px-4 py-3 text-table-cell text-text-secondary">{t.active_seats}</td>
                <td className="px-4 py-3 text-table-cell text-text-secondary">{t.calls_scored}</td>
                <td className="px-4 py-3 text-table-cell text-text-muted">
                  {new Date(t.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                </td>
              </tr>
            ))}
            {tenants.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-table-cell text-text-muted">No tenants yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showCreate && <CreateTenantModal onClose={() => setShowCreate(false)} />}
    </div>
  );
}

function CreateTenantModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [plan, setPlan] = useState<Plan>('growth');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [done, setDone] = useState<{ email_sent: boolean; email_error?: string } | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ email_sent: boolean; email_error?: string }>('/admin/tenants', {
        name,
        plan,
        admin_name: adminName,
        admin_email: adminEmail,
      }),
    onSuccess: (res) => {
      setDone(res);
      queryClient.invalidateQueries({ queryKey: ['admin-tenants'] });
    },
  });

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        {done ? (
          <div>
            <h3 className="text-[16px] font-bold text-text-primary mb-2">Tenant created</h3>
            {done.email_sent ? (
              <p className="text-table-cell text-text-secondary">
                An invitation email was sent to <strong>{adminEmail}</strong> to set their password.
              </p>
            ) : (
              <p className="text-table-cell text-fail">
                Tenant created, but the invite email failed{done.email_error ? `: ${done.email_error}` : ''}. You can resend it from the tenant page.
              </p>
            )}
            <button onClick={onClose} className="mt-4 w-full bg-primary text-white px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-primary-hover">
              Done
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name && adminName && adminEmail) create.mutate();
            }}
          >
            <h3 className="text-[16px] font-bold text-text-primary mb-4">New tenant</h3>
            <Field label="Organisation name">
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Trust Point Ltd" required />
            </Field>
            <Field label="Plan">
              <select className={inputCls} value={plan} onChange={(e) => setPlan(e.target.value as Plan)}>
                {PLANS.map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
              </select>
            </Field>
            <Field label="First admin — name">
              <input className={inputCls} value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Tom Entwistle" required />
            </Field>
            <Field label="First admin — email">
              <input type="email" className={inputCls} value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="tom@trustpoint.co.uk" required />
            </Field>
            <p className="text-[11px] text-text-muted mb-3">They'll get an email to set their own password.</p>
            {create.isError && <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mb-3">{(create.error as Error).message}</div>}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="flex-1 border border-border text-text-secondary px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-sidebar-hover">Cancel</button>
              <button type="submit" disabled={create.isPending} className="flex-1 bg-primary text-white px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-primary-hover disabled:opacity-50">
                {create.isPending ? 'Creating…' : 'Create & invite'}
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
