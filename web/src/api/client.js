/**
 * API client.
 *
 * In development the Vite dev server proxies /api to the backend, so requests
 * are same-origin and CORS never comes up. In a container build the base URL
 * is baked in at build time.
 */
const BASE = import.meta.env.VITE_API_BASE_URL ?? '';

const TOKEN_KEY = 'fnb.token';

export const tokenStore = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      // Private browsing or blocked storage - the app still works, the session
      // just does not survive a reload.
      return null;
    }
  },
  set: (token) => {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch { /* ignore */ }
  },
  clear: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch { /* ignore */ }
  },
};

/**
 * An error carrying the API's structured body, so a component can branch on
 * `code` (INSUFFICIENT_STOCK vs VALIDATION_ERROR) rather than parse a string.
 */
export class ApiError extends Error {
  constructor(message, { status, code, details, requestId } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body, params } = {}) {
  const url = new URL(`${BASE}/api${path}`, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
  }

  const token = tokenStore.get();
  const response = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = payload?.error ?? {};
    // An expired or invalid token should drop the session rather than leave
    // the user clicking a UI that silently fails.
    if (response.status === 401) onUnauthorized();
    throw new ApiError(error.message ?? `Request failed (${response.status})`, {
      status: response.status,
      code: error.code,
      details: error.details,
      requestId: error.requestId,
    });
  }

  return payload;
}

/** Formats a decimal string for display without ever parsing it as a float. */
export const money = (value) =>
  new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(Number(value ?? 0));

/** Quantities come back as numeric strings like "12.000". */
export const qty = (value) => {
  const n = Number(value ?? 0);
  return Number.isInteger(n) ? String(n) : String(n);
};
