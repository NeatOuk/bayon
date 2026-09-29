// The production web server: the built app, the operator's login, and a
// proxy of /api and /ws to the API with the bearer added, behind the origin guard. The API and /mcp
// are never published: /mcp answers 404 here. The bearer never reaches the browser.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Clock } from "@bayon/core";
import { z } from "zod";
import {
  clearSessionCookie,
  sessionCookieValues,
  setSessionCookie,
} from "./cookies.js";
import { mayAct } from "./origin-guard.js";
import {
  MAX_PASSWORD_LENGTH,
  verifyPassword,
  type PasswordHash,
} from "./password.js";
import { forwardHttp, forwardUpgrade } from "./proxy.js";
import { LOGIN_LIMITS, LoginLimiter, type LoginLimits } from "./rate-limit.js";
import {
  SESSION_LIMITS,
  SessionStore,
  type SessionLimits,
} from "./sessions.js";
import { serveStatic } from "./static.js";

export interface EdgeConfig {
  /** FRM_WEB_ORIGINS: exactly the origins the GUI is opened at. */
  readonly origins: ReadonlySet<string>;
  /** The API, on the internal network: `http://api:3010`. */
  readonly apiTarget: URL;
  readonly token: string;
  readonly passwordHash: PasswordHash;
  /** dist/app. */
  readonly staticDir: string;
}

export type EdgeLog = (
  level: "info" | "warn" | "error",
  msg: string,
  fields?: Readonly<Record<string, unknown>>,
) => void;

export interface EdgeDeps {
  readonly config: EdgeConfig;
  readonly clock: Clock;
  readonly log: EdgeLog;
  readonly sessionLimits?: SessionLimits;
  readonly loginLimits?: LoginLimits;
  /** How long a login body may take to arrive (default 5 s); tests shorten it. */
  readonly loginBodyTimeoutMs?: number;
}

export interface Edge {
  readonly server: http.Server;
  readonly sessions: SessionStore;
  close(): Promise<void>;
}

/** The login request's body, at most this many bytes. */
const MAX_LOGIN_BODY = 2 * 1024;
const LoginBody = z.object({
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});
const SWEEP_MS = 60_000;
/**
 * A login body arrives within this, or the request gets 408 (security review): a slow sender must
 * never hold the connection, and it never holds a scrypt slot, taken only once the body is in.
 */
const LOGIN_BODY_TIMEOUT_MS = 5_000;
/** Node's own limits, well under its 300 s default: headers, then the whole request. */
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

type ErrorClass = "validation" | "not_found" | "internal";

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

/** An error in the API's own envelope, so the GUI's client reads it the same way. */
function failure(
  res: ServerResponse,
  status: number,
  message: string,
  o: {
    readonly retryable?: boolean;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): void {
  const cls: ErrorClass =
    status >= 500 ? "internal" : status === 404 ? "not_found" : "validation";
  send(
    res,
    status,
    { error: { class: cls, message, retryable: o.retryable ?? false } },
    o.headers,
  );
}

/** Every response's security headers; `connect-src` names the WebSocket origins explicitly. */
export function securityHeaders(
  origins: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  const sockets = [...origins]
    .map((origin) => origin.replace(/^http/, "ws"))
    .join(" ");
  return {
    "content-security-policy": [
      "default-src 'self'",
      `connect-src 'self' ${sockets}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
  };
}

/** The request target as the edge routes it, and the canonical form it forwards. */
interface Target {
  readonly path: string;
  readonly forward: string;
}

/** An encoded slash or backslash, or a literal backslash: no router may read those differently. */
const AMBIGUOUS = /\\|%2f|%5c/i;

/**
 * The WHATWG-normalised path (dot segments resolved, `%2e` included) and `pathname + search`, which
 * is what goes upstream: the access check and the forwarded bytes are the same (security review).
 * Null for a target no router should have to interpret.
 */
function targetOf(raw: string | undefined): Target | null {
  const text = raw ?? "/";
  if (AMBIGUOUS.test(text)) return null;
  try {
    const url = new URL(text, "http://edge");
    return { path: url.pathname, forward: `${url.pathname}${url.search}` };
  } catch {
    return null;
  }
}

type Body =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "too_large" }
  | { readonly kind: "timeout" };

/** The body as text; too large past `max` bytes (the rest drained); a timeout past `timeoutMs`. */
function readBody(
  req: IncomingMessage,
  max: number,
  timeoutMs: number,
): Promise<Body> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    timer.unref();
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= max) chunks.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(timer);
      resolve(
        size > max
          ? { kind: "too_large" }
          : { kind: "ok", text: Buffer.concat(chunks).toString("utf8") },
      );
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export function createEdge(d: EdgeDeps): Edge {
  const { config, clock, log } = d;
  const hosts = new Set(
    [...config.origins].map((origin) => new URL(origin).host),
  );
  const sessions = new SessionStore(
    clock,
    d.sessionLimits ?? SESSION_LIMITS,
    (address, why) => log("info", "session ended", { address, why }),
  );
  const limiter = new LoginLimiter(
    clock,
    d.loginLimits ?? LOGIN_LIMITS,
    (msg, fields) => log("warn", msg, fields),
  );
  const headers = securityHeaders(config.origins);
  const bodyTimeoutMs = d.loginBodyTimeoutMs ?? LOGIN_BODY_TIMEOUT_MS;
  const sweep = setInterval(() => {
    sessions.sweep();
    limiter.sweep();
  }, SWEEP_MS);
  sweep.unref();

  const addressOf = (req: IncomingMessage): string =>
    req.socket.remoteAddress ?? "";
  const sessionOf = (req: IncomingMessage): string | null =>
    sessions.find(sessionCookieValues(req.headers.cookie), addressOf(req));
  const fromThePage = (req: IncomingMessage, requireOrigin: boolean): boolean =>
    mayAct(req.method ?? "GET", req.headers, config.origins, { requireOrigin });

  async function login(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!fromThePage(req, true)) {
      failure(
        res,
        403,
        "refused: this login did not come from the GUI's own page",
      );
      return;
    }
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
      failure(res, 415, "send the password as JSON");
      return;
    }
    const address = addressOf(req);
    // The body first, under its own timeout: no limiter slot is held while a client sends slowly.
    const body = await readBody(req, MAX_LOGIN_BODY, bodyTimeoutMs);
    if (body.kind === "timeout") {
      log("warn", "login body timed out", { address });
      failure(res, 408, "the login body did not arrive in time", {
        headers: { connection: "close" },
      });
      return;
    }
    if (body.kind === "too_large") {
      failure(res, 413, "the login body is too large");
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(body.text);
    } catch {
      failure(res, 400, "the login body is not JSON");
      return;
    }
    const parsed = LoginBody.safeParse(json);
    if (!parsed.success) {
      failure(res, 400, "send { password }");
      return;
    }
    const admitted = limiter.admit(address);
    if (!admitted.ok) {
      log("warn", "login refused", { address, why: admitted.why });
      failure(
        res,
        429,
        `too many login attempts: try again in ${admitted.retryAfterSec} s`,
        {
          retryable: true,
          headers: { "retry-after": String(admitted.retryAfterSec) },
        },
      );
      return;
    }
    try {
      if (!(await verifyPassword(config.passwordHash, parsed.data.password))) {
        limiter.failed(address);
        log("warn", "login failed", { address });
        failure(res, 401, "wrong password");
        return;
      }
      limiter.succeeded(address);
      const prior = sessionOf(req);
      if (prior !== null) sessions.end(prior, "replaced");
      const value = sessions.create(address);
      log("info", "login", { address });
      send(
        res,
        200,
        { authenticated: true },
        { "set-cookie": setSessionCookie(value) },
      );
    } finally {
      admitted.release();
    }
  }

  function logout(req: IncomingMessage, res: ServerResponse): void {
    if (!fromThePage(req, true)) {
      failure(
        res,
        403,
        "refused: this logout did not come from the GUI's own page",
      );
      return;
    }
    const key = sessionOf(req);
    if (key !== null) sessions.end(key, "logout");
    res.writeHead(204, {
      "set-cookie": clearSessionCookie(),
      "cache-control": "no-store",
    });
    res.end();
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    for (const [name, value] of Object.entries(headers))
      res.setHeader(name, value);
    const target = targetOf(req.url);
    if (target === null) {
      failure(res, 400, "bad request target");
      return;
    }
    const path = target.path;
    const method = req.method ?? "GET";
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
    if (!hosts.has(req.headers.host ?? "")) {
      failure(res, 421, "this server answers only at the GUI's own address");
      return;
    }
    if (path === "/mcp" || path.startsWith("/mcp/")) {
      failure(res, 404, "not found");
      return;
    }
    if (path === "/auth/me") {
      if (sessionOf(req) === null) failure(res, 401, "login required");
      else send(res, 200, { authenticated: true });
      return;
    }
    if (path === "/auth/login" || path === "/auth/logout") {
      if (method !== "POST") {
        failure(res, 405, "POST only");
        return;
      }
      if (path === "/auth/logout") {
        logout(req, res);
        return;
      }
      login(req, res).catch((e: unknown) => {
        log("error", "login failed with an error", { error: String(e) });
        if (!res.headersSent)
          failure(res, 500, "login failed", { retryable: true });
      });
      return;
    }
    if (path === "/api" || path.startsWith("/api/")) {
      if (sessionOf(req) === null) {
        failure(res, 401, "login required");
        return;
      }
      if (!fromThePage(req, false)) {
        failure(
          res,
          403,
          "refused: this request did not come from the GUI's own page",
        );
        return;
      }
      forwardHttp(
        req,
        res,
        config.apiTarget,
        target.forward,
        config.token,
        (e) => log("error", "the API is not answering", { error: e.message }),
      );
      return;
    }
    if (path === "/ws" || path === "/ws/pty") {
      failure(res, 426, "a WebSocket upgrade is required");
      return;
    }
    if (method === "GET" || method === "HEAD") {
      serveStatic(config.staticDir, req, res);
      return;
    }
    failure(res, 405, "method not allowed");
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => socket.destroy());
    const refuse = (status: number, text: string): void => {
      socket.end(
        `HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
      );
    };
    if (!hosts.has(req.headers.host ?? ""))
      return refuse(421, "Misdirected Request");
    const target = targetOf(req.url);
    if (target === null) return refuse(400, "Bad Request");
    if (target.path !== "/ws" && target.path !== "/ws/pty")
      return refuse(404, "Not Found");
    const key = sessionOf(req);
    if (key === null) return refuse(401, "Unauthorized");
    if (!fromThePage(req, true)) return refuse(403, "Forbidden");
    forwardUpgrade(
      req,
      socket,
      head,
      config.apiTarget,
      target.forward,
      config.token,
      (pair) => sessions.attach(key, pair),
      (e) =>
        log("error", "the API's /ws is not answering", { error: e.message }),
    );
  }

  const server = http.createServer(onRequest);
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.on("upgrade", onUpgrade);
  return {
    server,
    sessions,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweep);
        sessions.endAll("shutdown");
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
