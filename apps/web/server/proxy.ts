// The edge's proxy to the API: node:http only. The browser's cookie and any
// Authorization it sent are dropped; the operator's bearer is added upstream; a Set-Cookie from
// upstream never reaches the browser. The bearer is never written towards the client.
import http, {
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { LOCAL_BROWSER_HEADER } from "./local-browser.js";
import type { WsPair } from "./sessions.js";

/**
 * Request headers that never go upstream: hop-by-hop, the browser's own credentials, and the
 * "browser on the host" signal (§14 amendment) — the edge never vouches for that, so a
 * deployed install is never local, and a browser's own copy must not reach the API.
 */
const DROP_UP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "cookie",
  "authorization",
  LOCAL_BROWSER_HEADER,
]);

/** Response headers that never go back: hop-by-hop, and any cookie the API might set. */
const DROP_DOWN = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "set-cookie",
]);

function upstreamHeaders(
  req: IncomingMessage,
  target: URL,
  token: string,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined && !DROP_UP.has(name)) out[name] = value;
  }
  out.host = target.host;
  out.authorization = `Bearer ${token}`;
  return out;
}

/**
 * `path` is the canonical path the edge checked (its pathname and search, security review), never the
 * raw request target: the bytes that passed the access check are the bytes sent upstream.
 */
const requestOptions = (
  target: URL,
  req: IncomingMessage,
  path: string,
  headers: OutgoingHttpHeaders,
) => ({
  protocol: target.protocol,
  hostname: target.hostname,
  port: target.port,
  method: req.method ?? "GET",
  path,
  headers,
});

/** One HTTP request to the API, streamed both ways. */
export function forwardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  path: string,
  token: string,
  onError: (e: Error) => void,
): void {
  const upstream = http.request(
    requestOptions(target, req, path, upstreamHeaders(req, target, token)),
    (up) => {
      const headers: OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(up.headers)) {
        if (value !== undefined && !DROP_DOWN.has(name)) headers[name] = value;
      }
      res.writeHead(up.statusCode ?? 502, headers);
      up.on("error", () => res.destroy());
      up.pipe(res);
    },
  );
  // A browser that gives up (an aborted fetch) closes `res` before it finished: the API's request
  // goes too, never left running unbounded (code review). Not on `req` close: Node emits that as
  // soon as the request body has been read.
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  upstream.on("error", (e) => {
    onError(e);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error: {
          class: "internal",
          message: "the API is not answering",
          retryable: true,
        },
      }),
    );
  });
  req.pipe(upstream);
}

const rawResponse = (status: number, text: string): string =>
  `HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`;

/**
 * A WebSocket upgrade to the API with the bearer added. The API's own handshake check still
 * applies: a refusal there (401) is passed back as it is. `onOpen` gets the pair once both sides
 * are connected, so the session can close it later.
 */
export function forwardUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: URL,
  path: string,
  token: string,
  onOpen: (pair: WsPair) => void,
  onError: (e: Error) => void,
): void {
  const headers = upstreamHeaders(req, target, token);
  headers.connection = "Upgrade";
  headers.upgrade = req.headers.upgrade ?? "websocket";
  const upstream = http.request(requestOptions(target, req, path, headers));
  upstream.on("upgrade", (res, upSocket, upHead) => {
    const lines = [
      `HTTP/1.1 ${res.statusCode ?? 101} ${res.statusMessage ?? "Switching Protocols"}`,
    ];
    for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
      const name = res.rawHeaders[i] ?? "";
      if (name.toLowerCase() === "set-cookie") continue;
      lines.push(`${name}: ${res.rawHeaders[i + 1] ?? ""}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (upHead.length > 0) socket.write(upHead);
    if (head.length > 0) upSocket.write(head);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    const end = (): void => {
      upSocket.destroy();
      socket.destroy();
    };
    upSocket.on("error", end);
    socket.on("error", end);
    upSocket.on("close", () => socket.destroy());
    socket.on("close", () => upSocket.destroy());
    onOpen({ client: socket, upstream: upSocket });
  });
  upstream.on("response", (res) => {
    res.resume();
    socket.end(
      rawResponse(res.statusCode ?? 502, res.statusMessage ?? "Refused"),
    );
  });
  upstream.on("error", (e) => {
    onError(e);
    socket.end(rawResponse(502, "Bad Gateway"));
  });
  upstream.end();
}
