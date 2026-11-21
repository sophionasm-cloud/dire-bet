export type AuthPayload = {
  token?: string;
  refreshToken?: string;
  expiresIn?: number;
  refreshExpiresIn?: number;
  user?: { displayName?: string; webUsername?: string | null; language?: string };
};

const ACCESS_KEY = 'direbet.session';
const REFRESH_KEY = 'direbet.refresh';
const EXPIRES_KEY = 'direbet.sessionExpires';
const SIGNED_OUT_KEY = 'direbet.signedOut';
const AUTH_EVENT = 'direbet:auth';

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function readAccessToken(): string | null {
  return storage()?.getItem(ACCESS_KEY) || null;
}

export function readRefreshToken(): string | null {
  return storage()?.getItem(REFRESH_KEY) || null;
}

export function isSignedOut(): boolean {
  return storage()?.getItem(SIGNED_OUT_KEY) === 'true';
}

function emit(payload: AuthPayload | null): void {
  window.dispatchEvent(new CustomEvent<AuthPayload | null>(AUTH_EVENT, { detail: payload }));
}

export function onAuthChange(listener: (payload: AuthPayload | null) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<AuthPayload | null>).detail);
  window.addEventListener(AUTH_EVENT, handler);
  return () => window.removeEventListener(AUTH_EVENT, handler);
}

export function storeAuth(payload: AuthPayload): void {
  if (!payload.token) return;
  const store = storage();
  if (!store) return;
  store.setItem(ACCESS_KEY, payload.token);
  if (payload.refreshToken) store.setItem(REFRESH_KEY, payload.refreshToken);
  const lifetime = Number(payload.expiresIn);
  if (Number.isFinite(lifetime) && lifetime > 0) store.setItem(EXPIRES_KEY, String(Date.now() + lifetime * 1000));
  store.removeItem(SIGNED_OUT_KEY);
  emit(payload);
}

export function clearAuth(signedOut = false): void {
  const store = storage();
  if (store) {
    store.removeItem(ACCESS_KEY);
    store.removeItem(REFRESH_KEY);
    store.removeItem(EXPIRES_KEY);
    if (signedOut) store.setItem(SIGNED_OUT_KEY, 'true');
    else store.removeItem(SIGNED_OUT_KEY);
  }
  emit(null);
}

let pendingRefresh: Promise<AuthPayload | null> | null = null;

export async function refreshSession(): Promise<AuthPayload | null> {
  const refreshToken = readRefreshToken();
  if (!refreshToken) return null;
  pendingRefresh ??= (async () => {
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) { clearAuth(); return null; }
      const payload = await response.json() as AuthPayload;
      if (!payload.token) { clearAuth(); return null; }
      storeAuth(payload);
      return payload;
    } catch {
      return null;
    } finally {
      pendingRefresh = null;
    }
  })();
  return pendingRefresh;
}

let installed = false;

export function installAuthFetch(): () => void {
  if (installed) return () => undefined;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const first = input instanceof Request ? input.clone() : input;
    const response = await original(first, init);
    if (response.status !== 401) return response;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('/api/') || url.includes('/api/auth/') || !readRefreshToken()) return response;
    const renewed = await refreshSession();
    if (!renewed?.token) return response;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('Authorization', `Bearer ${renewed.token}`);
    const retry = input instanceof Request ? input.clone() : input;
    return original(retry, { ...init, headers });
  };
  return () => {
    window.fetch = original;
    installed = false;
  };
}
