import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api, setToken, clearToken, getToken } from '../api/client';
import type {
  AuthResponse,
  TwoFactorChallengeResponse,
  TwoFactorSetupResponse,
} from '@callguard/shared';

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  totp_enabled?: boolean;
}

export type LoginResult =
  | { status: 'authenticated' }
  | { status: 'enrol_required' }
  | { status: '2fa_required'; challenge: TwoFactorChallengeResponse };

interface AuthContextValue {
  user: AdminUser | null;
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
}

const AuthContext = createContext<AuthContextValue | null>(null);

type LoginApiResponse = AuthResponse | TwoFactorChallengeResponse;

// The admin console is superadmin-only. Reject anyone else (after any 2FA), and
// clear their token so a wrong account can't linger.
function assertSuperadmin(user: { role: string }): void {
  if (user.role !== 'superadmin') {
    clearToken();
    throw new Error('Not authorised — superadmin access only');
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (getToken()) {
      api.get<{ user: AdminUser }>('/auth/me')
        .then((res) => {
          if (res.user.role !== 'superadmin') {
            clearToken();
          } else {
            setUser(res.user);
          }
        })
        .catch(() => clearToken())
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email: string, password: string): Promise<LoginResult> => {
    const res = await api.post<LoginApiResponse>('/auth/login', { email, password });

    if ('two_factor_required' in res) {
      // Role is verified after the second factor completes (the challenge omits it).
      return { status: '2fa_required', challenge: res };
    }

    assertSuperadmin(res.user);
    setToken(res.token);
    setUser(res.user);
    return res.mfa_enrolment_required ? { status: 'enrol_required' } : { status: 'authenticated' };
  };

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
    assertSuperadmin(res.user);
    setToken(res.token);
    setUser(res.user);
  };

  const requestEmailCode = async (challengeToken: string) => {
    await api.post('/auth/2fa/login/email-code', { challenge_token: challengeToken });
  };

  const setupTwoFactor = () => api.post<TwoFactorSetupResponse>('/auth/2fa/setup', {});

  const verifyTwoFactorSetup = async (code: string): Promise<string[]> => {
    const res = await api.post<AuthResponse & { backup_codes: string[] }>('/auth/2fa/verify-setup', {
      code,
    });
    assertSuperadmin(res.user);
    setToken(res.token);
    setUser(res.user);
    return res.backup_codes;
  };

  const logout = () => {
    clearToken();
    setUser(null);
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
