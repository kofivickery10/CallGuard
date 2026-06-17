import { useState, FormEvent } from 'react';
import { api } from '../api/client';
import { PLANS, PLAN_LABELS } from '@callguard/shared';

interface Props {
  onClose: () => void;
  onCreated: (result: { org_id: string; admin_user_id: string; temp_password: string }) => void;
}

export default function CreateTenantModal({ onClose, onCreated }: Props) {
  const [form, setForm] = useState({ org_name: '', admin_name: '', admin_email: '', plan: 'core' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ org_id: string; admin_user_id: string; temp_password: string } | null>(null);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const r = await api.post<{ org_id: string; admin_user_id: string; temp_password: string }>(
        '/superadmin/tenants',
        form
      );
      setResult(r);
      onCreated(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create tenant');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-card rounded-card w-full max-w-md p-6 shadow-xl">
        <h2 className="text-lg font-bold text-text-primary mb-4">Create tenant</h2>

        {result ? (
          <div className="space-y-3">
            <p className="text-sm text-pass font-medium">Tenant created successfully.</p>
            <div className="bg-page rounded p-3 text-sm space-y-1">
              <p><span className="font-medium">Org ID:</span> {result.org_id}</p>
              <p><span className="font-medium">Admin user ID:</span> {result.admin_user_id}</p>
              <p><span className="font-medium">Temporary password:</span>
                <code className="ml-1 bg-border-light px-1 rounded">{result.temp_password}</code>
              </p>
            </div>
            <p className="text-xs text-text-muted">Share these credentials securely. The admin should change their password on first login.</p>
            <button onClick={onClose} className="w-full mt-2 bg-primary text-white py-2 rounded-btn text-sm font-semibold hover:bg-primary-hover">
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            {[
              { key: 'org_name',    label: 'Organisation name', type: 'text' },
              { key: 'admin_name',  label: 'Admin full name',   type: 'text' },
              { key: 'admin_email', label: 'Admin email',       type: 'email' },
            ].map(({ key, label, type }) => (
              <div key={key}>
                <label className="block text-sm font-medium text-text-secondary mb-1">{label}</label>
                <input
                  type={type}
                  value={form[key as keyof typeof form]}
                  onChange={set(key)}
                  required
                  className="w-full border border-border rounded-btn px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
              </div>
            ))}
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Plan</label>
              <select
                value={form.plan}
                onChange={set('plan')}
                className="w-full border border-border rounded-btn px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                {PLANS.map((p) => (
                  <option key={p} value={p}>{PLAN_LABELS[p]}</option>
                ))}
              </select>
            </div>
            {error && <p className="text-fail text-sm">{error}</p>}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onClose} className="flex-1 border border-border text-text-secondary py-2 rounded-btn text-sm hover:bg-sidebar-hover">
                Cancel
              </button>
              <button type="submit" disabled={loading} className="flex-1 bg-primary text-white py-2 rounded-btn text-sm font-semibold hover:bg-primary-hover disabled:opacity-60">
                {loading ? 'Creating…' : 'Create tenant'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
