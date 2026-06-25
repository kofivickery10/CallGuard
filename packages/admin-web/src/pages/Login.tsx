import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Logo } from '../components/Logo';
import type { TwoFactorChallengeResponse } from '@callguard/shared';

export default function Login() {
  const { login, verifyTwoFactor, requestEmailCode } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [challenge, setChallenge] = useState<TwoFactorChallengeResponse | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await login(email, password);
      if (result.status === '2fa_required') {
        setChallenge(result.challenge);
      } else if (result.status === 'enrol_required') {
        navigate('/enroll-2fa');
      } else {
        navigate('/');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-page">
      <div className="w-full max-w-sm bg-card rounded-card shadow-md p-8">
        <div className="mb-8 text-center">
          <Logo variant="stacked" alt="CallGuard AI — Smarter calls. Safer business." className="w-[240px] h-auto mx-auto mb-3" />
          <p className="text-page-sub text-text-subtle mt-1">Superadmin console</p>
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
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full border border-border rounded-btn px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full border border-border rounded-btn px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            {error && <p className="text-sm text-fail">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-primary hover:bg-primary-hover text-white font-semibold py-2 rounded-btn text-sm disabled:opacity-60 transition-colors"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onVerify(challenge.challenge_token, method, code.trim());
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
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
      setError(err instanceof Error ? err.message : 'Could not send code');
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-text-secondary">
        {method === 'totp' && 'Enter the 6-digit code from your authenticator app.'}
        {method === 'email' && (emailSent
          ? `We've emailed a code to ${challenge.email_hint}.`
          : `Send a one-time code to ${challenge.email_hint}.`)}
        {method === 'backup' && 'Enter one of your single-use backup codes.'}
      </p>

      {error && <p className="text-sm text-fail">{error}</p>}

      {method === 'email' && !emailSent ? (
        <button
          type="button"
          onClick={sendEmail}
          className="w-full bg-primary hover:bg-primary-hover text-white font-semibold py-2 rounded-btn text-sm transition-colors"
        >
          Email me a code
        </button>
      ) : (
        <>
          <input
            inputMode={method === 'backup' ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={method === 'backup' ? 'xxxxx-xxxxx' : '000000'}
            required
            autoFocus
            className="w-full border border-border rounded-btn px-3 py-2 text-sm text-center tracking-[4px] focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary hover:bg-primary-hover text-white font-semibold py-2 rounded-btn text-sm disabled:opacity-60 transition-colors"
          >
            {loading ? 'Verifying…' : 'Verify'}
          </button>
        </>
      )}

      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-text-muted">
        {challenge.methods.includes('totp') && method !== 'totp' && (
          <button type="button" onClick={() => { setMethod('totp'); setCode(''); }} className="hover:text-text-secondary">Use authenticator</button>
        )}
        {challenge.methods.includes('email') && method !== 'email' && (
          <button type="button" onClick={() => { setMethod('email'); setCode(''); setEmailSent(false); }} className="hover:text-text-secondary">Use email code</button>
        )}
        {challenge.methods.includes('backup') && method !== 'backup' && (
          <button type="button" onClick={() => { setMethod('backup'); setCode(''); }} className="hover:text-text-secondary">Use a backup code</button>
        )}
        <button type="button" onClick={onCancel} className="hover:text-text-secondary">Back to sign in</button>
      </div>
    </form>
  );
}
