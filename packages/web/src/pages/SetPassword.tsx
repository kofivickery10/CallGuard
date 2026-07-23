import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { Logo } from '../components/Logo';
import type { AuthResponse } from '@callguard/shared';

interface InviteInfo {
  name: string;
  email: string;
  organization_name: string | null;
}

type ConsumeResponse = AuthResponse | { password_set: true; next: 'login' };

const inputClass =
  'w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors';

export function SetPassword() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { applySession } = useAuth();

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [linkError, setLinkError] = useState('');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Validate the link up front so we can greet the user by name and fail fast
  // on an expired/used link rather than after they've typed a password.
  useEffect(() => {
    if (!token) return;
    api
      .get<InviteInfo>(`/auth/invite/${token}`)
      .then(setInfo)
      .catch((err) => setLinkError((err as Error).message))
      .finally(() => setChecking(false));
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<ConsumeResponse>(`/auth/invite/${token}`, { password });
      if ('token' in res) {
        // Signed straight in — route into mandatory 2FA enrolment (fresh users
        // are never enrolled yet) or the app.
        const result = applySession(res);
        navigate(result.status === 'enrol_required' ? '/enroll-2fa' : '/');
      } else {
        // Account already had 2FA (a re-invite) — send them to sign in.
        navigate('/login');
      }
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-page">
      <div className="w-full max-w-md px-4">
        <div className="text-center mb-8">
          <Logo variant="stacked" alt="CallGuard AI" className="w-[240px] h-auto mx-auto mb-3" />
          <p className="text-page-sub text-text-subtle mt-1">AI compliance scoring for sales conversations</p>
        </div>

        <div className="bg-card border border-border rounded-card p-8 space-y-5">
          {checking ? (
            <p className="text-table-cell text-text-muted text-center">Checking your invite…</p>
          ) : linkError ? (
            <>
              <h2 className="text-lg font-semibold text-text-primary">Invite link problem</h2>
              <div className="bg-fail-bg text-fail px-4 py-2.5 rounded-btn text-table-cell">{linkError}</div>
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="w-full bg-primary text-white py-[9px] px-[18px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover transition-colors"
              >
                Go to sign in
              </button>
            </>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-text-primary">Set your password</h2>
                {info && (
                  <p className="text-table-cell text-text-secondary mt-1">
                    Welcome{info.name ? `, ${info.name}` : ''}
                    {info.organization_name ? ` — ${info.organization_name}` : ''}. Choose a password for{' '}
                    <span className="text-text-primary">{info.email}</span>.
                  </p>
                )}
              </div>

              {error && (
                <div className="bg-fail-bg text-fail px-4 py-2.5 rounded-btn text-table-cell">{error}</div>
              )}

              <div>
                <label className="block text-table-cell font-medium text-text-secondary mb-1.5">New password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputClass}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  required
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-table-cell font-medium text-text-secondary mb-1.5">Confirm password</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className={inputClass}
                  placeholder="Re-enter your password"
                  autoComplete="new-password"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={saving}
                className="w-full bg-primary text-white py-[9px] px-[18px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-50 transition-colors"
              >
                {saving ? 'Setting password…' : 'Set password & continue'}
              </button>
              <p className="text-center text-xs text-text-muted">
                You'll then set up two-factor authentication to secure your account.
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
