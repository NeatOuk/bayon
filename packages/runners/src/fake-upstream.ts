// A stand-in model provider for tests of the context proxy (spec M12): it records every request it
// gets, whole, and answers with a handler, by default an echo of the body it received, so a test (or a
// stub runner playing the model) can read back exactly what the proxy forwarded. Runner-neutral;
// tests only, never in a production path.
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface UpstreamRequest {
  readonly method: string;
  /** The request target as received: path and query. */
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export type UpstreamHandler = (
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse,
) => void;

export interface FakeUpstream {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly port: number;
  /** Every request so far, in arrival order. */
  readonly requests: readonly UpstreamRequest[];
  close(): Promise<void>;
}

/** Answers with the body it got (JSON), so what the proxy forwarded can be read back. */
export const echo: UpstreamHandler = (req, body, res) => {
  res.writeHead(200, {
    "content-type": req.headers["content-type"] ?? "application/json",
    "content-length": String(body.length),
  });
  res.end(body);
};

/**
 * Echoes only under `prefix`, a provider base URL's own path (a local model server's chat API is
 * under `/v1`, a gateway's may be anything), and answers 404 anywhere else, as a real provider
 * answers a path it does not serve: a proxy that dropped the base URL's path fails against it.
 */
export const echoUnder =
  (prefix: string): UpstreamHandler =>
  (req, body, res) => {
    if ((req.url ?? "").startsWith(`${prefix}/`)) {
      echo(req, body, res);
      return;
    }
    res.writeHead(404, { "content-length": "0" });
    res.end();
  };

export async function startFakeUpstream(
  handler: UpstreamHandler = echo,
): Promise<FakeUpstream> {
  const requests: UpstreamRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      });
      handler(req, body, res);
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    );
  });
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
