import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Logo } from '../components/Logo';
import type { TwoFactorSetupResponse } from '@callguard/shared';

// Mandatory 2FA enrolment for the superadmin console.
export default function TwoFactorEnroll() {
  const { user, setupTwoFactor, verifyTwoFactorSetup, logout } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<'qr' | 'backup'>('qr');
  const [setup, setSetup] = useState<TwoFactorSetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user?.totp_enabled && step !== 'backup') navigate('/', { replace: true });
  }, [user?.totp_enabled, step, navigate]);

  useEffect(() => {
    let cancelled = false;
    setupTwoFactor()
      .then((res) => { if (!cancelled) setSetup(res); })
      .catch((err) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
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
      <div className="w-full max-w-sm bg-card rounded-card shadow-md p-8">
        <div className="mb-6 text-center">
          <Logo variant="stacked" alt="CallGuard AI" className="w-[200px] h-auto mx-auto mb-3" />
          <p className="text-page-sub text-text-subtle mt-1">Set up two-factor authentication</p>
        </div>

        {error && <p className="text-sm text-fail mb-3">{error}</p>}

        {step === 'qr' && (
          <>
            <p className="text-sm text-text-secondary mb-4">
              Scan this QR code with an authenticator app, then enter the 6-digit code to confirm.
            </p>
            {setup ? (
              <div className="flex flex-col items-center gap-3 mb-4">
                <img src={setup.qr_data_url} alt="Authenticator QR code" className="w-44 h-44 border border-border rounded-card bg-white p-2" />
                <details className="w-full text-center">
                  <summary className="text-xs text-text-muted cursor-pointer">Can't scan? Enter this key manually</summary>
                  <code className="block mt-2 text-table-cell break-all bg-page rounded-btn px-3 py-2 text-text-primary">{setup.secret}</code>
                </details>
              </div>
            ) : (
              <div className="text-center text-text-muted text-sm py-8">Loading…</div>
            )}
            <form onSubmit={handleVerify} className="space-y-3">
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="000000"
                required
                className="w-full border border-border rounded-btn px-3 py-2 text-sm text-center tracking-[6px] focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <button
                type="submit"
                disabled={loading || !setup}
                className="w-full bg-primary hover:bg-primary-hover text-white font-semibold py-2 rounded-btn text-sm disabled:opacity-60 transition-colors"
              >
                {loading ? 'Verifying…' : 'Confirm & enable'}
              </button>
            </form>
          </>
        )}

        {step === 'backup' && (
          <>
            <h2 className="text-section-title text-text-primary mb-2">Save your backup codes</h2>
            <p className="text-sm text-text-secondary mb-3">
              Store these somewhere safe. Each can be used once if you lose your authenticator. They won't be shown again.
            </p>
            <div className="grid grid-cols-2 gap-2 bg-page rounded-card p-4 mb-4">
              {backupCodes.map((c) => (
                <code key={c} className="text-table-cell text-text-primary text-center py-1">{c}</code>
              ))}
            </div>
            <button
              onClick={() => navigate('/', { replace: true })}
              className="w-full bg-primary hover:bg-primary-hover text-white font-semibold py-2 rounded-btn text-sm transition-colors"
            >
              I've saved my codes — continue
            </button>
          </>
        )}

        <button onClick={logout} className="w-full text-center text-xs text-text-muted hover:text-text-secondary mt-4">
          Sign out
        </button>
      </div>
    </div>
  );
}
