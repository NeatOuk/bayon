// The gateway's /mcp relay, the real script under local node: a stand-in API on
// a unix socket (the tunnel's end) records every request that reaches it, and each probe is sent raw
// over TCP, so no client library normalises a path first. Only an exact POST /mcp may reach it.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import {
  connect,
  createServer as createNetServer,
  type AddressInfo,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { admit, forwardable, startRelay } from "./mcp-relay.mjs";

const PATH = "/mcp";
const RELAY = fileURLToPath(new URL("./mcp-relay.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "frm-relay-"));
const socket = join(dir, "mcp.sock");
/** What reached the stand-in API: `<method> <url> <authorization>`. */
const seen: string[] = [];
let api: Server;
let relay: Server;
let port = 0;

beforeAll(async () => {
  api = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? "-"}`);
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      if (req.headers.authorization === undefined) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end('{"message":"missing bearer token"}');
        return;
      }
      if (body === "stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: message\ndata: one\n\n");
        setTimeout(() => res.end("event: message\ndata: two\n\n"), 50);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ echo: body, via: req.headers.host }));
    });
  });
  await new Promise<void>((resolve) => api.listen(socket, resolve));
  relay = await startRelay({ port: 0, host: "127.0.0.1", socket, path: PATH });
  port = (relay.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => relay.close(resolve));
  await new Promise((resolve) => api.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Every status line in the stream: a pipelined exchange has more than one. */
  readonly statuses: readonly number[];
}

/** A chunked body's payload (the relay re-chunks an answer that has no length). */
function dechunk(raw: string): string {
  let out = "";
  let rest = raw;
  for (;;) {
    const eol = rest.indexOf("\r\n");
    const size = Number.parseInt(rest.slice(0, eol), 16);
    if (eol < 0 || !(size > 0)) return out;
    out += rest.slice(eol + 2, eol + 2 + size);
    rest = rest.slice(eol + 2 + size + 2);
  }
}

/** Sends `raw` as it is and reads until the relay closes the connection. */
function send(raw: string, to = port): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const s = connect(to, "127.0.0.1");
    let text = "";
    s.setTimeout(5_000, () => s.destroy(new Error("no close within 5 s")));
    s.on("data", (chunk: Buffer) => (text += chunk.toString("latin1")));
    s.on("error", reject);
    s.on("close", () => {
      const [head = "", ...rest] = text.split("\r\n\r\n");
      const [statusLine = "", ...lines] = head.split("\r\n");
      const headers = Object.fromEntries(
        lines.map((l) => {
          const at = l.indexOf(":");
          return [l.slice(0, at).trim().toLowerCase(), l.slice(at + 1).trim()];
        }),
      );
      const raw = rest.join("\r\n\r\n");
      resolve({
        status: Number(statusLine.split(" ")[1] ?? 0),
        headers,
        body: headers["transfer-encoding"] === "chunked" ? dechunk(raw) : raw,
        statuses: [...text.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((m) =>
          Number(m[1]),
        ),
      });
    });
    s.write(raw);
  });
}

const req = (
  method: string,
  target: string,
  extra: readonly string[] = [],
  body = "",
): string =>
  [
    `${method} ${target} HTTP/1.1`,
    "Host: frm-ctr-lab-gateway:3010",
    "Connection: close",
    ...extra,
    ...(body === "" ? [] : [`Content-Length: ${Buffer.byteLength(body)}`]),
    "",
    body,
  ].join("\r\n");

describe("admit", () => {
  test("only an exact POST on the path, without an upgrade", () => {
    expect(admit("POST", "/mcp", {}, PATH)).toBeNull();
    expect(admit("GET", "/mcp", {}, PATH)).toMatchObject({ status: 405 });
    expect(admit("POST", "/mcp/", {}, PATH)).toMatchObject({ status: 404 });
    expect(
      admit("POST", "/mcp", { connection: "keep-alive, Upgrade" }, PATH),
    ).toMatchObject({ status: 403 });
    expect(admit("POST", "/mcp", { upgrade: "h2c" }, PATH)).toMatchObject({
      status: 403,
    });
  });

  test("forwardable drops hop-by-hop headers, Host and what Connection names", () => {
    expect(
      forwardable({
        host: "gw:3010",
        connection: "keep-alive, x-secret-hop",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked",
        "proxy-authorization": "Basic x",
        te: "trailers",
        upgrade: "websocket",
        "x-secret-hop": "1",
        authorization: "Bearer tok",
        "content-type": "application/json",
        "content-length": "2",
        "mcp-protocol-version": "2025-06-18",
        expect: "100-continue",
      }),
    ).toEqual({
      authorization: "Bearer tok",
      "content-type": "application/json",
      "content-length": "2",
      "mcp-protocol-version": "2025-06-18",
    });
  });
});

describe("the relay, over TCP", { timeout: 20_000 }, () => {
  test("POST /mcp reaches the API: status, body and the bearer pass through", async () => {
    const before = seen.length;
    const anon = await send(req("POST", "/mcp", [], "{}"));
    expect(anon.status).toBe(401);
    expect(anon.headers["x-frm-relay"]).toBeUndefined();
    const ok = await send(
      req("POST", "/mcp", ["Authorization: Bearer tok-1"], '{"id":1}'),
    );
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ echo: '{"id":1}', via: "localhost" });
    expect(seen.slice(before)).toEqual([
      "POST /mcp -",
      "POST /mcp Bearer tok-1",
    ]);
  });

  test("a streamed (SSE) answer streams through", async () => {
    const answer = await send(
      req("POST", "/mcp", ["Authorization: Bearer tok-2"], "stream"),
    );
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("text/event-stream");
    expect(answer.body).toContain("data: one");
    expect(answer.body).toContain("data: two");
  });

  const refusals: readonly (readonly [string, string, number])[] = [
    ["GET", "/mcp", 405],
    ["DELETE", "/mcp", 405],
    ["OPTIONS", "/mcp", 405],
    ["PUT", "/mcp", 405],
    ["POST", "/api/v1/tickets", 404],
    ["GET", "/api/v1/executors", 404],
    ["POST", "/mcp/../api/v1/tickets", 404],
    ["POST", "/mcp/%2e%2e/api/v1/tickets", 404],
    ["POST", "/mcp%2F..%2Fapi%2Fv1%2Ftickets", 404],
    ["POST", "/mcp/..%2Fapi/v1/tickets", 404],
    ["POST", "/%6Dcp", 404],
    ["POST", "/%6dcp", 404],
    ["POST", "//mcp", 404],
    ["POST", "/./mcp", 404],
    ["POST", "/mcp/", 404],
    ["POST", "/mcp?x=1", 404],
    ["POST", "/mcp#frag", 404],
    ["POST", "/MCP", 404],
    ["POST", "/mcp;x", 404],
    ["POST", "http://frm-ctr-lab-gateway:3010/mcp", 404],
    ["POST", "http://127.0.0.1:3000/api/v1/tickets", 404],
    ["POST", "*", 404],
  ];
  test.each(refusals)(
    "%s %s is refused %i by the relay, and never reaches the API",
    async (method, target, status) => {
      const before = seen.length;
      const answer = await send(
        req(method, target, ["Authorization: Bearer tok-3"], "{}"),
      );
      expect(answer.status).toBe(status);
      expect(answer.headers["x-frm-relay"]).toBe("refused");
      if (status === 405) expect(answer.headers["allow"]).toBe("POST");
      expect(seen.slice(before)).toEqual([]);
    },
  );

  test("a WebSocket upgrade, on /mcp or elsewhere, is refused 403", async () => {
    const before = seen.length;
    const ws = [
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
    ];
    for (const [method, target] of [
      ["GET", "/mcp"],
      ["POST", "/mcp"],
      ["GET", "/ws"],
    ] as const) {
      const answer = await send(
        [`${method} ${target} HTTP/1.1`, "Host: gw:3010", ...ws, "", ""].join(
          "\r\n",
        ),
      );
      expect(answer.status, `${method} ${target}`).toBe(403);
      expect(answer.headers["x-frm-relay"]).toBe("refused");
    }
    const h2c = await send(
      req("POST", "/mcp", [
        "Upgrade: h2c",
        "HTTP2-Settings: AAMAAABkAAQCAAAAAAIAAAAA",
      ]),
    );
    expect(h2c.status).toBe(403);
    expect(seen.slice(before)).toEqual([]);
  });

  test("CONNECT, an h2 preface and CL+TE smuggling never reach the API", async () => {
    const before = seen.length;
    const tunnel = await send(
      "CONNECT 127.0.0.1:22 HTTP/1.1\r\nHost: 127.0.0.1:22\r\n\r\n",
    );
    expect(tunnel.status).toBe(403);
    const h2 = await send("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
    expect(h2.status).toBe(400);
    const smuggled = await send(
      [
        "POST /mcp HTTP/1.1",
        "Host: gw:3010",
        "Content-Length: 4",
        "Transfer-Encoding: chunked",
        "",
        "0",
        "",
        "GET /api/v1/tickets HTTP/1.1",
        "Host: gw:3010",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );
    expect(smuggled.statuses[0]).toBe(400);
    expect(
      seen.slice(before).filter((s) => !s.startsWith("POST /mcp ")),
    ).toEqual([]);
  });

  test("a request pipelined after an admitted one is judged on its own: refused", async () => {
    const before = seen.length;
    const answer = await send(
      [
        "POST /mcp HTTP/1.1",
        "Host: gw:3010",
        "Content-Length: 2",
        "",
        "{}GET /api/v1/tickets HTTP/1.1",
        "Host: gw:3010",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );
    expect(answer.statuses).toEqual([401, 404]);
    expect(seen.slice(before)).toEqual(["POST /mcp -"]);
  });

  test("the API unreachable: 502 from the relay", async () => {
    const lonely = await startRelay({
      port: 0,
      host: "127.0.0.1",
      socket: join(dir, "absent.sock"),
      path: PATH,
    });
    try {
      const answer = await send(
        req("POST", "/mcp", [], "{}"),
        (lonely.address() as AddressInfo).port,
      );
      expect(answer.status).toBe(502);
      expect(answer.headers["x-frm-relay"]).toBe("upstream");
    } finally {
      await new Promise((resolve) => lonely.close(resolve));
    }
  });

  test("a client that never finishes its headers is cut off, and nothing reaches the API", async () => {
    const before = seen.length;
    const slow = await startRelay({
      port: 0,
      host: "127.0.0.1",
      socket,
      path: PATH,
      headersTimeoutMs: 200,
      requestTimeoutMs: 400,
    });
    try {
      const began = Date.now();
      // No blank line: the headers never end.
      const answer = await send(
        "POST /mcp HTTP/1.1\r\nHost: gw:3010\r\nX-Slow: 1\r\n",
        (slow.address() as AddressInfo).port,
      );
      expect(Date.now() - began).toBeLessThan(4_000);
      expect([400, 408]).toContain(answer.status);
      expect(seen.slice(before)).toEqual([]);
    } finally {
      await new Promise((resolve) => slow.close(resolve));
    }
  });

  test("refuses to start on a path that is not one", async () => {
    for (const path of ["", "mcp", "/mcp?x", "/m cp", "/mcp\n"]) {
      await expect(
        startRelay({ port: 0, host: "127.0.0.1", socket, path }),
      ).rejects.toThrow(/not a relay path/);
    }
  });
});

/** An open connection to the relay, and its answer once it closes. */
function open(to: number) {
  const s = connect(to, "127.0.0.1");
  let text = "";
  s.on("data", (chunk: Buffer) => (text += chunk.toString("latin1")));
  s.on("error", () => undefined);
  const ready = new Promise<void>((resolve) => s.once("connect", resolve));
  const closed = new Promise<string[]>((resolve) =>
    s.once("close", () =>
      resolve(
        [...text.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((m) => m[1] ?? ""),
      ),
    ),
  );
  return { s, ready, closed, text: () => text };
}

const connections = (server: Server): Promise<number> =>
  new Promise((resolve, reject) =>
    server.getConnections((e, n) => (e ? reject(e) : resolve(n))),
  );

describe("connection caps", { timeout: 20_000 }, () => {
  test.each([
    ["the relay's cap", { maxConnections: 3, maxPerClient: 100 }],
    ["the cap per client address", { maxConnections: 100, maxPerClient: 3 }],
  ] as const)(
    "%s: connection 4 is closed unanswered; the first 3 still work, and a freed slot is taken again",
    async (_cap, caps) => {
      const before = seen.length;
      const relay = await startRelay({
        port: 0,
        host: "127.0.0.1",
        socket,
        path: PATH,
        ...caps,
      });
      const to = (relay.address() as AddressInfo).port;
      try {
        const first = [open(to), open(to), open(to)];
        await Promise.all(first.map((c) => c.ready));
        await expect.poll(() => connections(relay)).toBe(3);
        const fourth = open(to);
        fourth.s.write(req("POST", "/mcp", [], "{}"));
        expect(await fourth.closed).toEqual([]);
        for (const c of first) c.s.write(req("POST", "/mcp", [], "{}"));
        for (const c of first) expect(await c.closed).toEqual(["401"]);
        expect(seen.slice(before)).toEqual([
          "POST /mcp -",
          "POST /mcp -",
          "POST /mcp -",
        ]);
        // The three are closed: a new connection is taken.
        await expect.poll(() => connections(relay)).toBe(0);
        expect((await send(req("POST", "/mcp", [], "{}"), to)).status).toBe(
          401,
        );
      } finally {
        await new Promise((resolve) => relay.close(resolve));
      }
    },
  );
});

describe("Expect: 100-continue", { timeout: 20_000 }, () => {
  const head = (method: string, target: string) =>
    [
      `${method} ${target} HTTP/1.1`,
      "Host: gw:3010",
      "Connection: close",
      "Expect: 100-continue",
      "Content-Length: 2",
      "",
      "",
    ].join("\r\n");

  test("an admitted POST /mcp hears 100 Continue, then the API's answer", async () => {
    const before = seen.length;
    const c = open(port);
    await c.ready;
    c.s.write(head("POST", "/mcp"));
    await expect.poll(() => c.text()).toContain("HTTP/1.1 100 Continue");
    c.s.write("{}");
    expect(await c.closed).toEqual(["100", "401"]);
    expect(seen.slice(before)).toEqual(["POST /mcp -"]);
  });

  test.each([
    ["POST", "/api/v1/tickets", "404"],
    ["GET", "/mcp", "405"],
    ["POST", "/mcp/../api/v1/tickets", "404"],
  ] as const)(
    "%s %s hears no 100 Continue: the relay's refusal (%s) comes in its place",
    async (method, target, status) => {
      const before = seen.length;
      const c = open(port);
      await c.ready;
      c.s.write(head(method, target));
      expect(await c.closed).toEqual([status]);
      expect(c.text()).toMatch(/x-frm-relay: refused/i);
      expect(c.text()).not.toContain("100 Continue");
      expect(seen.slice(before)).toEqual([]);
    },
  );
});

describe("as the gateway runs it", { timeout: 20_000 }, () => {
  const freePort = async (): Promise<number> => {
    const probe = createNetServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port: p } = probe.address() as AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    return p;
  };

  test("its env configures it; it relays POST /mcp and refuses the rest", async () => {
    const p = await freePort();
    const child = spawn(process.execPath, [RELAY], {
      env: {
        FRM_MCP_PORT: String(p),
        FRM_MCP_PATH: PATH,
        FRM_MCP_SOCKET: socket,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let log = "";
    child.stderr.on("data", (chunk: Buffer) => (log += chunk.toString()));
    try {
      await expect
        .poll(() => log, { timeout: 10_000 })
        .toContain(`relaying POST ${PATH} on :${p}`);
      expect((await send(req("POST", "/mcp", [], "{}"), p)).status).toBe(401);
      const refused = await send(req("GET", "/api/v1/tickets"), p);
      expect(refused.status).toBe(404);
      await expect.poll(() => log).toContain("refused 404 GET /api/v1/tickets");
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("a missing or bad env is a usage error, exit 2", async () => {
    for (const env of [
      {},
      { FRM_MCP_PORT: "3010" },
      { FRM_MCP_PORT: "0", FRM_MCP_PATH: PATH },
      { FRM_MCP_PORT: "3010", FRM_MCP_PATH: "/mcp'$(x)" },
    ]) {
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [RELAY], {
          env,
          stdio: "ignore",
        });
        child.on("exit", resolve);
      });
      expect(code, JSON.stringify(env)).toBe(2);
    }
  });
});
