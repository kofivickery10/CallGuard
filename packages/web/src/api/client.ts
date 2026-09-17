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

// In-flight refresh promise — prevents multiple concurrent refreshes in this tab.
let refreshPromise: Promise<string> | null = null;

// The API rotates the refresh token on every use, and both tokens live in
// localStorage, which every tab on the origin shares. Two tabs whose access
// token expired together would each send the same refresh token; the second is
// refused because the first has just rotated it, and clearing the tokens on
// that refusal signed out every tab — including the one that refreshed. So the
// refresh is serialised across tabs with a Web Lock, and a refusal is only
// treated as a dead session when no other tab has since stored a newer token.
const REFRESH_LOCK = 'callguard-refresh';

// Without Web Locks the losing tab's refusal can arrive before the winning tab
// has stored its new tokens, so wait this long for them before giving up.
const ROTATION_GRACE_MS = 1500;

async function attemptTokenRefresh(rejectedToken: string | null): Promise<string> {
  if (refreshPromise) return refreshPromise;

  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  const run = () => refreshTokens(rejectedToken, !locks);

  // lib.dom types request()'s result as a promise of the callback's return
  // value, itself a promise here; the .then() flattens it for the type checker.
  const pending = locks ? locks.request(REFRESH_LOCK, run).then((token) => token) : run();
  const promise = pending.finally(() => {
    refreshPromise = null;
  });
  refreshPromise = promise;

  return promise;
}

async function refreshTokens(rejectedToken: string | null, unlocked: boolean): Promise<string> {
  // Another tab refreshed while this one's request was in flight, or while it
  // waited for the lock: the rejected token has already been replaced.
  const current = getToken();
  if (current && current !== rejectedToken) return current;

  const rt = getRefreshToken();
  if (!rt) throw new Error('No refresh token');

  const res = await fetch(`${BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: rt }),
  });

  if (!res.ok) {
    const rotated = rotatedElsewhere(rt) ?? (unlocked ? await waitForRotation(rt) : null);
    if (rotated) return rotated;
    clearToken();
    throw new Error('Session expired. Please log in again.');
  }

  const data = (await res.json()) as { token: string; refresh_token: string };
  setTokens(data.token, data.refresh_token);
  return data.token;
}

// The access token another tab stored after rotating `sentRefreshToken`, if any.
function rotatedElsewhere(sentRefreshToken: string): string | null {
  const stored = getRefreshToken();
  const token = getToken();
  return stored && stored !== sentRefreshToken && token ? token : null;
}

function waitForRotation(sentRefreshToken: string): Promise<string | null> {
  return new Promise((resolve) => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== REFRESH_KEY) return;
      const token = rotatedElsewhere(sentRefreshToken);
      if (token) finish(token);
    };
    const timer = window.setTimeout(() => finish(rotatedElsewhere(sentRefreshToken)), ROTATION_GRACE_MS);
    function finish(token: string | null) {
      window.clearTimeout(timer);
      window.removeEventListener('storage', onStorage);
      resolve(token);
    }
    window.addEventListener('storage', onStorage);
  });
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
        await attemptTokenRefresh(token);
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

export interface UploadOptions {
  /** Bytes sent so far, as the browser reports them. */
  onProgress?: (loaded: number, total: number | null) => void;
  /** Every byte has left the browser; the server is now working on it. */
  onSent?: () => void;
  /** Abort the upload. Rejects with an AbortError. */
  signal?: AbortSignal;
}

/**
 * POST a FormData body with upload progress, and the ability to cancel it.
 *
 * This is an XMLHttpRequest rather than a fetch on purpose: fetch cannot report
 * how much of a request body has been sent, and a 500MB Teams recording that
 * shows nothing for four minutes is indistinguishable from a broken page. XHR
 * is still the only cross-browser way to get `upload.onprogress`.
 *
 * On a 401 the access token is refreshed and the upload is sent again, once —
 * the body only exists in this tab, so the alternative is losing it. Progress
 * restarts from zero when that happens.
 */
function uploadWithProgress<T>(
  path: string,
  body: FormData,
  options: UploadOptions = {},
  isRetry = false
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('Upload cancelled', 'AbortError'));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE_URL}${path}`);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    // No Content-Type: the browser sets it, with the multipart boundary.

    const onAbort = () => xhr.abort();
    options.signal?.addEventListener('abort', onAbort);
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort);

    if (options.onProgress) {
      xhr.upload.onprogress = (e) =>
        options.onProgress!(e.loaded, e.lengthComputable ? e.total : null);
    }
    if (options.onSent) xhr.upload.onload = () => options.onSent!();

    xhr.onabort = () => {
      cleanup();
      reject(new DOMException('Upload cancelled', 'AbortError'));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error('The upload could not reach CallGuard. Check your connection and try again.'));
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(new Error('The upload timed out before it finished. Try again.'));
    };

    xhr.onload = () => {
      cleanup();
      const parsed = (() => {
        try {
          return JSON.parse(xhr.responseText) as unknown;
        } catch {
          return null;
        }
      })();

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsed as T);
        return;
      }

      if (xhr.status === 401 && !isRetry) {
        attemptTokenRefresh(token)
          .then(() => uploadWithProgress<T>(path, body, options, true))
          .then(resolve)
          .catch(() => {
            clearToken();
            if (window.location.pathname !== '/login') window.location.assign('/login');
            reject(new Error('Session expired. Please log in again.'));
          });
        return;
      }

      const message = (parsed as { message?: string } | null)?.message;
      reject(new Error(message || `Upload failed: ${xhr.status}`));
    };

    xhr.send(body);
  });
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  upload: <T>(path: string, body: FormData, options?: UploadOptions) =>
    uploadWithProgress<T>(path, body, options),
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
  // Authenticated media fetch — the audio endpoint is bearer-token gated, so an
  // <audio src="/api/..."> can't reach it (the browser sends no header). Fetch
  // the whole file and hand back an object URL instead; the endpoint serves no
  // range requests, so this is also what makes seeking work. Callers must
  // URL.revokeObjectURL it when they're done.
  objectUrl: async (path: string): Promise<string> => {
    const token = getToken();
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error((body as { message?: string }).message || `Request failed: ${res.status}`);
    }
    return URL.createObjectURL(await res.blob());
  },
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
