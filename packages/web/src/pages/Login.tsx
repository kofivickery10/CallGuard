import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Logo } from '../components/Logo';
import type { TwoFactorChallengeResponse } from '@callguard/shared';

export function Login() {
  const { login, verifyTwoFactor, requestEmailCode } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [form, setForm] = useState({ email: '', password: '' });

  // Set once the password is accepted but a second factor is still required.
  const [challenge, setChallenge] = useState<TwoFactorChallengeResponse | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await login(form.email, form.password);
      if (result.status === '2fa_required') {
        setChallenge(result.challenge);
      } else if (result.status === 'enrol_required') {
        navigate('/enroll-2fa');
      } else {
        navigate('/');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-page">
      <div className="w-full max-w-md px-4">
        <div className="text-center mb-8">
          <Logo variant="stacked" alt="CallGuard AI — Smarter calls. Safer business." className="w-[240px] h-auto mx-auto mb-3" />
          <p className="text-page-sub text-text-subtle mt-1">AI compliance scoring for sales conversations</p>
        </div>

        {challenge ? (
          <TwoFactorChallenge
            challenge={challenge}
            onVerify={verifyTwoFactor}
            onRequestEmailCode={requestEmailCode}
            onSuccess={() => navigate('/')}
            onCancel={() => setChallenge(null)}
          />
        ) : (
          <form onSubmit={handleSubmit} className="bg-card border border-border rounded-card p-8 space-y-5">
            <h2 className="text-[18px] font-semibold text-text-primary">Welcome back</h2>

            {error && (
              <div className="bg-fail-bg text-fail px-4 py-2.5 rounded-btn text-table-cell">{error}</div>
            )}

            <div>
              <label className="block text-table-cell font-medium text-text-secondary mb-1.5">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors"
                placeholder="you@company.com"
                required
              />
            </div>

            <div>
              <label className="block text-table-cell font-medium text-text-secondary mb-1.5">Password</label>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors"
                placeholder="Your password"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-primary text-white py-[9px] px-[18px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-50 transition-colors"
            >
              {loading ? 'Loading...' : 'Sign In'}
            </button>

            <p className="text-center text-[12px] text-text-muted">
              Need an account? Contact your CallGuard administrator.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

// ── Second-factor challenge ─────────────────────────────────────────────────────

function TwoFactorChallenge({
  challenge,
  onVerify,
  onRequestEmailCode,
  onSuccess,
  onCancel,
}: {
  challenge: TwoFactorChallengeResponse;
  onVerify: (token: string, method: 'totp' | 'email' | 'backup', code: string) => Promise<void>;
  onRequestEmailCode: (token: string) => Promise<void>;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [method, setMethod] = useState<'totp' | 'email' | 'backup'>('totp');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  const labels: Record<'totp' | 'email' | 'backup', string> = {
    totp: 'Authenticator code',
    email: 'Emailed code',
    backup: 'Backup code',
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onVerify(challenge.challenge_token, method, code.trim());
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const sendEmail = async () => {
    setError('');
    try {
      await onRequestEmailCode(challenge.challenge_token);
      setEmailSent(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form onSubmit={submit} className="bg-card border border-border rounded-card p-8 space-y-5">
      <h2 className="text-[18px] font-semibold text-text-primary">Two-factor verification</h2>

      {error && (
        <div className="bg-fail-bg text-fail px-4 py-2.5 rounded-btn text-table-cell">{error}</div>
      )}

      <p className="text-table-cell text-text-secondary">
        {method === 'totp' && 'Enter the 6-digit code from your authenticator app.'}
        {method === 'email' && (emailSent
          ? `We've emailed a code to ${challenge.email_hint}.`
          : `Send a one-time code to ${challenge.email_hint}.`)}
        {method === 'backup' && 'Enter one of your single-use backup codes.'}
      </p>

      {method === 'email' && !emailSent ? (
        <button
          type="button"
          onClick={sendEmail}
          className="w-full bg-primary text-white py-[9px] px-[18px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover transition-colors"
        >
          Email me a code
        </button>
      ) : (
        <>
          <div>
            <label className="block text-table-cell font-medium text-text-secondary mb-1.5">
              {labels[method]}
            </label>
            <input
              inputMode={method === 'backup' ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary text-center tracking-[4px] focus:outline-none focus:border-primary"
              placeholder={method === 'backup' ? 'xxxxx-xxxxx' : '000000'}
              required
              autoFocus
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary text-white py-[9px] px-[18px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-50 transition-colors"
          >
            {loading ? 'Verifying…' : 'Verify'}
          </button>
        </>
      )}

      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-[12px] text-text-muted">
        {challenge.methods.includes('totp') && method !== 'totp' && (
          <button type="button" onClick={() => { setMethod('totp'); setCode(''); }} className="hover:text-text-secondary">
            Use authenticator
          </button>
        )}
        {challenge.methods.includes('email') && method !== 'email' && (
          <button type="button" onClick={() => { setMethod('email'); setCode(''); setEmailSent(false); }} className="hover:text-text-secondary">
            Use email code
          </button>
        )}
        {challenge.methods.includes('backup') && method !== 'backup' && (
          <button type="button" onClick={() => { setMethod('backup'); setCode(''); }} className="hover:text-text-secondary">
            Use a backup code
          </button>
        )}
        <button type="button" onClick={onCancel} className="hover:text-text-secondary">
          Back to sign in
        </button>
      </div>
    </form>
  );
}
