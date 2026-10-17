/**
 * Central API client for talking to the boardwright backend.
 *
 * Every frontend call to the API should go through `apiFetch` rather than
 * calling `fetch` directly — this is the one place that:
 *   1. Prefixes the API base URL (so components never hardcode it)
 *   2. Sends the httpOnly auth cookies (`credentials: "include"`) and
 *      transparently retries once after an automatic token refresh if a
 *      request comes back 401
 *   3. Throws a consistent Error (with the backend's message) on any
 *      non-2xx response, so calling code can just `try/catch` instead of
 *      checking `res.ok` everywhere
 *
 * If the API's error shape or auth scheme ever changes, this is the only
 * file that needs to change.
 */

const API_BASE_URL = "/api-proxy";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  body?: unknown; // pass a plain object — apiFetch handles JSON.stringify
  /** Legacy compatibility field; authentication is carried by httpOnly cookies. */
  accessToken?: string | null;
}

// Coalesces concurrent refresh attempts into one in-flight request — if
// three API calls all 401 around the same moment (e.g. right as the
// access token expires), they should trigger exactly one /auth/refresh
// call between them, not three.
let refreshInFlight: Promise<boolean> | null = null;

function refreshAccessToken(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_BASE_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {},
  // Internal only — not part of the public options type. Set to true on
  // the single retry attempt after a refresh, so that retry's own 401 (if
  // the refresh didn't actually fix things) falls through to the normal
  // error path below instead of looping forever.
  isRetryAfterRefresh = false
): Promise<T> {
  const { body, accessToken: _unused, headers, ...rest } = options;

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    // Sends the httpOnly accessToken/refreshToken cookies automatically —
    // required on every request for the API to know who's calling, now
    // that there's no token for the frontend to read and attach itself.
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  // A 401 usually just means the access token expired (they're
  // deliberately short-lived, 15 minutes) — attempt exactly one silent
  // refresh-and-retry before giving up. Auth endpoints are skipped except
  // /auth/me and /auth/socket-ticket, both of which need a valid session.
  // A failed login attempt should not trigger a pointless refresh call, and
  // the retry itself is skipped to guarantee this can only recurse once.
  const canRefresh =
    !path.startsWith("/auth/") || path === "/auth/me" || path === "/auth/socket-ticket";
  if (res.status === 401 && !isRetryAfterRefresh && canRefresh) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return apiFetch<T>(path, options, true);
    }
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Backend consistently returns { error: "..." } on failure — surface
    // that message rather than a generic "request failed".
    throw new ApiError(data.error || "Request failed", res.status);
  }

  return data as T;
}
