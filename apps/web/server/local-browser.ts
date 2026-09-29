import { readFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";

// Is this browser on the Bayon host itself? (§14 amendment, an earlier change.) Only the web proxy can
// tell: the API sees every proxied request arrive from 127.0.0.1. The dev/preview proxy removes any
// LOCAL_BROWSER_HEADER a client sent, then sets it when this says so, to the host-only key the API
// wrote to `$FRM_HOME/local-browser.key` (no key readable: nothing is local); the API believes it
// only with that key, on a loopback socket. The production edge (proxy.ts) never sets it and drops it: a deployed install is
// never local.
//
// Each condition closes one way in:
// - the TCP peer is loopback: a LAN machine cannot forge the address of an established connection;
// - the page's Origin is a loopback origin the proxy allows: the page was opened at localhost, not
//   at a LAN address that a tunnel or port forward might also reach;
// - Sec-Fetch-Site is same-origin: a browser, not a script;
// - no Forwarded / X-Forwarded-For / X-Real-IP: a reverse proxy on the host (tailscale serve, caddy,
//   nginx) connects from loopback too, but adds one of these, and its client cannot take it away.
// What it cannot see: a bare TCP forwarder on the host, or a process on the host forging the browser
// headers. Either already reaches the bearer through this proxy (spike, "does not defend").

/** The name the API reads (proto LOCAL_BROWSER_HEADER; a test holds the two equal). */
export const LOCAL_BROWSER_HEADER = "x-frm-local-browser";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FORWARDED = ["forwarded", "x-forwarded-for", "x-real-ip"] as const;
const V4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const MAPPED = "::ffff:";

export interface PeerRequest {
  readonly socket: { readonly remoteAddress?: string | undefined };
  readonly headers: IncomingHttpHeaders;
}

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  if (address === "::1") return true;
  const v4 = address.startsWith(MAPPED)
    ? address.slice(MAPPED.length)
    : address;
  return V4_LOOPBACK.test(v4);
}

function isLoopbackOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (origin === undefined || !allowedOrigins.has(origin)) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function isLocalBrowser(
  request: PeerRequest,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const { headers } = request;
  return (
    isLoopback(request.socket.remoteAddress) &&
    isLoopbackOrigin(headers.origin, allowedOrigins) &&
    headers["sec-fetch-site"] === "same-origin" &&
    FORWARDED.every((name) => headers[name] === undefined)
  );
}

/** The key file's name under FRM_HOME, as the API writes it (apps/api folders/local-key.ts). */
export const LOCAL_KEY_FILE = "local-browser.key";
const KEY = /^[0-9a-f]{64}$/;

/**
 * Reads the host-only key at `path` when first asked, and again until it is there (the API writes
 * it at boot, maybe after this proxy started); then keeps it. Null while it cannot be read.
 */
export function localKeyReader(path: string): () => string | null {
  let key: string | null = null;
  return () => {
    if (key !== null) return key;
    try {
      const text = readFileSync(path, "utf8").trim();
      key = KEY.test(text) ? text : null;
    } catch {
      key = null;
    }
    return key;
  };
}
