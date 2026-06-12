import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [form, setForm] = useState({
    email: '',
    password: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
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
          <img src="/callguard-logo-stacked.svg" alt="CallGuard AI" className="h-28 w-auto mx-auto mb-3" />
          <p className="text-page-sub text-text-subtle mt-1">AI compliance scoring for sales conversations</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-white border border-border rounded-card p-8 space-y-5">
          <h2 className="text-[18px] font-semibold text-text-primary">Welcome back</h2>

          {error && (
            <div className="bg-fail-bg text-fail px-4 py-2.5 rounded-btn text-table-cell">
              {error}
            </div>
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
      </div>
    </div>
  );
}
