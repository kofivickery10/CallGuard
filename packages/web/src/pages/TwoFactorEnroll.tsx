import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Logo } from '../components/Logo';
import type { TwoFactorSetupResponse } from '@callguard/shared';

// Mandatory 2FA enrolment. Shown to any signed-in user who has not yet set up an
// authenticator app. Walks through: scan QR -> confirm a code -> save backup codes.
export function TwoFactorEnroll() {
  const { user, setupTwoFactor, verifyTwoFactorSetup, logout } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<'qr' | 'backup'>('qr');
  const [setup, setSetup] = useState<TwoFactorSetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Already enrolled (and not mid-flow showing backup codes) -> nothing to do here.
  useEffect(() => {
    if (user?.totp_enabled && step !== 'backup') navigate('/', { replace: true });
  }, [user?.totp_enabled, step, navigate]);

  // Fetch the QR / secret once on mount. The ref guard stops React StrictMode's
  // double-mount from firing /setup twice, which would otherwise race two secrets
  // against the same row and could leave the stored secret out of sync with the QR.
  // NB: we deliberately do NOT use a `cancelled` cleanup flag here — under
  // StrictMode the mount's cleanup would set it before the single guarded fetch
  // resolves, discarding the result and leaving the QR stuck on "Loading…".
  const setupStarted = useRef(false);
  useEffect(() => {
    if (setupStarted.current) return;
    setupStarted.current = true;
    setupTwoFactor()
      .then(setSetup)
      .catch((err) => setError((err as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const codes = await verifyTwoFactorSetup(code.trim());
      setBackupCodes(codes);
      setStep('backup');
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
          <Logo variant="stacked" alt="CallGuard AI" className="w-[200px] h-auto mx-auto mb-3" />
          <p className="text-page-sub text-text-subtle mt-1">Set up two-factor authentication</p>
        </div>

        <div className="bg-card border border-border rounded-card p-8 space-y-5">
          {error && (
            <div className="bg-fail-bg text-fail px-4 py-2.5 rounded-btn text-table-cell">{error}</div>
          )}

          {step === 'qr' && (
            <>
              <p className="text-table-cell text-text-secondary">
                Two-factor authentication is required. Scan this QR code with an authenticator app
                (Google Authenticator, Authy, 1Password), then enter the 6-digit code to confirm.
              </p>

              {setup ? (
                <div className="flex flex-col items-center gap-3">
                  <img
                    src={setup.qr_data_url}
                    alt="Authenticator QR code"
                    className="w-44 h-44 border border-border rounded-card bg-white p-2"
                  />
                  <details className="w-full text-center">
                    <summary className="text-xs text-text-muted cursor-pointer">
                      Can't scan? Enter this key manually
                    </summary>
                    <code className="block mt-2 text-table-cell break-all bg-page rounded-btn px-3 py-2 text-text-primary">
                      {setup.secret}
                    </code>
                  </details>
                </div>
              ) : (
                <div className="text-center text-text-muted text-table-cell py-8">Loading…</div>
              )}

              <form onSubmit={handleVerify} className="space-y-4">
                <div>
                  <label className="block text-table-cell font-medium text-text-secondary mb-1.5">
                    6-digit code
                  </label>
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary tracking-[6px] text-center focus:outline-none focus:border-primary"
                    placeholder="000000"
                    required
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading || !setup}
                  className="w-full bg-primary text-white py-[9px] px-[18px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-50 transition-colors"
                >
                  {loading ? 'Verifying…' : 'Confirm & enable'}
                </button>
              </form>
            </>
          )}

          {step === 'backup' && (
            <>
              <h2 className="text-lg font-semibold text-text-primary">Save your backup codes</h2>
              <p className="text-table-cell text-text-secondary">
                Store these somewhere safe. Each code can be used once to sign in if you lose access
                to your authenticator. They won't be shown again.
              </p>
              <div className="grid grid-cols-2 gap-2 bg-page rounded-card p-4">
                {backupCodes.map((c) => (
                  <code key={c} className="text-table-cell text-text-primary text-center py-1">
                    {c}
                  </code>
                ))}
              </div>
              <button
                onClick={() => navigate('/', { replace: true })}
                className="w-full bg-primary text-white py-[9px] px-[18px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover transition-colors"
              >
                I've saved my codes — continue
              </button>
            </>
          )}

          <button
            onClick={logout}
            className="w-full text-center text-xs text-text-muted hover:text-text-secondary"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
