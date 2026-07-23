const BASE_URL = '/api';

const TOKEN_KEY = 'callguard_token';
const REFRESH_KEY = 'callguard_refresh_token';

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function setTokens(token: string, refreshToken: string) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(REFRESH_KEY, refreshToken);
}

// Kept for backwards compatibility with AuthContext.
export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

// In-flight refresh promise — prevents multiple concurrent refreshes.
let refreshPromise: Promise<string> | null = null;

async function attemptTokenRefresh(): Promise<string> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const rt = getRefreshToken();
    if (!rt) throw new Error('No refresh token');

    const res = await fetch(`${BASE_URL}/auth/refresh`, {
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

async function request<T>(
  path: string,
  options: RequestInit = {},
  isRetry = false
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Don't set Content-Type for FormData (browser sets it with boundary)
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  // On 401, attempt a token refresh and retry once. If the refresh itself
  // fails (refresh token also expired/revoked), or the retried request is
  // still rejected, the session is unrecoverable — clear it and send the user
  // to login. Without this, every page just sits on whatever loading/error
  // state it happened to be in (most have none) until a manual reload.
  if (res.status === 401 && path !== '/auth/refresh' && path !== '/auth/login') {
    if (!isRetry) {
      try {
        await attemptTokenRefresh();
        return request<T>(path, options, true);
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
    const body = await res.json().catch(() => ({ message: res.statusText }));
    // 2FA is mandatory: a gated session hitting a protected route is bounced into
    // enrolment. Covers active sessions that predate the user enrolling.
    if (res.status === 403 && body.code === 'MFA_ENROLMENT_REQUIRED') {
      if (window.location.pathname !== '/enroll-2fa') {
        window.location.assign('/enroll-2fa');
      }
    }
    throw new Error(body.message || `Request failed: ${res.status}`);
  }

  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body instanceof FormData ? body : JSON.stringify(body),
    }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  delete: <T>(path: string) =>
    request<T>(path, { method: 'DELETE' }),
  // Authenticated file download (CSV exports etc.) — fetches as a blob and
  // triggers a browser save, honouring the server's filename when present.
  download: async (path: string, fallbackName: string) => {
    const token = getToken();
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error((body as { message?: string }).message || `Download failed: ${res.status}`);
    }
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = match?.[1] ?? fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
