// The per-session context proxy (spec M12, §8.5 / §14): a loopback HTTP server between a runner and
// its model provider that compresses large tool results in the request body and streams everything
// else, the response above all, through untouched. Runner-neutral: the provider's wire format is
// the adapter's transform (Invariant 1). It runs in the supervisor, one per session process.
//
// - Reached only on 127.0.0.1, with this session's bearer in `x-frm-proxy` (timingSafeEqual). A
//   request without it is 401 and nothing is forwarded.
// - Only routes the transform names are forwarded, to the one upstream fixed at start; anything
//   else, or any target that is not a plain origin-form path, is 404.
// - The one exception to the bearer: a HEAD to a path the transform names as the runner's
//   credential-free warm-up (`probes`) is answered here, empty, and never forwarded.
// - The runner's credential passes through unchanged. Nothing here logs a header, a body, a query or
//   a URL: the log gets fixed event names and error codes. A debug trace (off by default) adds the
//   method and path of each request, never its query.
// - Fails closed at start (no listener, no session) and open per block (context-rewrite.ts).
import { timingSafeEqual } from "node:crypto";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { debuglog } from "node:util";
import {
  CONTEXT_FRAME_TYPE,
  CONTEXT_RULESET,
  err,
  ok,
  type ContextFrame,
  type Result,
} from "@bayon/core";
import {
  UNREADABLE,
  createBodyRewriter,
  type CallCounts,
  type ContextTransform,
  type ProxyRoute,
} from "./context-rewrite.js";
import { storeProblem } from "./context-store.js";
import { frmError } from "./errors.js";

/** The header a runner sends the session's bearer in; never forwarded. */
export const PROXY_HEADER = "x-frm-proxy";
/** The most request body the proxy buffers; a larger one streams on untouched. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** One session's runner holds a few connections at most (its main loop, subagents, counting). */
export const MAX_CONNECTIONS = 32;
/** A request's headers, and the whole request, arrive within these (loopback: generous). */
export const HEADERS_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 60_000;

/** What the proxy logs: a fixed event and, at most, an error code or a fixed reason. */
export type ProxyEvent =
  | "unauthorized"
  | "refused"
  | "untouched"
  | "block_failed"
  | "upstream_error"
  | "internal";
export type ProxyLog = (event: ProxyEvent, detail?: string) => void;

/**
 * Debug only: one line per request, `<answer> <METHOD> <path>`. The answer is the proxy's own
 * (`401`, `404`, `probe`) or `forward`; the path is without its query, cut at TRACE_PATH_CHARS, and a
 * target that is not plain origin-form is `<unsafe target>`, never echoed. Never a header or a body.
 */
export type ProxyTrace = (line: string) => void;
/** The longest path a trace line shows. */
export const TRACE_PATH_CHARS = 200;

const debug = debuglog("frmproxy");
/** The default trace: silent unless the supervisor runs with `NODE_DEBUG=frmproxy`. */
const debugTrace: ProxyTrace = (line) => debug("%s", line);

export interface ModelProxyOptions {
  /** The provider's base URL (http or https): every forwarded path is under it. */
  readonly upstream: string;
  /** The session's bearer: 32 random bytes, hex. */
  readonly token: string;
  readonly transform: ContextTransform;
  /** One frame per `compress` call, before the call goes upstream. */
  readonly onFrame: (frame: ContextFrame) => void;
  /**
   * Where originals go: outside every root the session writes (`writable`), so nothing the session
   * does can redirect the supervisor's writes (context-store.ts).
   */
  readonly storeDir: string;
  /** The roots the session writes: its worktrees and its home. */
  readonly writable: readonly string[];
  readonly log?: ProxyLog;
  /** Where the debug trace goes; by default `NODE_DEBUG=frmproxy`. */
  readonly trace?: ProxyTrace;
  /** Milliseconds, for a frame's `ms`. */
  readonly now?: () => number;
  /** Tests only: the port to listen on (default: any free one) and the body cap. */
  readonly port?: number;
  readonly maxBodyBytes?: number;
}

export interface ModelProxy {
  /** `http://127.0.0.1:<port>`, no path: the runner's base URL while proxied. */
  readonly url: string;
  readonly port: number;
  /** Stops listening and drops every connection. Idempotent. */
  close(): Promise<void>;
}

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1), `expect` (answered here, by Node, never relayed), `host`, and
 * our own bearer: never forwarded either way.
 */
const HOP = new Set([
  "connection",
  "expect",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  PROXY_HEADER,
]);

const TOKEN = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex -- the point is to refuse them
const UNSAFE_TARGET = /[\\\u0000-\u001f\u007f]/;

const invalid = (message: string): Result<never> =>
  err(frmError("validation", `context proxy: ${message}`));

/** The provider's base URL, or why it cannot be one: http(s), no credentials, query or fragment. */
export function upstreamProblem(text: string): string | null {
  const url = URL.parse(text);
  if (url === null) return "the upstream is not a URL";
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return "the upstream must be http or https";
  if (url.username !== "" || url.password !== "")
    return "the upstream must not carry credentials";
  if (url.search !== "" || url.hash !== "" || /[?#]/.test(text))
    return "the upstream must have no query or fragment";
  return null;
}

/** A plain origin-form target (`/a/b?q`), or undefined: `//…`, `..`, encoded slashes, controls. */
export function targetOf(
  raw: string | undefined,
): { readonly path: string; readonly search: string } | undefined {
  if (raw === undefined || !raw.startsWith("/") || raw.startsWith("//")) {
    return undefined;
  }
  if (UNSAFE_TARGET.test(raw)) return undefined;
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  const search = q === -1 ? "" : raw.slice(q);
  // An encoded slash, backslash or dot, once or more (`%2e`, `%252e`).
  if (/%(?:25)*(?:2f|5c|2e)/i.test(path)) return undefined;
  if (path.split("/").some((s) => s === "." || s === "..")) return undefined;
  return { path, search };
}

/** Headers for the other side, either way: hop-by-hop, those `connection` names, the bearer dropped. */
function forwardHeaders(
  h: IncomingHttpHeaders,
): Record<string, string | string[]> {
  const named = new Set(
    String(h.connection ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ""),
  );
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(h)) {
    if (value === undefined || HOP.has(key) || named.has(key)) continue;
    out[key] = value;
  }
  return out;
}

const codeOf = (e: unknown): string =>
  e instanceof Error &&
  "code" in e &&
  typeof e.code === "string" &&
  /^[A-Z0-9_]+$/.test(e.code)
    ? e.code
    : "error";

/** Reads a body up to `cap`; past it, what was read and `complete: false` (the rest unread). */
function readBody(
  req: IncomingMessage,
  cap: number,
): Promise<
  { readonly chunks: Buffer[]; readonly complete: boolean } | undefined
> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (
      r: { readonly chunks: Buffer[]; readonly complete: boolean } | undefined,
    ) => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onGone);
      req.off("close", onGone);
      resolve(r);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > cap) {
        req.pause();
        done({ chunks, complete: false });
      }
    };
    const onEnd = () => done({ chunks, complete: true });
    const onGone = () => done(undefined);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onGone);
    req.on("close", onGone);
  });
}

/**
 * Starts a session's proxy. A listen failure is `spawn_failed` (retryable): the session never
 * starts uncompressed by accident. Bad options are `validation`.
 */
export async function startModelProxy(
  o: ModelProxyOptions,
): Promise<Result<ModelProxy>> {
  if (!TOKEN.test(o.token)) return invalid("the bearer is not 32 bytes of hex");
  const problem = upstreamProblem(o.upstream);
  if (problem !== null) return invalid(problem);
  const misplaced = storeProblem(o.storeDir, o.writable);
  if (misplaced !== null) return invalid(misplaced);
  const base = new URL(o.upstream);
  const basePath = base.pathname.replace(/\/+$/, "");
  const log: ProxyLog = o.log ?? (() => undefined);
  const trace: ProxyTrace = o.trace ?? debugTrace;
  const probes = new Set(o.transform.probes ?? []);
  const now = o.now ?? (() => performance.now());
  const want = Buffer.from(o.token, "utf8");
  const agents = {
    http: new http.Agent({ keepAlive: true }),
    https: new https.Agent({ keepAlive: true }),
  };
  const rewriter = createBodyRewriter({
    transform: o.transform,
    storeDir: o.storeDir,
    onFailure: (reason) => log("block_failed", reason),
  });

  const authorized = (value: string | string[] | undefined): boolean => {
    if (typeof value !== "string") return false;
    const got = Buffer.from(value, "utf8");
    return got.length === want.length && timingSafeEqual(got, want);
  };

  /** Answers here, empty, and closes: a refusal, or a probe's 200. */
  const refuse = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
  ) => {
    req.resume(); // drained unread: nothing of it goes anywhere
    res.writeHead(status, { "content-length": "0", connection: "close" });
    res.end();
  };

  const frame = (counts: CallCounts, started: number): void => {
    try {
      o.onFrame({
        type: CONTEXT_FRAME_TYPE,
        v: 1,
        ruleset: CONTEXT_RULESET,
        ...counts,
        digests: [...counts.digests],
        ms: Math.max(0, Math.round(now() - started)),
      });
    } catch {
      log("internal", "frame");
    }
  };

  /** Sends the request upstream and pipes the answer back, unbuffered. */
  function forward(
    req: IncomingMessage,
    res: ServerResponse,
    target: URL,
    headers: Record<string, string | string[]>,
    body: { readonly bytes: Buffer } | { readonly prefix: Buffer[] },
  ): void {
    const secure = target.protocol === "https:";
    const request = secure ? https.request : http.request;
    const up = request(target, {
      method: req.method ?? "GET",
      headers,
      agent: secure ? agents.https : agents.http,
    });
    up.setNoDelay(true);
    up.on("response", (answer) => {
      res.writeHead(answer.statusCode ?? 502, forwardHeaders(answer.headers));
      res.flushHeaders();
      answer.pipe(res);
      // A stream the upstream cut short must not look complete to the runner.
      answer.on("close", () => {
        if (!answer.complete) res.destroy();
      });
    });
    up.on("error", (e) => {
      log("upstream_error", codeOf(e));
      if (!res.headersSent) {
        res.writeHead(502, { "content-length": "0" });
        res.end();
      } else {
        res.destroy();
      }
    });
    // The runner went away: so does the upstream call.
    res.on("close", () => {
      if (!res.writableFinished) up.destroy();
    });
    if ("bytes" in body) {
      up.end(body.bytes);
      return;
    }
    for (const chunk of body.prefix) up.write(chunk);
    req.pipe(up);
    req.resume();
  }

  async function rewriteAndForward(
    req: IncomingMessage,
    res: ServerResponse,
    target: URL,
    route: ProxyRoute,
  ): Promise<void> {
    const headers = forwardHeaders(req.headers);
    const read = await readBody(req, o.maxBodyBytes ?? MAX_BODY_BYTES);
    if (read === undefined) return; // the runner went away mid-body
    const started = now();
    if (!read.complete) {
      log("untouched", "oversize");
      if (route === "compress") frame(UNREADABLE, started);
      forward(req, res, target, headers, { prefix: read.chunks });
      return;
    }
    const raw = Buffer.concat(read.chunks);
    const encoding = req.headers["content-encoding"];
    const done = await rewriter.rewrite(raw, encoding);
    if (done.untouched !== undefined) log("untouched", done.untouched);
    if (route === "compress") frame(done.counts, started);
    const bytes = done.body ?? raw;
    const sized = { ...headers, "content-length": String(bytes.length) };
    forward(req, res, target, sized, { bytes });
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const t = targetOf(req.url);
    const shown =
      t === undefined
        ? "<unsafe target>"
        : t.path.length > TRACE_PATH_CHARS
          ? `${t.path.slice(0, TRACE_PATH_CHARS)}…`
          : t.path;
    const traced = (answer: string) => trace(`${answer} ${method} ${shown}`);
    // The runner's warm-up, sent without the bearer or any credential: answered here, empty.
    if (t !== undefined && method === "HEAD" && probes.has(t.path)) {
      traced("probe");
      refuse(req, res, 200);
      return;
    }
    if (!authorized(req.headers[PROXY_HEADER])) {
      log("unauthorized");
      traced("401");
      refuse(req, res, 401);
      return;
    }
    const route =
      t === undefined ? undefined : o.transform.route(method, t.path);
    if (t === undefined || route === undefined) {
      log("refused");
      traced("404");
      refuse(req, res, 404);
      return;
    }
    const target = new URL(`${basePath}${t.path}${t.search}`, base.origin);
    if (target.origin !== base.origin) {
      log("refused");
      traced("404");
      refuse(req, res, 404);
      return;
    }
    traced("forward");
    if (route === "pass" || method !== "POST") {
      forward(req, res, target, forwardHeaders(req.headers), { prefix: [] });
      return;
    }
    await rewriteAndForward(req, res, target, route);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log("internal", codeOf(e));
      if (!res.headersSent) {
        res.writeHead(502, { "content-length": "0" });
        res.end();
      } else {
        res.destroy();
      }
    });
  });
  server.on("connection", (socket: Socket) => socket.setNoDelay(true));
  server.on("error", (e) => log("internal", codeOf(e)));
  // Longer than a runner's own idle keep-alive, so it rarely writes into a socket being closed.
  server.keepAliveTimeout = 120_000;
  // Loopback, one session: a slow or idle caller holds nothing for long, and few may connect.
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.maxConnections = MAX_CONNECTIONS;

  const listening = await new Promise<Result<number>>((resolve) => {
    server.once("error", (e) =>
      resolve(
        err(
          frmError(
            "spawn_failed",
            `context proxy cannot listen (${codeOf(e)})`,
            {
              retryable: true,
            },
          ),
        ),
      ),
    );
    server.listen(o.port ?? 0, "127.0.0.1", () =>
      resolve(ok((server.address() as AddressInfo).port)),
    );
  });
  if (!listening.ok) {
    agents.http.destroy();
    agents.https.destroy();
    return listening;
  }
  server.unref();
  const port = listening.value;
  let closed: Promise<void> | undefined;
  return ok({
    url: `http://127.0.0.1:${port}`,
    port,
    close() {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        agents.http.destroy();
        agents.https.destroy();
      });
      return closed;
    },
  });
}
