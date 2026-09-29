// @ts-check
// The gateway's /mcp relay: the only door from a session's internal network to
// the API, through the supervisor's reverse tunnel (a unix socket the gateway mounts read-only). It
// is a reverse proxy, not a byte pipe: node's strict parser reads each request, and only an exact
// `POST $FRM_MCP_PATH` is re-issued, as a new request, to the socket. Every other path, method,
// upgrade or CONNECT is answered here and never reaches the API. Zero dependencies, node >= 20; it
// runs its entry point only when it is the main module, so the tests can import it.
//
// It holds at most MAX_CONNECTIONS at once and MAX_PER_CLIENT from one address (one session
// container), so no session can starve its siblings of /mcp; and an `Expect: 100-continue` hears
// "continue" only once the request is admitted.
//
//   env FRM_MCP_PORT     the port it listens on, on every interface of the gateway
//       FRM_MCP_PATH     the one path relayed, compared byte for byte with the raw request-target
//       FRM_MCP_SOCKET   the tunnel's socket (default /frm/run/mcp.sock)
import { realpathSync } from "node:fs";
import { createServer, request } from "node:http";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_SOCKET = "/frm/run/mcp.sock";
/** What FRM_MCP_PATH may be: an absolute path of plain characters. */
const PATH = /^\/[A-Za-z0-9._/-]{1,255}$/;
/** The mark every answer of the relay's own carries, so no one mistakes it for the API's. */
const REFUSED = "refused";
/** Hop-by-hop headers (RFC 9110 §7.6.1), Host, and Expect (the relay answered it): never
 * forwarded in either direction. */
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "expect",
]);
const LOG_TARGET_MAX = 200;
/** A request's headers must arrive within this, and the whole request within the next: bounds on
 * receiving it only, never on the answer (an SSE stream runs as long as the API keeps it). */
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;
/**
 * Connections held at once. A relayed request holds its client's socket and one upstream socket, so
 * 64 stay far inside the gateway's `nofile` 1024 (beside tinyproxy's 64 clients) and its 256 MiB. An
 * MCP client needs one connection per call in flight, a handful at most.
 */
const MAX_CONNECTIONS = 64;
/**
 * Connections held from one address, one session container on the internal network: a quarter of
 * the cap, so a session that opens all it can still leaves its siblings most of the relay.
 */
const MAX_PER_CLIENT = 16;

/**
 * @param {string | string[] | undefined} value
 * @returns {string[]}
 */
function tokens(value) {
  const joined = Array.isArray(value) ? value.join(",") : (value ?? "");
  return joined
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== "");
}

/**
 * Whether a request may pass: null, or the relay's own answer. On the raw request-target, never a
 * decoded or normalised form, so `/mcp/../api`, `/%6Dcp`, `//mcp` and `/mcp?x` are all another path.
 * @param {string | undefined} method
 * @param {string | undefined} target
 * @param {import("node:http").IncomingHttpHeaders} headers
 * @param {string} path
 * @returns {{ readonly status: number, readonly reason: string } | null}
 */
export function admit(method, target, headers, path) {
  if (
    headers.upgrade !== undefined ||
    tokens(headers.connection).includes("upgrade")
  ) {
    return { status: 403, reason: "no protocol upgrade through the relay" };
  }
  if (target !== path) {
    return { status: 404, reason: `only POST ${path} is relayed` };
  }
  if (method !== "POST") {
    return { status: 405, reason: `only POST ${path} is relayed` };
  }
  return null;
}

/**
 * A copy of `headers` without the hop-by-hop ones, Host, and any header `Connection` names.
 * @param {import("node:http").IncomingHttpHeaders} headers
 * @returns {import("node:http").OutgoingHttpHeaders}
 */
export function forwardable(headers) {
  const named = new Set(tokens(headers.connection));
  /** @type {import("node:http").OutgoingHttpHeaders} */
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP.has(name) || named.has(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * A request-target fit for one log line: control characters escaped, length capped.
 * @param {string | undefined} target
 */
function printable(target) {
  const t = JSON.stringify(target ?? "").slice(1, -1);
  return t.length > LOG_TARGET_MAX ? `${t.slice(0, LOG_TARGET_MAX)}…` : t;
}

/** The raw answer on a socket node hands over (upgrade, CONNECT, a parse error). */
const RAW = {
  403: "HTTP/1.1 403 Forbidden\r\nX-Frm-Relay: refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
  400: "HTTP/1.1 400 Bad Request\r\nX-Frm-Relay: refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
};

/**
 * @param {import("node:stream").Duplex} socket
 * @param {403 | 400} status
 */
function refuseRaw(socket, status) {
  if (socket.writable) socket.end(RAW[status]);
  else socket.destroy();
}

/**
 * @typedef {object} RelayOptions
 * @property {number} port 0 picks a free one
 * @property {string} [host] default: every interface
 * @property {string} socket
 * @property {string} path
 * @property {(line: string) => void} [log]
 * @property {number} [headersTimeoutMs] default 10 s
 * @property {number} [requestTimeoutMs] default 60 s
 * @property {number} [maxConnections] default 64
 * @property {number} [maxPerClient] default 16
 */

/**
 * Listens and relays until closed.
 * @param {RelayOptions} o
 * @returns {Promise<import("node:http").Server>}
 */
export function startRelay(o) {
  if (!PATH.test(o.path)) {
    return Promise.reject(
      new Error(`not a relay path: ${JSON.stringify(o.path)}`),
    );
  }
  const log = o.log ?? (() => undefined);
  const headersTimeout = o.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;
  const requestTimeout = o.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const options = {
    headersTimeout,
    requestTimeout,
    // Node enforces both only when it checks its connections: often enough for the smaller.
    connectionsCheckingInterval: Math.max(
      50,
      Math.min(1_000, Math.floor(headersTimeout / 2)),
    ),
  };
  /**
   * The relay's own answer to a refused request: its mark, and the connection closed.
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @param {{ readonly status: number, readonly reason: string }} refused
   */
  const refuse = (req, res, refused) => {
    log(`refused ${refused.status} ${req.method ?? "?"} ${printable(req.url)}`);
    res.writeHead(refused.status, {
      "content-type": "text/plain; charset=utf-8",
      "x-frm-relay": REFUSED,
      connection: "close",
      ...(refused.status === 405 ? { allow: "POST" } : {}),
    });
    res.end(`frm relay: ${refused.reason}\n`);
  };
  /**
   * An admitted request, re-issued to the tunnel's socket; its answer streamed back.
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  const forward = (req, res) => {
    const upstream = request({
      socketPath: o.socket,
      method: "POST",
      path: o.path,
      headers: forwardable(req.headers),
    });
    upstream.on("response", (answer) => {
      res.writeHead(answer.statusCode ?? 502, forwardable(answer.headers));
      answer.pipe(res);
    });
    upstream.on("error", (e) => {
      log(`upstream: ${e.message}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, {
        "content-type": "text/plain; charset=utf-8",
        "x-frm-relay": "upstream",
        connection: "close",
      });
      res.end("frm relay: the API is unreachable\n");
    });
    // A client that goes away takes its upstream request with it.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  };
  const server = createServer(options, (req, res) => {
    const refused = admit(req.method, req.url, req.headers, o.path);
    if (refused === null) forward(req, res);
    else refuse(req, res, refused);
  });
  // Node would answer `Expect: 100-continue` itself, before any check: here only an admitted
  // request hears "continue"; a refused one gets the refusal in its place.
  server.on("checkContinue", (req, res) => {
    const refused = admit(req.method, req.url, req.headers, o.path);
    if (refused !== null) {
      refuse(req, res, refused);
      return;
    }
    res.writeContinue();
    forward(req, res);
  });
  const maxConnections = o.maxConnections ?? MAX_CONNECTIONS;
  const maxPerClient = o.maxPerClient ?? MAX_PER_CLIENT;
  server.maxConnections = maxConnections;
  server.on("drop", (d) => {
    log(
      `refused a connection from ${d?.remoteAddress ?? "?"}: ${maxConnections} already open`,
    );
  });
  /** Open connections by client address. */
  const held = new Map();
  server.on("connection", (socket) => {
    const who = socket.remoteAddress ?? "?";
    const open = held.get(who) ?? 0;
    if (open >= maxPerClient) {
      log(
        `refused a connection from ${who}: ${open} already open (at most ${maxPerClient} per client)`,
      );
      socket.destroy();
      return;
    }
    held.set(who, open + 1);
    socket.once("close", () => {
      const left = (held.get(who) ?? 1) - 1;
      if (left > 0) held.set(who, left);
      else held.delete(who);
    });
  });
  server.on("upgrade", (req, socket) => {
    log(`refused upgrade ${req.method ?? "?"} ${printable(req.url)}`);
    refuseRaw(socket, 403);
  });
  server.on("connect", (req, socket) => {
    log(`refused CONNECT ${printable(req.url)}`);
    refuseRaw(socket, 403);
  });
  server.on("clientError", (e, socket) => {
    log(`refused unparsable request: ${e.message}`);
    refuseRaw(socket, 400);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function main() {
  const port = Number(process.env["FRM_MCP_PORT"]);
  const path = process.env["FRM_MCP_PATH"] ?? "";
  const socket = process.env["FRM_MCP_SOCKET"] ?? DEFAULT_SOCKET;
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !PATH.test(path)
  ) {
    process.stderr.write(
      "usage: FRM_MCP_PORT=<port> FRM_MCP_PATH=<path> [FRM_MCP_SOCKET=<socket>] mcp-relay\n",
    );
    process.exitCode = 2;
    return;
  }
  const log = (/** @type {string} */ line) =>
    process.stderr.write(`mcp-relay: ${line}\n`);
  startRelay({ port, socket, path, log }).then(
    () => log(`relaying POST ${path} on :${port} to ${socket}`),
    (/** @type {unknown} */ e) => {
      log(`cannot listen: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}

/** Run as a program (never on import, so tests can load the functions above). */
function isMain() {
  try {
    return (
      realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}

if (isMain()) main();
