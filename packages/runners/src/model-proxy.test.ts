// The context proxy against a stand-in upstream (spec M12): who may call it, what it
// forwards and strips, SSE passing through unbuffered, every fail-open path counted, the store it
// cannot be talked out of, and a log that never sees a credential or a body.
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  CONTEXT_RULESET,
  CONTEXT_STORE_DIR,
  parseContextFrame,
  type ContextFrame,
} from "@bayon/core";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import type { ContextTransform } from "./context-rewrite.js";
import { startFakeUpstream, type FakeUpstream } from "./fake-upstream.js";
import {
  MAX_CONNECTIONS,
  PROXY_HEADER,
  startModelProxy,
  targetOf,
  upstreamProblem,
  type ModelProxy,
  type ModelProxyOptions,
  type ProxyEvent,
} from "./model-proxy.js";

/** A toy wire format: `{ blocks: string[] }`, every string a tool result. */
const TOY: ContextTransform = {
  route: (method, path) =>
    method === "POST" && path === "/v1/messages"
      ? "compress"
      : method === "POST" && path === "/v1/count"
        ? "quiet"
        : path.startsWith("/v1/")
          ? "pass"
          : undefined,
  mayHold: (raw) => raw.includes('"blocks"'),
  rewrite(body, replace) {
    const b = body as { readonly blocks?: unknown };
    if (!Array.isArray(b.blocks)) return body;
    return {
      ...b,
      blocks: b.blocks.map((x: unknown) =>
        typeof x === "string" ? replace(x) : x,
      ),
    };
  },
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-proxy-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TOKEN = randomBytes(32).toString("hex");
const KEY = "sk-test-proxy-credential-0123456789";
const BEARER = "Bearer oauth-test-credential-0123456789";

/** 400 similar lines around one error: over the cap, and the rules fold it to a few lines. */
const bigLog = (tag = "x"): string =>
  [
    ...Array.from(
      { length: 200 },
      (_, i) => `INFO ${tag} request ${i} handled in 5 ms`,
    ),
    `ERROR ${tag} E-4711 the cache failed`,
    ...Array.from(
      { length: 200 },
      (_, i) => `INFO ${tag} request ${i + 200} handled in 5 ms`,
    ),
  ].join("\n");

let n = 0;
/**
 * A session as the supervisor lays one out: a root holding its worktree (the only root it writes
 * here) and, beside it, the store of originals.
 */
function session(): {
  readonly root: string;
  readonly work: string;
  readonly store: {
    readonly storeDir: string;
    readonly writable: readonly string[];
  };
} {
  const dir = join(root, `s${++n}`);
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  return {
    root: dir,
    work,
    store: { storeDir: join(dir, CONTEXT_STORE_DIR), writable: [work] },
  };
}

interface Rig {
  readonly proxy: ModelProxy;
  readonly upstream: FakeUpstream;
  readonly frames: ContextFrame[];
  readonly logged: string[];
  /** The session root, and its worktree. */
  readonly root: string;
  readonly work: string;
  readonly storeDir: string;
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function rig(
  o: Partial<ModelProxyOptions> & {
    readonly handler?: Parameters<typeof startFakeUpstream>[0];
    readonly upstreamPath?: string;
  } = {},
): Promise<Rig> {
  const upstream = await startFakeUpstream(o.handler);
  open.push(() => upstream.close());
  const frames: ContextFrame[] = [];
  const logged: string[] = [];
  const s = session();
  const started = await startModelProxy({
    upstream: `${upstream.url}${o.upstreamPath ?? ""}`,
    token: TOKEN,
    transform: TOY,
    onFrame: (f) => frames.push(f),
    ...s.store,
    log: (event: ProxyEvent, detail?: string) =>
      logged.push(`${event} ${detail ?? ""}`),
    ...o,
  });
  if (!started.ok) throw new Error(started.error.message);
  open.push(() => started.value.close());
  return {
    proxy: started.value,
    upstream,
    frames,
    logged,
    root: s.root,
    work: s.work,
    storeDir: s.store.storeDir,
  };
}

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

function call(
  proxy: ModelProxy,
  o: {
    readonly method?: string;
    readonly path?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string | Buffer;
    readonly token?: string | null;
  } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    // Options, not a URL string: a URL would normalise `..` and `//` away before they are sent.
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxy.port,
        path: o.path ?? "/v1/messages",
        method: o.method ?? "POST",
        headers: {
          "content-type": "application/json",
          ...(o.token === null ? {} : { [PROXY_HEADER]: o.token ?? TOKEN }),
          ...o.headers,
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(o.body);
  });
}

const blocks = (...texts: string[]): string =>
  JSON.stringify({ model: "m", blocks: texts });
const sha = (t: string): string =>
  createHash("sha256").update(t, "utf8").digest("hex");

describe("who may call it", () => {
  test("no bearer, or a wrong one, is 401 and nothing reaches the upstream", async () => {
    const r = await rig();
    const none = await call(r.proxy, { token: null, body: blocks(bigLog()) });
    const wrong = await call(r.proxy, {
      token: randomBytes(32).toString("hex"),
      body: blocks(bigLog()),
    });
    const short = await call(r.proxy, { token: "x", body: blocks("a") });
    expect([none.status, wrong.status, short.status]).toEqual([401, 401, 401]);
    expect(r.upstream.requests).toEqual([]);
    expect(r.frames).toEqual([]);
    expect(existsSync(r.storeDir)).toBe(false);
  });

  test("a route the transform does not name, or any target that is not a plain path, is 404", async () => {
    const r = await rig();
    for (const path of [
      "/other",
      "//evil.example/v1/messages",
      "/v1/../v1/messages",
      "/v1/%2e%2e/secrets",
      "/v1/%252e%252e/secrets",
      "/v1/a%252Fb",
      "/v1/a%25255cb",
      "/v1/a%2Fb",
      "/v1/a\\b",
      "http://evil.example/v1/messages",
    ]) {
      const a = await call(r.proxy, { method: "GET", path });
      expect(a.status, path).toBe(404);
    }
    expect(r.upstream.requests).toEqual([]);
  });

  test("targets and upstreams, as the proxy judges them", () => {
    expect(targetOf("/v1/messages?beta=true")).toEqual({
      path: "/v1/messages",
      search: "?beta=true",
    });
    expect(targetOf(undefined)).toBeUndefined();
    expect(targetOf("/a/./b")).toBeUndefined();
    expect(targetOf("/a\u0001b")).toBeUndefined();
    expect(upstreamProblem("https://api.example/")).toBeNull();
    expect(upstreamProblem("nope")).toMatch(/not a URL/);
    expect(upstreamProblem("ftp://x/")).toMatch(/http or https/);
    expect(upstreamProblem("https://u:p@x/")).toMatch(/credentials/);
    expect(upstreamProblem("https://x/?a=1")).toMatch(/query/);
    expect(upstreamProblem("https://x/#f")).toMatch(/query or fragment/);
  });

  test("bad options are refused before anything listens", async () => {
    const s = session();
    const base = {
      upstream: "http://127.0.0.1:9",
      token: TOKEN,
      transform: TOY,
      onFrame: () => undefined,
      ...s.store,
    };
    const bad = await Promise.all([
      startModelProxy({ ...base, token: "short" }),
      startModelProxy({ ...base, upstream: "file:///etc" }),
      startModelProxy({ ...base, storeDir: join(root, "elsewhere") }),
      startModelProxy({ ...base, storeDir: "relative/.foreman/ctx" }),
      // Inside the worktree the session writes: it could swap the path under the proxy.
      startModelProxy({ ...base, storeDir: join(s.work, CONTEXT_STORE_DIR) }),
      // Holding it is no better.
      startModelProxy({ ...base, writable: [join(s.store.storeDir, "sub")] }),
    ]);
    expect(bad.map((b) => (b.ok ? "ok" : b.error.message))).toEqual([
      expect.stringMatching(/bearer/),
      expect.stringMatching(/http or https/),
      expect.stringMatching(/must end in \.foreman\/ctx/),
      expect.stringMatching(/absolute, normal/),
      expect.stringMatching(/inside a root the session writes/),
      expect.stringMatching(/inside a root the session writes/),
    ]);
  });

  test("a proxy that cannot listen fails the start, retryable", async () => {
    const taken = createServer();
    const port = await new Promise<number>((resolve) =>
      taken.listen(0, "127.0.0.1", () => {
        const a = taken.address();
        resolve(typeof a === "object" && a !== null ? a.port : 0);
      }),
    );
    try {
      const r = await startModelProxy({
        upstream: "http://127.0.0.1:9",
        token: TOKEN,
        transform: TOY,
        onFrame: () => undefined,
        port,
        ...session().store,
      });
      expect(r.ok ? "listening" : r.error).toMatchObject({
        class: "spawn_failed",
        retryable: true,
      });
    } finally {
      taken.close();
    }
  });
});

describe("what it forwards", () => {
  test("hop-by-hop headers and the bearer are stripped; auth arrives unchanged", async () => {
    const r = await rig();
    const a = await call(r.proxy, {
      body: blocks("small"),
      headers: {
        "x-api-key": KEY,
        authorization: BEARER,
        "x-provider-version": "2023-06-01",
        connection: "keep-alive, x-hop-named",
        "x-hop-named": "gone",
        "keep-alive": "timeout=5",
        te: "trailers",
        "proxy-authorization": "Basic gone",
      },
    });
    expect(a.status).toBe(200);
    const [got] = r.upstream.requests;
    expect(got?.headers["x-api-key"]).toBe(KEY);
    expect(got?.headers.authorization).toBe(BEARER);
    expect(got?.headers["x-provider-version"]).toBe("2023-06-01");
    for (const gone of [
      PROXY_HEADER,
      "x-hop-named",
      "keep-alive",
      "te",
      "proxy-authorization",
    ]) {
      expect(got?.headers, gone).not.toHaveProperty(gone);
    }
    expect(got?.headers.host).toBe(`127.0.0.1:${r.upstream.port}`);
  });

  test("the upstream's hop-by-hop headers, and those its Connection names, never reach the runner", async () => {
    const r = await rig({
      handler: (_req, _body, res) => {
        res.writeHead(200, {
          connection: "keep-alive, x-upstream-hop",
          "x-upstream-hop": "gone",
          "keep-alive": "timeout=5",
          "x-kept": "kept",
          "content-length": "0",
        });
        res.end();
      },
    });
    const a = await call(r.proxy, { body: blocks("x") });
    expect(a.headers["x-kept"]).toBe("kept");
    expect(a.headers).not.toHaveProperty("x-upstream-hop");
  });

  test("a runner gets a few connections, no more", async () => {
    const r = await rig();
    const sockets: Socket[] = [];
    const openOne = () =>
      new Promise<Socket>((resolve) => {
        const s = connect(r.proxy.port, "127.0.0.1", () => resolve(s));
        sockets.push(s);
      });
    try {
      for (let i = 0; i < MAX_CONNECTIONS; i += 1) await openOne();
      const extra = await openOne();
      // The server drops a connection past its cap at once.
      await new Promise<void>((resolve) =>
        extra.once("close", () => resolve()),
      );
      expect(sockets.slice(0, -1).every((s) => !s.destroyed)).toBe(true);
    } finally {
      for (const s of sockets) s.destroy();
    }
  });

  test("paths go under the upstream's own path, the query kept", async () => {
    const r = await rig({ upstreamPath: "/api/v1/" });
    await call(r.proxy, { path: "/v1/messages?beta=true", body: blocks("x") });
    expect(r.upstream.requests[0]?.url).toBe("/api/v1/v1/messages?beta=true");
  });

  test("a pass route streams untouched, a GET too", async () => {
    const r = await rig();
    const body = blocks(bigLog());
    await call(r.proxy, { path: "/v1/other", body });
    const got = await call(r.proxy, { method: "GET", path: "/v1/models" });
    expect(got.status).toBe(200);
    expect(r.upstream.requests[0]?.body.toString()).toBe(body);
    expect(r.upstream.requests[1]?.method).toBe("GET");
    expect(r.frames).toEqual([]);
  });

  test("an upstream that is down is a 502", async () => {
    const dead = await startFakeUpstream();
    await dead.close();
    const p = await startModelProxy({
      upstream: dead.url,
      token: TOKEN,
      transform: TOY,
      onFrame: () => undefined,
      ...session().store,
    });
    if (!p.ok) throw new Error(p.error.message);
    open.push(() => p.value.close());
    expect((await call(p.value, { body: blocks("x") })).status).toBe(502);
  });

  test("SSE comes back byte for byte, and each event as the upstream sends it", async () => {
    const events = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"héllo"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const firstSeen = Promise.withResolvers<undefined>();
    let upstreamEnded = false;
    const r = await rig({
      handler: (_req, _body, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(events[0]);
        // The rest waits until the client has the first event: a buffering proxy never delivers it.
        void firstSeen.promise.then(() => {
          res.write(events[1]);
          upstreamEnded = true;
          res.end(events[2]);
        });
      },
    });
    const chunks: Buffer[] = [];
    let endedAtFirst: boolean | undefined;
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        `${r.proxy.url}/v1/messages`,
        { method: "POST", headers: { [PROXY_HEADER]: TOKEN }, agent: false },
        (res) => {
          expect(res.headers["content-type"]).toBe("text/event-stream");
          res.on("data", (c: Buffer) => {
            if (endedAtFirst === undefined) {
              endedAtFirst = upstreamEnded;
              firstSeen.resolve(undefined);
            }
            chunks.push(c);
          });
          res.on("end", resolve);
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(blocks("tiny"));
    });
    expect(endedAtFirst).toBe(false);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(events.join(""));
  });

  test("a runner that goes away takes the upstream call with it", async () => {
    const upstreamClosed = Promise.withResolvers<undefined>();
    const r = await rig({
      handler: (_req, _body, res) => {
        res.on("close", () => upstreamClosed.resolve(undefined));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: ping\ndata: {}\n\n");
      },
    });
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        `${r.proxy.url}/v1/messages`,
        { method: "POST", headers: { [PROXY_HEADER]: TOKEN }, agent: false },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on("error", (e) => (req.destroyed ? undefined : reject(e)));
      req.end(blocks("tiny"));
    });
    await upstreamClosed.promise; // the test's deadline is the failure
  });
});

describe("compression", () => {
  test("a large block goes compressed, its original stored under its sha; one frame per call", async () => {
    const r = await rig();
    const log = bigLog();
    const body = blocks("small result", log);
    const a = await call(r.proxy, { body });
    expect(a.status).toBe(200);
    const sent = JSON.parse(r.upstream.requests[0]?.body.toString() ?? "") as {
      blocks: string[];
    };
    expect(sent.blocks[0]).toBe("small result");
    const path = join(r.storeDir, `${sha(log)}.txt`);
    expect(sent.blocks[1]).toContain("ERROR x E-4711 the cache failed");
    expect(sent.blocks[1]).toContain(`Original: ${path} —`);
    expect(sent.blocks[1]?.length).toBeLessThan(log.length);
    expect(readFileSync(path, "utf8")).toBe(log);
    expect(readdirSync(r.storeDir)).toEqual([`${sha(log)}.txt`]);
    expect(r.upstream.requests[0]?.headers["content-length"]).toBe(
      String(r.upstream.requests[0]?.body.length),
    );
    expect(r.frames).toHaveLength(1);
    const [f] = r.frames;
    expect(parseContextFrame(f).ok).toBe(true);
    expect(f).toMatchObject({
      type: "frm.ctx",
      v: 1,
      ruleset: CONTEXT_RULESET,
      blocks: 2,
      compressed: 1,
      failed: 0,
      chars_in: "small result".length + log.length,
      chars_out: "small result".length + (sent.blocks[1]?.length ?? 0),
      digests: [sha(log)],
    });
  });

  test("a re-sent block is sent as the same bytes; the quiet route rewrites without a frame", async () => {
    const r = await rig();
    const log = bigLog();
    await call(r.proxy, { body: blocks(log) });
    await call(r.proxy, { body: blocks(log, bigLog("y")) });
    await call(r.proxy, { path: "/v1/count", body: blocks(log) });
    const bodies = r.upstream.requests.map(
      (q) => (JSON.parse(q.body.toString()) as { blocks: string[] }).blocks,
    );
    expect(bodies[1]?.[0]).toBe(bodies[0]?.[0]);
    expect(bodies[2]?.[0]).toBe(bodies[0]?.[0]);
    expect(r.frames.map((f) => f.digests)).toEqual([
      [sha(log)],
      [sha(log), sha(bigLog("y"))],
    ]);
  });

  test("the log never sees a credential or a body", async () => {
    const r = await rig();
    const secret = "the-body-text-nobody-logs";
    await call(r.proxy, {
      token: null,
      headers: { "x-api-key": KEY, authorization: BEARER },
      body: blocks(secret),
    });
    // Unreadable (not re-serialisable), so a fail-open line is logged.
    await call(r.proxy, {
      headers: { "x-api-key": KEY, authorization: BEARER },
      body: `{ "blocks": [${JSON.stringify(`${secret}\n${bigLog()}`)}] }`,
    });
    await call(r.proxy, {
      path: "/nowhere",
      headers: { "x-api-key": KEY },
      body: blocks(secret),
    });
    expect(r.logged.length).toBeGreaterThan(0);
    const all = r.logged.join("\n");
    for (const s of [KEY, BEARER, TOKEN, secret, "INFO", "blocks"]) {
      expect(all).not.toContain(s);
    }
  });
});

describe("fail open, counted", () => {
  test("a body that does not re-serialise byte for byte goes untouched, each large block failed", async () => {
    const r = await rig();
    const log = bigLog();
    const body = `{"blocks": [${JSON.stringify(log)}, "small"]}`;
    await call(r.proxy, { body });
    expect(r.upstream.requests[0]?.body.toString()).toBe(body);
    expect(r.frames[0]).toMatchObject({ blocks: 2, compressed: 0, failed: 1 });
    expect(r.logged).toContain("untouched not_reproducible");
  });

  test("a gzip body goes untouched, one block failed", async () => {
    const r = await rig();
    const raw = gzipSync(blocks(bigLog()));
    await call(r.proxy, { body: raw, headers: { "content-encoding": "gzip" } });
    expect(r.upstream.requests[0]?.body.equals(raw)).toBe(true);
    expect(r.upstream.requests[0]?.headers["content-encoding"]).toBe("gzip");
    expect(r.frames[0]).toMatchObject({ blocks: 1, compressed: 0, failed: 1 });
  });

  test("bytes that are not UTF-8, or not JSON, go untouched, one block failed", async () => {
    const r = await rig();
    const bad = Buffer.concat([
      Buffer.from('{"blocks":["'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"]}'),
    ]);
    await call(r.proxy, { body: bad });
    await call(r.proxy, { body: '{"blocks": [' });
    expect(r.upstream.requests[0]?.body.equals(bad)).toBe(true);
    expect(r.upstream.requests[1]?.body.toString()).toBe('{"blocks": [');
    expect(r.frames.map((f) => [f.blocks, f.failed])).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });

  test("a transform that throws leaves the body untouched, one block failed", async () => {
    const r = await rig({
      transform: {
        ...TOY,
        rewrite: () => {
          throw new Error("boom");
        },
      },
    });
    const body = blocks(bigLog());
    await call(r.proxy, { body });
    expect(r.upstream.requests[0]?.body.toString()).toBe(body);
    expect(r.frames[0]).toMatchObject({ blocks: 1, failed: 1 });
  });

  test("a store that cannot be written sends the original, the block failed, and stays so", async () => {
    const r = await rig();
    // `.foreman` is a file: no store can be made under it.
    writeFileSync(join(r.root, ".foreman"), "not a directory");
    const log = bigLog();
    await call(r.proxy, { body: blocks(log) });
    rmSync(join(r.root, ".foreman"));
    await call(r.proxy, { body: blocks(log) });
    const sent = r.upstream.requests.map((q) => q.body.toString());
    expect(sent).toEqual([blocks(log), blocks(log)]);
    expect(r.frames.map((f) => [f.compressed, f.failed])).toEqual([
      [0, 1],
      [0, 1],
    ]);
    expect(r.logged.some((l) => l.startsWith("block_failed"))).toBe(true);
  });

  test("a symlink the session plants where the store once was redirects nothing", async () => {
    const r = await rig();
    const outside = join(root, `outside${++n}`);
    mkdirSync(outside);
    // The worktree is the session's: it may plant `.foreman/ctx` there, pointing anywhere.
    mkdirSync(join(r.work, ".foreman"));
    symlinkSync(outside, join(r.work, CONTEXT_STORE_DIR));
    const log = bigLog();
    await call(r.proxy, { body: blocks(log) });
    expect(r.frames[0]).toMatchObject({ compressed: 1, failed: 0 });
    // The original went to the store beside the worktree, outside every root the session writes.
    expect(readdirSync(r.storeDir)).toEqual([`${sha(log)}.txt`]);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("a store directory that is a symlink is refused: nothing is written through it", async () => {
    const r = await rig();
    const outside = join(root, `outside${++n}`);
    mkdirSync(outside);
    mkdirSync(join(r.root, ".foreman"));
    symlinkSync(outside, r.storeDir);
    const log = bigLog();
    await call(r.proxy, { body: blocks(log) });
    expect(r.upstream.requests[0]?.body.toString()).toBe(blocks(log));
    expect(r.frames[0]).toMatchObject({ compressed: 0, failed: 1 });
    expect(readdirSync(outside)).toEqual([]);
  });

  test("a body over the cap streams on untouched, one block failed", async () => {
    const r = await rig({ maxBodyBytes: 1024 });
    const body = blocks(bigLog());
    await call(r.proxy, { body });
    expect(r.upstream.requests[0]?.body.toString()).toBe(body);
    expect(r.frames[0]).toMatchObject({ blocks: 1, failed: 1 });
  });
});
