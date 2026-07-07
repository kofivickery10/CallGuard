import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { setToken } from '../api/client';
import { useAuth } from '../context/AuthContext';

// Entry point for a superadmin's impersonation link (admin console → "Impersonate
// admin" → opens /impersonate#token=...). Plants the token and hands off to the
// normal authenticated app. The token is access-only (1 hour, no refresh token —
// see routes/superadmin.ts) so the session simply expires back to /login rather
// than silently breaking.
export function Impersonate() {
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const [error, setError] = useState('');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (!token) {
      navigate('/login', { replace: true });
      return;
    }

    setToken(token);
    refreshUser()
      .then(() => navigate('/', { replace: true }))
      .catch(() => setError('This impersonation link is invalid or has expired.'));
  }, [navigate, refreshUser]);

  return (
    <div className="flex items-center justify-center h-screen text-table-cell text-text-muted">
      {error || 'Starting impersonation session…'}
    </div>
  );
}
