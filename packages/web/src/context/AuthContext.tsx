import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api, setTokens, clearToken } from '../api/client';
import type {
  AuthResponse,
  TwoFactorChallengeResponse,
  TwoFactorSetupResponse,
} from '@callguard/shared';

import { hasFeature, type Plan } from '@callguard/shared';

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  is_staff?: boolean;
  organization_id: string | null;
  organization_name: string;
  organization_plan: Plan | null;
  // Per-tenant feature grants/denials beyond the plan tier (e.g. score_only).
  feature_overrides?: Record<string, boolean> | null;
  // Whether the user has completed 2FA enrolment. 2FA is mandatory, so a false
  // value forces the enrolment flow before the app is usable.
  totp_enabled?: boolean;
  // True when a superadmin is impersonating this user for support.
  impersonated?: boolean;
}

// Discriminates what the password step produced.
export type LoginResult =
  | { status: 'authenticated' }
  | { status: 'enrol_required' }
  | { status: '2fa_required'; challenge: TwoFactorChallengeResponse };

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  verifyTwoFactor: (
    challengeToken: string,
    method: 'totp' | 'email' | 'backup',
    code: string
  ) => Promise<void>;
  requestEmailCode: (challengeToken: string) => Promise<void>;
  setupTwoFactor: () => Promise<TwoFactorSetupResponse>;
  verifyTwoFactorSetup: (code: string) => Promise<string[]>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

type LoginApiResponse = AuthResponse | TwoFactorChallengeResponse;

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

  const login = async (email: string, password: string): Promise<LoginResult> => {
    const res = await api.post<LoginApiResponse>('/auth/login', { email, password });

    if ('two_factor_required' in res) {
      return { status: '2fa_required', challenge: res };
    }

    setTokens(res.token, res.refresh_token);
    setUser(res.user);
    return res.mfa_enrolment_required ? { status: 'enrol_required' } : { status: 'authenticated' };
  };

  // Complete login's second factor and establish the session.
  const verifyTwoFactor = async (
    challengeToken: string,
    method: 'totp' | 'email' | 'backup',
    code: string
  ) => {
    const res = await api.post<AuthResponse>('/auth/2fa/login/verify', {
      challenge_token: challengeToken,
      method,
      code,
    });
    setTokens(res.token, res.refresh_token);
    setUser(res.user);
  };

  const requestEmailCode = async (challengeToken: string) => {
    await api.post('/auth/2fa/login/email-code', { challenge_token: challengeToken });
  };

  // Begin enrolment (requires the gated session token already stored).
  const setupTwoFactor = () => api.post<TwoFactorSetupResponse>('/auth/2fa/setup', {});

  // Confirm enrolment; the server returns a fresh (ungated) session plus backup codes.
  const verifyTwoFactorSetup = async (code: string): Promise<string[]> => {
    const res = await api.post<AuthResponse & { backup_codes: string[] }>('/auth/2fa/verify-setup', {
      code,
    });
    setTokens(res.token, res.refresh_token);
    setUser(res.user);
    return res.backup_codes;
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
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        verifyTwoFactor,
        requestEmailCode,
        setupTwoFactor,
        verifyTwoFactorSetup,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

// Score-only display mode: the tenant sees the numeric score alone, with the
// overall Pass/Fail/Review verdict (and its red/green styling and pass-rate
// KPIs) suppressed. Per-checkpoint item results are unaffected; the verdict is
// still computed and stored server-side. Tolerates being called outside an
// AuthProvider (e.g. the public share page) — returns false there.
export function useScoreOnly(): boolean {
  const ctx = useContext(AuthContext);
  const user = ctx?.user;
  return hasFeature(user?.organization_plan ?? null, 'score_only', user?.feature_overrides);
}
