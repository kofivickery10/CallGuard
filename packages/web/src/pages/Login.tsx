import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ email: '', password: '' });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(form.email, form.password);
      navigate('/');
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
          <div className="inline-flex items-center justify-center w-12 h-12 bg-primary rounded-full mb-4">
            <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="none">
              <rect x="4.5"  y="14"   width="2.4" height="4"  rx="1.1" fill="white"/>
              <rect x="9"    y="11"   width="2.4" height="7"  rx="1.1" fill="white"/>
              <rect x="13.5" y="8"    width="2.4" height="10" rx="1.1" fill="white"/>
              <circle cx="19" cy="6"  r="1.6" fill="white"/>
            </svg>
          </div>
          <h1 className="text-[22px] font-bold text-text-primary tracking-tight">CallGuard <span className="text-primary">AI</span></h1>
          <p className="text-page-sub text-text-subtle mt-1">AI compliance scoring for sales conversations</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-white border border-border rounded-card p-8 space-y-5">
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
            New organisations are set up by CallGuard. Need access?{' '}
            <a href="mailto:hello@callguardai.co.uk" className="text-primary hover:underline font-medium">Contact us</a>
          </p>
        </form>
      </div>
    </div>
  );
}
