// The operator's session cookie: `HttpOnly`, `SameSite=Strict`, `Path=/`, no
// `Max-Age` (it ends with the browser session). Plain http cannot carry `Secure` or `__Host-`.

export const SESSION_COOKIE = "frm_session";

/** A session id as the cookie carries it: 32 random bytes, base64url. */
export const SESSION_VALUE = /^[A-Za-z0-9_-]{43}$/;

/** At most this many `frm_session` values are looked at in one request. */
const MAX_VALUES = 8;

/**
 * Every `frm_session` value the request carries. Another service on this IP can set a cookie of the
 * same name (cookies ignore ports), so there may be several: the caller accepts any valid one.
 */
export function sessionCookieValues(header: string | undefined): string[] {
  if (header === undefined) return [];
  const values: string[] = [];
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    if (SESSION_VALUE.test(value)) values.push(value);
    if (values.length === MAX_VALUES) break;
  }
  return values;
}

export const setSessionCookie = (value: string): string =>
  `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/`;

export const clearSessionCookie = (): string =>
  `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
