import type { IncomingMessage } from "node:http";
import type { ProxyOptions } from "vite";
import {
  LOCAL_BROWSER_HEADER,
  isLocalBrowser,
} from "./server/local-browser.js";
import { extraOrigins, mayUseBearer } from "./server/origin-guard.js";

// The dev and preview servers proxy the API so the browser never holds the bearer: the proxy adds it
// to the upstream request. Only for requests from the page itself — another site (or another
// localhost port) that makes the browser call /api or open /ws is forwarded without it, and the API
// answers 401. The guard is shared with the production edge server (server/origin-guard.ts), which
// adds the operator's login; the dev server has none, so anyone who can open an
// allowed origin here has the operator's full control.
//
// It also tells the API whether the browser is on this host (LOCAL_BROWSER_HEADER, §14 amendment,
//): any copy the client sent is removed from every forwarded request first, whatever else
// happens, and the header is set only beside the bearer and only when isLocalBrowser says so.
export { extraOrigins, mayUseBearer };

export interface ApiProxyOptions {
  /** The API origin, e.g. `http://127.0.0.1:3010`. */
  readonly target: string;
  /** FRM_API_TOKEN; without it requests go through bare and the API refuses them. */
  readonly token: string | undefined;
  /** The dev/preview origins allowed to use the bearer. */
  readonly allowedOrigins: ReadonlySet<string>;
  /** The host-only key (`$FRM_HOME/local-browser.key`); null: no browser is local. */
  readonly localKey: () => string | null;
}

interface UpstreamRequest {
  setHeader(name: string, value: string): unknown;
  removeHeader(name: string): unknown;
}

/**
 * `server.proxy` entries: `/api` over HTTP, `/ws` (the JSON feed) and `/ws/pty` (§12.5's binary
 * pty stream, a separate upgrade path — never a topic on `/ws`'s own protocol) as WebSocket
 * upgrades, all to the API.
 */
export function apiProxy(options: ApiProxyOptions): {
  readonly "/api": ProxyOptions;
  readonly "/ws": ProxyOptions;
  readonly "/ws/pty": ProxyOptions;
} {
  const { target, token, allowedOrigins, localKey } = options;
  const addBearer = (upstream: UpstreamRequest, request: IncomingMessage) => {
    upstream.removeHeader(LOCAL_BROWSER_HEADER);
    if (token === undefined || !mayUseBearer(request.headers, allowedOrigins))
      return;
    upstream.setHeader("authorization", `Bearer ${token}`);
    const key = isLocalBrowser(request, allowedOrigins) ? localKey() : null;
    if (key !== null) upstream.setHeader(LOCAL_BROWSER_HEADER, key);
  };
  const configure: ProxyOptions["configure"] = (proxy) => {
    proxy.on("proxyReq", addBearer);
    proxy.on("proxyReqWs", addBearer);
  };
  return {
    "/api": { target, configure },
    "/ws": { target, ws: true, configure },
    "/ws/pty": { target, ws: true, configure },
  };
}
