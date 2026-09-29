import type { IncomingHttpHeaders } from "node:http";

// Who may use the operator's bearer, shared by the dev/preview proxy (dev-proxy.ts) and the
// production edge server: only requests from the page itself. Another
// site (or another port on the same host) that makes the browser call /api or open /ws is refused.
// WebSockets have no CORS, so without this any page could read the feed.

/** `Sec-Fetch-Site` values a browser sends when the page calls its own origin, or the user typed the URL. */
const OWN_SITE = new Set(["same-origin", "none"]);

/** Methods that change nothing: at the edge, `Sec-Fetch-Site` same-origin is enough for them. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True when `headers` come from a non-browser client or from one of `allowedOrigins`. */
export function mayUseBearer(
  headers: IncomingHttpHeaders,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const site = headers["sec-fetch-site"];
  if (site !== undefined && !(typeof site === "string" && OWN_SITE.has(site)))
    return false;
  return headers.origin === undefined || allowedOrigins.has(headers.origin);
}

/**
 * The production edge's stricter rule: mayUseBearer, plus a
 * positive sign that the page itself sent the request, an allowed `Origin` or `Sec-Fetch-Site`
 * same-origin (or none: the address bar). An unsafe method, a WebSocket upgrade and the login
 * (`requireOrigin`) need the allowed `Origin` itself. A request with neither header is refused: the
 * edge has no non-browser clients, and a browser without fetch metadata must not ride the cookie.
 */
export function mayAct(
  method: string,
  headers: IncomingHttpHeaders,
  allowedOrigins: ReadonlySet<string>,
  o: { readonly requireOrigin: boolean },
): boolean {
  if (!mayUseBearer(headers, allowedOrigins)) return false;
  const origin = headers.origin;
  const originOk = typeof origin === "string" && allowedOrigins.has(origin);
  if (o.requireOrigin || !SAFE_METHODS.has(method.toUpperCase()))
    return originOk;
  const site = headers["sec-fetch-site"];
  return originOk || (typeof site === "string" && OWN_SITE.has(site));
}

/**
 * FRM_WEB_ORIGINS: extra origins allowed to use the bearer, e.g. the LAN address the GUI is opened at
 * (`http://192.0.2.43:5173`). Comma-separated; each must be a bare http(s) origin — no path,
 * query, fragment or credentials — or startup fails loudly rather than allow something unintended.
 */
export function extraOrigins(value: string | undefined): readonly string[] {
  const entries = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return entries.map((entry) => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`FRM_WEB_ORIGINS: ${JSON.stringify(entry)} is not a URL`);
    }
    const bare =
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      !entry.endsWith("/");
    if (!bare) {
      throw new Error(
        `FRM_WEB_ORIGINS: ${JSON.stringify(entry)} is not a bare http(s) origin like http://192.0.2.43:5173`,
      );
    }
    return url.origin;
  });
}
