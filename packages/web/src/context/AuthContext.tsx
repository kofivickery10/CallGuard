import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api, setTokens, clearToken } from '../api/client';
import type { AuthResponse } from '@callguard/shared';

import type { Plan } from '@callguard/shared';

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  is_staff?: boolean;
  organization_id: string | null;
  organization_name: string;
  organization_plan: Plan | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('callguard_token');
    if (token) {
      api
        .get<{ user: AuthUser }>('/auth/me')
        .then((res) => setUser(res.user))
        .catch(() => clearToken())
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email: string, password: string) => {
    const res = await api.post<AuthResponse>('/auth/login', { email, password });
    setTokens(res.token, res.refresh_token);
    setUser(res.user);
  };

  const logout = () => {
    const rt = localStorage.getItem('callguard_refresh_token');
    if (rt) {
      // Fire-and-forget — we clear locally regardless of server response.
      api.post('/auth/logout', { refresh_token: rt }).catch(() => undefined);
    }
    clearToken();
    setUser(null);
  };

  const refreshUser = async () => {
    const res = await api.get<{ user: AuthUser }>('/auth/me');
    setUser(res.user);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
