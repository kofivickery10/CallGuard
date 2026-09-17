import { useState, FormEvent } from 'react';
import { api } from '../api/client';
import { PLANS, PLAN_LABELS } from '@callguard/shared';

interface Props {
  onClose: () => void;
  onCreated: (result: { org_id: string; admin_user_id: string; temp_password: string }) => void;
}

// How the firm is scored — a required choice with nothing preselected (owner
// decision, 17 Sep 2026). A default here would decide, silently, whether a
// firm scores nothing until a sale arrives or scores every call. The API
// refuses a create without it too. "Over length threshold" is a variant of
// scoring calls and can be set afterwards on the tenant page.
const SCOPE_CHOICES: { value: 'sales_only' | 'everything'; label: string; hint: string }[] = [
  {
    value: 'sales_only',
    label: 'Score sales',
    hint: "A customer's calls wait, unscored, until a sale arrives — from their CRM, \"Score sale\" on the customer, or the upload sale flag — and are then scored together as one sale. Nothing is scored until a sale arrives.",
  },
  {
    value: 'everything',
    label: 'Score calls',
    hint: 'Every call is scored on its own as soon as it is transcribed. No sale is needed.',
  },
];

export default function CreateTenantModal({ onClose, onCreated }: Props) {
  const [form, setForm] = useState({ org_name: '', admin_name: '', admin_email: '', plan: 'core' });
  const [scoringScope, setScoringScope] = useState<'' | 'sales_only' | 'everything'>('');
  const [fetchOnSale, setFetchOnSale] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ org_id: string; admin_user_id: string; temp_password: string } | null>(null);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!scoringScope) {
      setError('Choose how this firm is scored: score sales or score calls.');
      return;
    }
    setLoading(true);
    try {
      const r = await api.post<{ org_id: string; admin_user_id: string; temp_password: string }>(
        '/superadmin/tenants',
        {
          ...form,
          scoring_scope: scoringScope,
          // Only meaningful, and only sent as true, when scoring sales.
          fetch_recordings_on_sale: scoringScope === 'sales_only' && fetchOnSale,
        }
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
            <button onClick={onClose} className="w-full mt-2 bg-primary-ink text-on-solid py-2 rounded-btn text-sm font-semibold hover:bg-primary-ink-hover">
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
            <fieldset>
              <legend className="block text-sm font-medium text-text-secondary mb-1">
                How is this firm scored? <span className="text-text-muted font-normal">(required)</span>
              </legend>
              <div className="space-y-2">
                {SCOPE_CHOICES.map((choice) => (
                  <label
                    key={choice.value}
                    className={`flex items-start gap-2 border rounded-btn px-3 py-2 cursor-pointer transition-colors ${
                      scoringScope === choice.value ? 'border-primary bg-primary-light' : 'border-border hover:border-primary/50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="scoring_scope"
                      value={choice.value}
                      checked={scoringScope === choice.value}
                      onChange={() => {
                        setScoringScope(choice.value);
                        if (choice.value !== 'sales_only') setFetchOnSale(false);
                      }}
                      required
                      className="mt-1 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    />
                    <span className="text-sm">
                      <span className="font-semibold text-text-primary">{choice.label}</span>
                      <span className="block text-xs text-text-muted mt-0.5">{choice.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {scoringScope === 'sales_only' && (
              <label className="flex items-start gap-2 text-sm text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={fetchOnSale}
                  onChange={(e) => setFetchOnSale(e.target.checked)}
                  className="mt-1 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                />
                <span>
                  <span className="font-semibold text-text-primary">Download recordings only when a sale arrives</span>
                  <span className="block text-xs text-text-muted mt-0.5">
                    Dialler calls are kept as details only until that customer's sale arrives, then the recording is
                    fetched. A recording the dialler deletes before then is lost for good. Leave off unless the firm
                    has asked for it.
                  </span>
                </span>
              </label>
            )}
            {error && <p className="text-fail text-sm">{error}</p>}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onClose} className="flex-1 border border-border text-text-secondary py-2 rounded-btn text-sm hover:bg-sidebar-hover">
                Cancel
              </button>
              <button type="submit" disabled={loading} className="flex-1 bg-primary-ink text-on-solid py-2 rounded-btn text-sm font-semibold hover:bg-primary-ink-hover disabled:opacity-60">
                {loading ? 'Creating…' : 'Create tenant'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
