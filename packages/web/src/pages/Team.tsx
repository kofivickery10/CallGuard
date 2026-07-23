import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { InviteAgentModal } from '../components/InviteAgentModal';
import { ScoreGauge } from '../components/ScoreGauge';
import { useScoreOnly, useAuth } from '../context/AuthContext';
import { useDialog } from '../components/DialogProvider';
import type { AgentSummary } from '@callguard/shared';

const fieldClass =
  'w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors';

export function Team() {
  const scoreOnly = useScoreOnly();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const { confirm, notify } = useDialog();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [enableTarget, setEnableTarget] = useState<AgentSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ data: AgentSummary[] }>('/agents'),
  });

  const revokeLogin = async (agent: AgentSummary) => {
    const ok = await confirm(
      `Revoke ${agent.name}'s ability to sign in? Their calls and history stay, and they still count as a billable seat — they just can't log in.`,
      { danger: true, confirmLabel: 'Revoke login' }
    );
    if (!ok) return;
    setBusyId(agent.id);
    try {
      await api.patch(`/agents/${agent.id}/login`, { can_login: false });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    } catch (err) {
      await notify((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const cols = ['Agent', 'Calls', 'Scored', 'Avg Score', ...(scoreOnly ? [] : ['Pass Rate']), ...(isAdmin ? [''] : [])];

  return (
    <div>
      <div className="flex items-center justify-between mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Team</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            Manage your agents and view performance
          </p>
        </div>
        <button
          onClick={() => setInviteOpen(true)}
          className="bg-primary text-white px-[18px] py-[9px] rounded-btn text-table-cell font-semibold hover:bg-primary-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          Add team member
        </button>
      </div>

      {isLoading ? (
        <div className="text-text-muted text-table-cell">Loading...</div>
      ) : !data?.data.length ? (
        <div className="bg-card border-2 border-dashed border-border rounded-card p-12 text-center">
          <div className="text-text-secondary font-semibold mb-1">No agents yet</div>
          <p className="text-table-cell text-text-muted mb-4">
            Add agents so calls attribute to them — with or without a login
          </p>
          <button
            onClick={() => setInviteOpen(true)}
            className="text-primary font-semibold text-table-cell hover:underline"
          >
            Add your first agent
          </button>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-card overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr>
                {cols.map((h, i) => (
                  <th key={h || `col-${i}`} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">
                    {h || <span className="sr-only">Actions</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.data.map((agent) => (
                <tr key={agent.id} className="hover:bg-table-header transition-colors border-b border-border-light last:border-0">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <span className="text-table-cell font-medium text-text-primary">{agent.name}</span>
                      {agent.login_disabled && (
                        <span className="inline-block px-2 py-[2px] rounded-full text-badge font-semibold bg-table-header text-text-muted border border-border">
                          No login
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-text-muted">{agent.email || 'Attribution & billing only'}</div>
                  </td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">{agent.total_calls}</td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">{agent.scored_calls}</td>
                  <td className="px-5 py-3.5">
                    {agent.average_score != null ? (
                      <ScoreGauge score={agent.average_score} showBar />
                    ) : <span className="text-text-muted">--</span>}
                  </td>
                  {!scoreOnly && (
                    <td className="px-5 py-3.5 text-table-cell text-text-cell">
                      {agent.pass_rate != null ? `${Math.round(agent.pass_rate)}%` : '--'}
                    </td>
                  )}
                  {isAdmin && (
                    <td className="px-5 py-3.5 text-right whitespace-nowrap">
                      {agent.id === user?.id ? (
                        <span className="text-xs text-text-muted">You</span>
                      ) : agent.login_disabled ? (
                        <button
                          onClick={() => setEnableTarget(agent)}
                          disabled={busyId === agent.id}
                          className="text-table-cell text-primary font-semibold hover:underline disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                        >
                          Enable login
                        </button>
                      ) : (
                        <button
                          onClick={() => revokeLogin(agent)}
                          disabled={busyId === agent.id}
                          className="text-table-cell text-fail font-semibold hover:underline disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                        >
                          Revoke login
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <InviteAgentModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
      {enableTarget && (
        <EnableLoginModal
          agent={enableTarget}
          onClose={() => setEnableTarget(null)}
          onDone={() => {
            setEnableTarget(null);
            queryClient.invalidateQueries({ queryKey: ['agents'] });
          }}
        />
      )}
    </div>
  );
}

// Enabling sign-in for a no-login adviser needs a password (and an email if
// they were added without one), so it can't be a one-click action.
function EnableLoginModal({ agent, onClose, onDone }: { agent: AgentSummary; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState(agent.email ?? '');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.patch(`/agents/${agent.id}/login`, { can_login: true, email: email || undefined, password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-card w-full max-w-md p-6 shadow-lg">
        <form onSubmit={submit}>
          <h3 className="text-section-title text-text-primary mb-1">Enable login</h3>
          <p className="text-table-cell text-text-subtle mb-5">
            Give <span className="text-text-primary font-medium">{agent.name}</span> a sign-in. Share these credentials with them.
          </p>

          {error && <div className="bg-fail-bg text-fail px-4 py-2 rounded-btn text-table-cell mb-4">{error}</div>}

          <div className="space-y-4">
            <div>
              <label className="block text-table-cell font-medium text-text-secondary mb-1">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="agent@company.com" className={fieldClass} required disabled={!!agent.email} />
            </div>
            <div>
              <label className="block text-table-cell font-medium text-text-secondary mb-1">Password</label>
              <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Temporary password" className={fieldClass} required minLength={6} />
            </div>
          </div>

          <div className="flex gap-3 mt-5">
            <button type="submit" disabled={saving} className="flex-1 bg-primary text-white py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-50 transition-colors">
              {saving ? 'Enabling…' : 'Enable login'}
            </button>
            <button type="button" onClick={onClose} className="px-4 py-[9px] rounded-btn text-text-cell border border-border hover:bg-sidebar-hover text-table-cell font-semibold transition-colors">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
