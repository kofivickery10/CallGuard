import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

interface InviteAgentModalProps {
  open: boolean;
  onClose: () => void;
}

interface CreatedAgentResponse {
  id: string;
  name: string;
  email: string | null;
  invited?: boolean;
  invite_sent?: boolean;
  invite_url?: string;
}

const fieldClass =
  'w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors';

const emptyForm = { name: '', email: '', external_agent_id: '', role: 'adviser', can_login: true };

interface CreatedState {
  can_login: boolean;
  name: string;
  email: string;
  invite_sent: boolean;
  invite_url?: string;
}

export function InviteAgentModal({ open, onClose }: InviteAgentModalProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<CreatedState | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      // Login-capable members are invited by email (no password sent) — the
      // backend creates the account and emails a one-time set-password link.
      const payload = form.can_login
        ? { name: form.name, email: form.email, external_agent_id: form.external_agent_id, role: form.role, can_login: true }
        : { name: form.name, email: form.email || undefined, external_agent_id: form.external_agent_id, role: form.role, can_login: false };
      const res = await api.post<CreatedAgentResponse>('/agents', payload);
      setCreated({
        can_login: form.can_login,
        name: form.name,
        email: form.email,
        invite_sent: res.invite_sent ?? false,
        invite_url: res.invite_url,
      });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      setForm(emptyForm);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setCreated(null);
    setError('');
    setForm(emptyForm);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={handleClose} />
      <div className="relative bg-card border border-border rounded-card w-full max-w-md p-6 shadow-lg">
        {created ? (
          <div>
            {created.can_login ? (
              <>
                <h3 className="text-section-title text-text-primary mb-2">Invite sent</h3>
                {created.invite_sent ? (
                  <p className="text-table-cell text-text-subtle">
                    We&rsquo;ve emailed <span className="text-text-primary font-medium">{created.email}</span> a secure
                    link to set their password. It expires in 7 days — you can resend it any time from the team list.
                  </p>
                ) : (
                  <>
                    <p className="text-table-cell text-text-subtle mb-3">
                      The account for <span className="text-text-primary font-medium">{created.email}</span> was created,
                      but the invite email couldn&rsquo;t be sent. Copy this one-time set-password link and share it
                      securely:
                    </p>
                    {created.invite_url && (
                      <div className="bg-table-header rounded-btn p-3 text-xs break-all text-text-primary select-all">
                        {created.invite_url}
                      </div>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <h3 className="text-section-title text-text-primary mb-2">Adviser added</h3>
                <p className="text-table-cell text-text-subtle">
                  <span className="text-text-primary font-medium">{created.name}</span> has been added for call
                  attribution and billing. They can&rsquo;t sign in — you can enable a login later from the team list.
                </p>
              </>
            )}
            <button onClick={handleClose} className="mt-5 w-full bg-primary text-white py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover transition-colors">
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <h3 className="text-section-title text-text-primary mb-1">Add team member</h3>
            <p className="text-table-cell text-text-subtle mb-5">Create an account for a team member, or add an adviser for attribution only.</p>

            {error && <div className="bg-fail-bg text-fail px-4 py-2 rounded-btn text-table-cell mb-4">{error}</div>}

            <div className="space-y-4">
              <div>
                <label className="block text-table-cell font-medium text-text-secondary mb-1">Name</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Agent's full name" className={fieldClass} required />
              </div>

              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.can_login}
                  onChange={(e) => setForm({ ...form, can_login: e.target.checked })}
                  className="accent-primary mt-0.5"
                />
                <span>
                  <span className="block text-table-cell font-medium text-text-secondary">Can sign in to CallGuard</span>
                  <span className="block text-[11px] text-text-muted">
                    Leave off for a front-line adviser you only want calls attributed to. They still count as a billable seat.
                  </span>
                </span>
              </label>

              <div>
                <label className="block text-table-cell font-medium text-text-secondary mb-1">
                  Email {!form.can_login && <span className="text-text-muted font-normal">(optional)</span>}
                </label>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="agent@company.com" className={fieldClass} required={form.can_login} />
                {form.can_login && (
                  <p className="text-[11px] text-text-muted mt-1">We&rsquo;ll email them a secure link to set their own password.</p>
                )}
              </div>

              <div>
                <label className="block text-table-cell font-medium text-text-secondary mb-1">Role</label>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className={`${fieldClass} bg-card`}>
                  <option value="adviser">Adviser — sees only their own calls</option>
                  <option value="supervisor">Supervisor — sees & actions all calls</option>
                  <option value="viewer">Viewer — read-only across the org</option>
                  <option value="admin">Admin — full access incl. settings</option>
                </select>
              </div>

              <div>
                <label className="block text-table-cell font-medium text-text-secondary mb-1">
                  Dialler agent ID <span className="text-text-muted font-normal">(optional)</span>
                </label>
                <input type="text" value={form.external_agent_id} onChange={(e) => setForm({ ...form, external_agent_id: e.target.value })} placeholder="Their ID in your dialler, if it isn't their email" className={fieldClass} />
                <p className="text-[11px] text-text-muted mt-1">Lets calls from your dialler attribute to this adviser automatically.</p>
              </div>
            </div>

            <div className="flex gap-3 mt-5">
              <button type="submit" disabled={saving} className="flex-1 bg-primary text-white py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-50 transition-colors">
                {saving ? 'Adding…' : form.can_login ? 'Send invite' : 'Add adviser'}
              </button>
              <button type="button" onClick={handleClose} className="px-4 py-[9px] rounded-btn text-text-cell border border-border hover:bg-sidebar-hover text-table-cell font-semibold transition-colors">
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
