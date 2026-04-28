import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api, setToken, clearToken } from '../api/client';
import type { AuthResponse } from '@callguard/shared';

import type { Plan } from '@callguard/shared';

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  organization_id: string;
  organization_name: string;
  organization_plan: Plan;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string, organizationName: string) => Promise<void>;
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
    setToken(res.token);
    setUser(res.user);
  };

  const register = async (
    email: string,
    password: string,
    name: string,
    organizationName: string
  ) => {
    const res = await api.post<AuthResponse>('/auth/register', {
      email,
      password,
      name,
      organization_name: organizationName,
    });
    setToken(res.token);
    setUser(res.user);
  };

  const logout = () => {
    clearToken();
    setUser(null);
  };

  const refreshUser = async () => {
    const res = await api.get<{ user: AuthUser }>('/auth/me');
    setUser(res.user);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
