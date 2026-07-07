const TOKEN_KEY = 'cg_admin_token';
const REFRESH_KEY = 'cg_admin_refresh_token';

export const setToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const getRefreshToken = () => localStorage.getItem(REFRESH_KEY);
export const setTokens = (token: string, refreshToken: string) => {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(REFRESH_KEY, refreshToken);
};
export const clearToken = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
};

// In-flight refresh promise — prevents multiple concurrent refreshes.
let refreshPromise: Promise<string> | null = null;

async function attemptTokenRefresh(): Promise<string> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const rt = getRefreshToken();
    if (!rt) throw new Error('No refresh token');

    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    });

    if (!res.ok) {
      clearToken();
      throw new Error('Session expired. Please log in again.');
    }

    const data = (await res.json()) as { token: string; refresh_token: string };
    setTokens(data.token, data.refresh_token);
    return data.token;
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

async function request<T>(method: string, path: string, body?: unknown, isRetry = false): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  // On 401, attempt a token refresh and retry once. If the refresh itself
  // fails, or the retried request is still rejected, the session is
  // unrecoverable — clear it and send the user to login. Previously the admin
  // console had no refresh flow at all, so every session died after the
  // access token's 15-minute lifetime and every page just sat broken.
  if (res.status === 401 && path !== '/auth/refresh' && path !== '/auth/login') {
    if (!isRetry) {
      try {
        await attemptTokenRefresh();
        return request<T>(method, path, body, true);
      } catch {
        // fall through to the session-expired handling below
      }
    }
    clearToken();
    if (window.location.pathname !== '/login') {
      window.location.assign('/login');
    }
    throw new Error('Session expired. Please log in again.');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    // 2FA is mandatory: a gated session hitting a protected route is bounced into
    // enrolment. Covers active sessions that predate the user enrolling.
    if (res.status === 403 && err.code === 'MFA_ENROLMENT_REQUIRED') {
      if (window.location.pathname !== '/enroll-2fa') {
        window.location.assign('/enroll-2fa');
      }
    }
    throw new Error(err.message || 'Request failed');
  }
  return res.json() as Promise<T>;
}

export const api = {
  get:    <T>(path: string)                    => request<T>('GET',    path),
  post:   <T>(path: string, body: unknown)     => request<T>('POST',   path, body),
  put:    <T>(path: string, body: unknown)     => request<T>('PUT',    path, body),
  delete: <T>(path: string)                    => request<T>('DELETE', path),
};
