import { useState, useEffect, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, setToken } from '../api/client';

interface Preview { email: string; name: string; organizationName: string }
interface AuthResp { token: string }

export function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) { setLoadErr('No invitation token provided.'); return; }
    api
      .get<Preview>(`/auth/invite/${token}`)
      .then(setPreview)
      .catch((e) => setLoadErr((e as Error).message));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (password !== confirm) return setError('Passwords do not match.');
    setSubmitting(true);
    try {
      const res = await api.post<AuthResp>('/auth/accept-invite', { token, password });
      setToken(res.token);
      window.location.href = '/'; // reload into the app as the new user
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-page p-4">
      <div className="bg-white border border-border rounded-card w-full max-w-sm p-6">
        <div className="flex items-center gap-2 mb-5">
          <div className="w-7 h-7 bg-primary rounded-full flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="white"><rect x="4.5" y="14" width="2.4" height="4" rx="1.1" /><rect x="9" y="11" width="2.4" height="7" rx="1.1" /><rect x="13.5" y="8" width="2.4" height="10" rx="1.1" /><circle cx="19" cy="6" r="1.6" /></svg>
          </div>
          <span className="text-[16px] font-bold text-text-primary">CallGuard <span className="text-primary">AI</span></span>
        </div>

        {loadErr ? (
          <div>
            <h2 className="text-[16px] font-bold text-text-primary mb-1">Invitation problem</h2>
            <p className="text-table-cell text-text-muted">{loadErr}</p>
            <a href="/login" className="inline-block mt-4 text-table-cell text-primary hover:underline">Go to sign in</a>
          </div>
        ) : !preview ? (
          <p className="text-table-cell text-text-muted">Loading invitation…</p>
        ) : (
          <form onSubmit={submit}>
            <h2 className="text-[16px] font-bold text-text-primary mb-1">Set your password</h2>
            <p className="text-table-cell text-text-muted mb-4">
              Joining <strong className="text-text-secondary">{preview.organizationName}</strong> as {preview.email}
            </p>
            {error && <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mb-3">{error}</div>}
            <label className="block mb-3">
              <span className="block text-[12px] font-semibold text-text-secondary mb-1">Password</span>
              <input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
            </label>
            <label className="block mb-4">
              <span className="block text-[12px] font-semibold text-text-secondary mb-1">Confirm password</span>
              <input type="password" className={inputCls} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </label>
            <button type="submit" disabled={submitting} className="w-full bg-primary text-white px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-primary-hover disabled:opacity-50">
              {submitting ? 'Setting up…' : 'Set password & sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

const inputCls = 'w-full border border-border rounded-btn px-3 py-2 text-table-cell focus:outline-none focus:border-primary';
