import { LOCAL_BROWSER_HEADER } from "@bayon/proto";
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

// Whether a request comes from a browser on the Bayon host itself (§14 amendment). The
// API cannot tell from its own socket: the GUI's proxy forwards every browser's request from
// 127.0.0.1. The proxy can, and says so in LOCAL_BROWSER_HEADER after removing any copy the browser
// sent (apps/web/server/local-browser.ts). The header's value is the host-only key
// (`$FRM_HOME/local-browser.key`, local-key.ts), which only a process that can read the operator's
// FRM_HOME knows — so a header forged elsewhere never matches. And the API believes it only on a
// loopback socket that no reverse proxy forwarded: a LAN client calling the API directly
// (FRM_API_HOST=0.0.0.0) arrives from its own address, and the production edge, which strips the
// header, reaches the API over the docker network. The bearer is checked before any of this.

/** The parts of a request this reads: an IncomingMessage has both. */
export interface PeerRequest {
  readonly socket: { readonly remoteAddress?: string | undefined };
  readonly headers: IncomingHttpHeaders;
}

const V4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const MAPPED = "::ffff:";
/** Present when a reverse proxy forwarded the request: its client is not the peer we see. */
const FORWARDED = ["forwarded", "x-forwarded-for", "x-real-ip"] as const;

/** 127.0.0.0/8, ::1, or 127.x mapped into IPv6. */
export function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  if (address === "::1") return true;
  const v4 = address.startsWith(MAPPED)
    ? address.slice(MAPPED.length)
    : address;
  return V4_LOOPBACK.test(v4);
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** `key` null (no FRM_HOME, or the key could not be written): nothing is local. */
export function isLocalRequest(
  request: PeerRequest,
  key: string | null,
): boolean {
  if (key === null || !isLoopback(request.socket.remoteAddress)) return false;
  if (FORWARDED.some((name) => request.headers[name] !== undefined)) {
    return false;
  }
  const sent = request.headers[LOCAL_BROWSER_HEADER];
  return typeof sent === "string" && timingSafeEqual(digest(sent), digest(key));
}
