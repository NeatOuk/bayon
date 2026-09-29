import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { FakeClock } from "@bayon/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { loadEdgeConfig } from "./config.js";
import { createEdge, type Edge } from "./edge.js";
import {
  hashPassword,
  parsePasswordHash,
  type PasswordHash,
} from "./password.js";
import { LOGIN_LIMITS } from "./rate-limit.js";

// Real HTTP servers, sockets and upgrades: more than the default 5 s on a loaded host.
vi.setConfig({ testTimeout: 30_000 });

// The edge server over real HTTP: a stub API records every request it gets,
// so "the upstream saw nothing" is checked, not assumed. The client connects over IPv4 or IPv6
// loopback: two addresses, for the address binding. No response may ever carry the bearer.
const TOKEN = "bearer-token-0123456789abcdef";
const PASSWORD = "correct-horse-battery-staple-42";
const ORIGIN = "http://gui.test:5173";
const HOST = "gui.test:5173";
const OWN = { origin: ORIGIN, "sec-fetch-site": "same-origin" } as const;

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

let upstream: http.Server;
const upgraded = new Set<Duplex>();
let onSlowClosed: () => void = () => undefined;
let seen: Seen[] = [];
let staticDir: string;
let passwordHash: PasswordHash;

beforeAll(async () => {
  const parsed = parsePasswordHash(await hashPassword(PASSWORD, { logN: 14 }));
  if (!parsed.ok) throw new Error(parsed.error.message);
  passwordHash = parsed.value;
  staticDir = mkdtempSync(join(tmpdir(), "frm-edge-static-"));
  writeFileSync(
    join(staticDir, "index.html"),
    "<!doctype html><title>Bayon</title>",
  );
  mkdirSync(join(staticDir, "assets"));
  writeFileSync(join(staticDir, "assets", "app-1a2b.js"), "console.log(1)");
  upstream = http.createServer((req, res) => {
    if (req.url === "/api/v1/slow") {
      // Never answers: only the edge tearing the request down ends it (code review).
      seen.push({
        method: req.method ?? "",
        url: req.url,
        headers: req.headers,
      });
      res.on("close", () => onSlowClosed());
      return;
    }
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
    });
    req.resume();
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "api=1",
    });
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  upstream.on("upgrade", (req, socket) => {
    seen.push({ method: "UPGRADE", url: req.url ?? "", headers: req.headers });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
    );
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    socket.on("data", (chunk: Buffer) => socket.write(chunk));
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
});

afterAll(async () => {
  // An upgraded socket is no longer the server's: close() would wait for it forever.
  for (const socket of upgraded) socket.destroy();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(staticDir, { recursive: true, force: true });
});

let edge: Edge;
let port: number;
let clock: FakeClock;

async function start(
  loginLimits = { ...LOGIN_LIMITS, globalIntervalMs: 0 },
  loginBodyTimeoutMs = 5_000,
): Promise<void> {
  clock = new FakeClock(Date.UTC(2026, 8, 14));
  const { port: up } = upstream.address() as AddressInfo;
  edge = createEdge({
    config: {
      origins: new Set([ORIGIN]),
      apiTarget: new URL(`http://127.0.0.1:${up}`),
      token: TOKEN,
      passwordHash,
      staticDir,
    },
    clock,
    log: () => undefined,
    loginLimits,
    loginBodyTimeoutMs,
  });
  await new Promise<void>((resolve) => edge.server.listen(0, "::", resolve));
  port = (edge.server.address() as AddressInfo).port;
}

beforeEach(async () => {
  seen = [];
  await start();
});
afterEach(async () => {
  await edge.close();
});

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function call(
  path: string,
  o: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly family?: 4 | 6;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: o.family === 6 ? "::1" : "127.0.0.1",
        port,
        path,
        method: o.method ?? "GET",
        headers: { host: HOST, ...o.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const reply = {
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          };
          expect(JSON.stringify(reply)).not.toContain(TOKEN);
          resolve(reply);
        });
      },
    );
    req.on("error", reject);
    req.end(o.body);
  });
}

async function loginCookie(family: 4 | 6 = 4): Promise<string> {
  const reply = await call("/auth/login", {
    method: "POST",
    family,
    headers: { ...OWN, "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(reply.status).toBe(200);
  const set = reply.headers["set-cookie"]?.[0] ?? "";
  return set.split(";")[0] ?? "";
}

describe("routing, host and headers", () => {
  test("/healthz answers at any Host; anything else needs the GUI's own", async () => {
    expect(
      (await call("/healthz", { headers: { host: "127.0.0.1" } })).status,
    ).toBe(200);
    expect((await call("/", { headers: { host: "evil.test" } })).status).toBe(
      421,
    );
  });

  test("the app is public: index.html, immutable assets, no traversal", async () => {
    const index = await call("/");
    expect(index.status).toBe(200);
    expect(index.body).toContain("<title>Bayon</title>");
    expect(index.headers["cache-control"]).toBe("no-store");
    const asset = await call("/assets/app-1a2b.js");
    expect(asset.headers["cache-control"]).toMatch(/immutable/);
    expect((await call("/tickets/42")).body).toContain("Bayon");
    expect((await call("/missing.js")).status).toBe(404);
    // A traversal is normalised inside the root: it can only ever reach the app's own files.
    const escape = await call("/%2e%2e/%2e%2e/etc/passwd");
    expect(escape.body).not.toMatch(/root:/);
    expect(escape.body).toContain("<title>Bayon</title>");
    expect((await call("/%2e%2e/%2e%2e/etc/hosts.js")).status).toBe(404);
  });

  test("every response carries the CSP with the WebSocket origin named", async () => {
    const reply = await call("/");
    expect(reply.headers["content-security-policy"]).toContain(
      "connect-src 'self' ws://gui.test:5173",
    );
    expect(reply.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  });

  test("/mcp is never proxied", async () => {
    const cookie = await loginCookie();
    for (const path of ["/mcp", "/mcp/session"]) {
      expect(
        (await call(path, { method: "POST", headers: { ...OWN, cookie } }))
          .status,
      ).toBe(404);
    }
    expect(seen).toEqual([]);
  });
});

describe("the login", () => {
  test("/auth/me says who is logged in", async () => {
    expect((await call("/auth/me")).status).toBe(401);
    const cookie = await loginCookie();
    expect((await call("/auth/me", { headers: { cookie } })).status).toBe(200);
  });

  test("a wrong password is 401; the right one sets a browser-session cookie", async () => {
    const wrong = await call("/auth/login", {
      method: "POST",
      headers: { ...OWN, "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers["set-cookie"]).toBeUndefined();
    const right = await call("/auth/login", {
      method: "POST",
      headers: { ...OWN, "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const set = right.headers["set-cookie"]?.[0] ?? "";
    expect(set).toMatch(
      /^frm_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/,
    );
    expect(right.body).not.toContain(PASSWORD);
  });

  test("a login without the page's Origin, or not JSON, is refused", async () => {
    const body = JSON.stringify({ password: PASSWORD });
    const json = { "content-type": "application/json" };
    expect(
      (await call("/auth/login", { method: "POST", headers: json, body }))
        .status,
    ).toBe(403);
    expect(
      (
        await call("/auth/login", {
          method: "POST",
          headers: {
            ...json,
            origin: "http://gui.test:3001",
            "sec-fetch-site": "same-site",
          },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("/auth/login", {
          method: "POST",
          headers: { ...OWN, "content-type": "text/plain" },
          body,
        })
      ).status,
    ).toBe(415);
  });

  test("login always mints a new id and ends the one presented", async () => {
    const first = await loginCookie();
    const again = await call("/auth/login", {
      method: "POST",
      headers: { ...OWN, "content-type": "application/json", cookie: first },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const second = (again.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
    expect(second).not.toBe(first);
    expect(
      (await call("/auth/me", { headers: { cookie: first } })).status,
    ).toBe(401);
    expect(
      (await call("/auth/me", { headers: { cookie: second } })).status,
    ).toBe(200);
  });

  test("five failures from one address give it 429 with Retry-After; another address is not locked out", async () => {
    const attempt = (family: 4 | 6, password: string) =>
      call("/auth/login", {
        method: "POST",
        family,
        headers: { ...OWN, "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
    for (let i = 0; i < 5; i += 1)
      expect((await attempt(4, "wrong")).status).toBe(401);
    const refused = await attempt(4, PASSWORD);
    expect(refused.status).toBe(429);
    expect(refused.headers["retry-after"]).toBe("900");
    expect((await attempt(6, PASSWORD)).status).toBe(200);
  });

  test("the global rate: one attempt a second across addresses", async () => {
    await edge.close();
    await start(LOGIN_LIMITS);
    const attempt = (family: 4 | 6) =>
      call("/auth/login", {
        method: "POST",
        family,
        headers: { ...OWN, "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });
    expect((await attempt(4)).status).toBe(401);
    expect((await attempt(6)).status).toBe(429);
    await clock.advance(1_000);
    expect((await attempt(6)).status).toBe(401);
  });

  test("logout ends the session and clears the cookie", async () => {
    const cookie = await loginCookie();
    const out = await call("/auth/logout", {
      method: "POST",
      headers: { ...OWN, cookie },
    });
    expect(out.status).toBe(204);
    expect(out.headers["set-cookie"]?.[0]).toMatch(/Max-Age=0/);
    expect(
      (await call("/api/v1/fleet", { headers: { ...OWN, cookie } })).status,
    ).toBe(401);
  });

  test("an idle session expires", async () => {
    const cookie = await loginCookie();
    await clock.advance(2 * 3_600_000);
    expect((await call("/auth/me", { headers: { cookie } })).status).toBe(401);
  });
});

describe("the proxy", () => {
  test("/api without a login is 401 and the API sees nothing", async () => {
    expect((await call("/api/v1/fleet", { headers: OWN })).status).toBe(401);
    expect(seen).toEqual([]);
  });

  test("with a login, the API sees the bearer and never the cookie; its Set-Cookie is dropped", async () => {
    const cookie = await loginCookie();
    const reply = await call("/api/v1/fleet?x=1", {
      headers: { ...OWN, cookie, authorization: "Bearer forged" },
    });
    expect(reply.status).toBe(200);
    expect(reply.headers["set-cookie"]).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/v1/fleet?x=1" });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.headers.cookie).toBeUndefined();
  });

  test("a browser's own x-frm-local-browser never reaches the API: the edge is never local", async () => {
    const cookie = await loginCookie();
    const reply = await call("/api/v1/fleet", {
      headers: { ...OWN, cookie, "x-frm-local-browser": "1" },
    });
    expect(reply.status).toBe(200);
    expect(seen.at(-1)?.headers["x-frm-local-browser"]).toBeUndefined();
  });

  test.each([
    ["PUT", "/api/v1/settings"],
    ["GET", "/api/v1/audit?limit=50"],
    ["POST", "/api/v1/fleet/pause"],
    ["POST", "/api/v1/fleet/resume"],
  ])("%s %s (routes) is proxied with the bearer", async (method, path) => {
    const cookie = await loginCookie();
    const reply = await call(path, {
      method,
      headers: { ...OWN, cookie, "content-type": "application/json" },
      body: method === "GET" ? undefined : "{}",
    });
    expect(reply.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ method, url: path });
    expect(seen.at(-1)?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("a write without an Origin, from another port, or from a foreign site is refused", async () => {
    const cookie = await loginCookie();
    const tries: Readonly<Record<string, string>>[] = [
      { cookie },
      { cookie, origin: "http://gui.test:3001", "sec-fetch-site": "same-site" },
      { cookie, origin: "https://evil.test", "sec-fetch-site": "cross-site" },
    ];
    for (const headers of tries) {
      expect(
        (await call("/api/v1/fleet/pause", { method: "POST", headers })).status,
      ).toBe(403);
    }
    expect(seen).toEqual([]);
  });

  test("the cookie replayed from another address is useless", async () => {
    const cookie = await loginCookie(4);
    expect(
      (await call("/api/v1/fleet", { family: 6, headers: { ...OWN, cookie } }))
        .status,
    ).toBe(401);
    expect(
      (await call("/api/v1/fleet", { family: 4, headers: { ...OWN, cookie } }))
        .status,
    ).toBe(200);
  });

  test("of duplicate frm_session cookies, the valid one is accepted", async () => {
    const cookie = await loginCookie();
    const planted = `frm_session=${"Z".repeat(43)}`;
    const reply = await call("/api/v1/fleet", {
      headers: { ...OWN, cookie: `${planted}; ${cookie}` },
    });
    expect(reply.status).toBe(200);
  });
});

describe("an aborted request (code review)", () => {
  test("a browser that gives up closes the API's request too", async () => {
    const cookie = await loginCookie();
    const closed = new Promise<void>((resolve) => {
      onSlowClosed = resolve;
    });
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/api/v1/slow",
      headers: { host: HOST, ...OWN, cookie },
    });
    req.on("error", () => undefined);
    req.end();
    await expect
      .poll(() => seen.some((s) => s.url === "/api/v1/slow"))
      .toBe(true);
    req.destroy();
    // Resolves only when the edge destroyed its request to the API.
    await closed;
  });
});

describe("the request target and the guard (security review)", () => {
  test("the API receives the canonical path the edge checked, never the raw one", async () => {
    const cookie = await loginCookie();
    const reply = await call("/api/v1/x/../fleet?y=1", {
      headers: { ...OWN, cookie },
    });
    expect(reply.status).toBe(200);
    expect(seen.at(-1)?.url).toBe("/api/v1/fleet?y=1");
  });

  test("a dot segment that resolves to /mcp is refused like /mcp", async () => {
    const cookie = await loginCookie();
    const reply = await call("/api/%2e%2e/mcp", {
      method: "POST",
      headers: { ...OWN, cookie },
    });
    expect(reply.status).toBe(404);
    expect(seen).toEqual([]);
  });

  test.each(["/api/v1%2ffleet", "/api/v1%5Cfleet", "/api\\v1/fleet"])(
    "an ambiguous target %s is 400, and the API sees nothing",
    async (path) => {
      const cookie = await loginCookie();
      expect((await call(path, { headers: { ...OWN, cookie } })).status).toBe(
        400,
      );
      expect(seen).toEqual([]);
    },
  );

  test("a GET with neither Origin nor Sec-Fetch-Site does not ride the cookie", async () => {
    const cookie = await loginCookie();
    expect((await call("/api/v1/fleet", { headers: { cookie } })).status).toBe(
      403,
    );
    expect(
      (
        await call("/api/v1/fleet", {
          headers: { cookie, "sec-fetch-site": "same-origin" },
        })
      ).status,
    ).toBe(200);
  });

  test("a stalled login body gets 408 and never holds a scrypt slot", async () => {
    await edge.close();
    await start(
      { ...LOGIN_LIMITS, globalIntervalMs: 0, maxConcurrent: 1 },
      300,
    );
    const stall = () =>
      new Promise<string>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port });
        let text = "";
        socket.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          if (text.includes("\r\n\r\n")) {
            socket.destroy();
            resolve(text);
          }
        });
        socket.on("error", reject);
        socket.write(
          [
            "POST /auth/login HTTP/1.1",
            `host: ${HOST}`,
            `origin: ${ORIGIN}`,
            "sec-fetch-site: same-origin",
            "content-type: application/json",
            "content-length: 100",
            "",
            '{"pass',
          ].join("\r\n"),
        );
      });
    const stalled = [stall(), stall()];
    // Meanwhile the owner logs in: the stalled bodies hold no slot.
    await loginCookie();
    for (const text of await Promise.all(stalled))
      expect(text).toMatch(/^HTTP\/1\.1 408/);
  });
});

describe("the WebSocket", () => {
  interface Upgraded {
    readonly status: number;
    readonly received: () => Buffer;
    send(data: string): void;
    readonly closed: Promise<void>;
  }

  function upgrade(
    headers: Readonly<Record<string, string>>,
    family: 4 | 6 = 4,
    path = "/ws",
  ): Promise<Upgraded> {
    return new Promise((resolve, reject) => {
      const socket = connect({
        host: family === 6 ? "::1" : "127.0.0.1",
        port,
      });
      let buffer = Buffer.alloc(0);
      let status = 0;
      const closed = new Promise<void>((done) =>
        socket.on("close", () => done()),
      );
      socket.on("error", reject);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (status === 0) {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          status = Number(buffer.subarray(9, 12).toString());
          buffer = buffer.subarray(end + 4);
          resolve({
            status,
            received: () => buffer,
            send: (data) => socket.write(data),
            closed,
          });
        }
      });
      const lines = [
        `GET ${path} HTTP/1.1`,
        `host: ${HOST}`,
        "connection: Upgrade",
        "upgrade: websocket",
        "sec-websocket-version: 13",
        "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==",
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
  }

  test("no login is 401, a foreign or missing Origin is 403, and the API sees none of them", async () => {
    expect((await upgrade({ origin: ORIGIN })).status).toBe(401);
    const cookie = await loginCookie();
    expect((await upgrade({ cookie })).status).toBe(403);
    expect(
      (await upgrade({ cookie, origin: "http://gui.test:3001" })).status,
    ).toBe(403);
    expect(seen.filter((s) => s.method === "UPGRADE")).toEqual([]);
  });

  test("the pty upgrade (§12.5, a separate path from /ws) is routed and authorized the same way", async () => {
    const cookie = await loginCookie();
    const ws = await upgrade(
      { cookie, origin: ORIGIN },
      4,
      "/ws/pty?sessionId=s1&lease=t1",
    );
    expect(ws.status).toBe(101);
    const up = seen.find((s) => s.method === "UPGRADE");
    expect(up?.url).toBe("/ws/pty?sessionId=s1&lease=t1");
    expect(up?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("a logged-in upgrade reaches the API with the bearer; logout closes it with 4401", async () => {
    const cookie = await loginCookie();
    const ws = await upgrade({ cookie, origin: ORIGIN });
    expect(ws.status).toBe(101);
    const up = seen.find((s) => s.method === "UPGRADE");
    expect(up?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(up?.headers.cookie).toBeUndefined();
    ws.send("ping");
    await expect.poll(() => ws.received().toString()).toContain("ping");
    await call("/auth/logout", { method: "POST", headers: { ...OWN, cookie } });
    await ws.closed;
    const frame = ws.received();
    const at = frame.lastIndexOf(0x88);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(frame.readUInt16BE(at + 2)).toBe(4401);
  });
});

describe("loadEdgeConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "frm-edge-config-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function put(name: string, value: string): void {
    const path = join(dir, name);
    writeFileSync(path, `${value}\n`);
    chmodSync(path, 0o440);
  }

  const env = (extra: Readonly<Record<string, string>> = {}) => ({
    FRM_SECRET_STORE: "file",
    FRM_SECRETS_DIR: dir,
    FRM_WEB_ORIGINS: ORIGIN,
    ...extra,
  });

  test("reads both secrets from files and the origins exactly", async () => {
    put("FRM_API_TOKEN", TOKEN);
    put("FRM_WEB_PASSWORD_HASH", await hashPassword(PASSWORD, { logN: 14 }));
    const loaded = loadEdgeConfig(env(), staticDir);
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect([...loaded.value.config.origins]).toEqual([ORIGIN]);
    expect(loaded.value.config.apiTarget.href).toBe("http://api:3010/");
    expect(loaded.value.listen).toEqual({ host: "0.0.0.0", port: 5173 });
  });

  test.each([
    ["the Keychain mode", { FRM_SECRET_STORE: "keychain" }],
    ["no origins", { FRM_WEB_ORIGINS: "" }],
    ["a token in the environment", { FRM_API_TOKEN: TOKEN }],
    ["a hash in the environment", { FRM_WEB_PASSWORD_HASH: "x" }],
  ])("refuses %s, never echoing a secret", async (_name, extra) => {
    put("FRM_API_TOKEN", TOKEN);
    put("FRM_WEB_PASSWORD_HASH", await hashPassword(PASSWORD, { logN: 14 }));
    const loaded = loadEdgeConfig(env(extra), staticDir);
    expect(loaded).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(JSON.stringify(loaded)).not.toContain(TOKEN);
  });

  test("a missing or malformed hash is refused", () => {
    put("FRM_API_TOKEN", TOKEN);
    expect(loadEdgeConfig(env(), staticDir).ok).toBe(false);
    put("FRM_WEB_PASSWORD_HASH", "plain-text-password-not-a-hash");
    expect(loadEdgeConfig(env(), staticDir).ok).toBe(false);
  });
});
