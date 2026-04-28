import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

interface InviteAgentModalProps {
  open: boolean;
  onClose: () => void;
}

export function InviteAgentModal({ open, onClose }: InviteAgentModalProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.post('/agents', form);
      setCreated({ email: form.email, password: form.password });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      setForm({ name: '', email: '', password: '' });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setCreated(null);
    setError('');
    setForm({ name: '', email: '', password: '' });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-text-primary/30" onClick={handleClose} />
      <div className="relative bg-white border border-border rounded-card w-full max-w-md p-6 shadow-lg">
        {created ? (
          <div>
            <h3 className="text-[15px] font-semibold text-text-primary mb-2">Agent Created</h3>
            <p className="text-table-cell text-text-subtle mb-4">Share these credentials with the agent:</p>
            <div className="bg-table-header rounded-btn p-4 space-y-1 text-table-cell">
              <div><span className="text-text-muted">Email: </span><span className="text-text-primary font-medium">{created.email}</span></div>
              <div><span className="text-text-muted">Password: </span><span className="text-text-primary font-medium">{created.password}</span></div>
            </div>
            <button onClick={handleClose} className="mt-5 w-full bg-primary text-white py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover transition-colors">
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <h3 className="text-[15px] font-semibold text-text-primary mb-1">Invite Agent</h3>
            <p className="text-table-cell text-text-subtle mb-5">Create an account for a team member</p>

            {error && <div className="bg-fail-bg text-fail px-4 py-2 rounded-btn text-table-cell mb-4">{error}</div>}

            <div className="space-y-4">
              <div>
                <label className="block text-table-cell font-medium text-text-secondary mb-1">Name</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Agent's full name" className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors" required />
              </div>
              <div>
                <label className="block text-table-cell font-medium text-text-secondary mb-1">Email</label>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="agent@company.com" className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors" required />
              </div>
              <div>
                <label className="block text-table-cell font-medium text-text-secondary mb-1">Password</label>
                <input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Temporary password" className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors" required minLength={6} />
              </div>
            </div>

            <div className="flex gap-3 mt-5">
              <button type="submit" disabled={saving} className="flex-1 bg-primary text-white py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-50 transition-colors">
                {saving ? 'Creating...' : 'Create Agent'}
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
