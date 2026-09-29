// The context proxy's one answer without the bearer, and its debug trace: a HEAD to a
// path the transform names as the runner's warm-up is answered here, empty, and never forwarded;
// every other request still needs the bearer. The trace names method and path, never a header, a
// body, the bearer or the query.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_STORE_DIR } from "@bayon/core";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import type { ContextTransform } from "./context-rewrite.js";
import { startFakeUpstream, type FakeUpstream } from "./fake-upstream.js";
import {
  PROXY_HEADER,
  TRACE_PATH_CHARS,
  startModelProxy,
  type ModelProxy,
} from "./model-proxy.js";

const WARMUP = "/v1/warmup";
const TOY: ContextTransform = {
  probes: [WARMUP],
  route: (_method, path) => (path.startsWith("/v1/") ? "pass" : undefined),
  mayHold: () => false,
  rewrite: (body) => body,
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-proxy-probe-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const TOKEN = randomBytes(32).toString("hex");
const KEY = "sk-test-probe-credential-0123456789";

interface Rig {
  readonly proxy: ModelProxy;
  readonly upstream: FakeUpstream;
  readonly logged: string[];
  readonly traced: string[];
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

let n = 0;
async function rig(transform: ContextTransform = TOY): Promise<Rig> {
  const upstream = await startFakeUpstream();
  open.push(() => upstream.close());
  const dir = join(root, `s${++n}`);
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  const logged: string[] = [];
  const traced: string[] = [];
  const started = await startModelProxy({
    upstream: upstream.url,
    token: TOKEN,
    transform,
    onFrame: () => undefined,
    storeDir: join(dir, CONTEXT_STORE_DIR),
    writable: [work],
    log: (event, detail) => logged.push(`${event} ${detail ?? ""}`.trim()),
    trace: (line) => traced.push(line),
  });
  if (!started.ok) throw new Error(started.error.message);
  open.push(() => started.value.close());
  return { proxy: started.value, upstream, logged, traced };
}

function call(
  proxy: ModelProxy,
  o: {
    readonly method: string;
    readonly path: string;
    readonly bearer?: boolean;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxy.port,
        path: o.path,
        method: o.method,
        headers: {
          ...(o.bearer === true ? { [PROXY_HEADER]: TOKEN } : {}),
          ...o.headers,
        },
        agent: false,
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(o.body);
  });
}

describe("a probe", () => {
  test("a HEAD to a probe path is answered here, empty, without the bearer; nothing is forwarded or warned", async () => {
    const r = await rig();
    const bare = await call(r.proxy, { method: "HEAD", path: WARMUP });
    // With a query, or a credential it has no business sending: the same, and it goes nowhere.
    const odd = await call(r.proxy, {
      method: "HEAD",
      path: `${WARMUP}?q=secret-query`,
      headers: { "x-api-key": KEY },
    });
    expect([bare, odd]).toEqual([
      { status: 200, body: "" },
      { status: 200, body: "" },
    ]);
    expect(r.upstream.requests).toEqual([]);
    expect(r.logged).toEqual([]);
    expect(r.traced).toEqual([`probe HEAD ${WARMUP}`, `probe HEAD ${WARMUP}`]);
  });

  test("any other method on a probe path, or a HEAD elsewhere, still needs the bearer", async () => {
    const r = await rig();
    const answers = [
      await call(r.proxy, { method: "GET", path: WARMUP }),
      await call(r.proxy, { method: "POST", path: WARMUP, body: "{}" }),
      await call(r.proxy, { method: "HEAD", path: "/v1/messages" }),
      await call(r.proxy, { method: "HEAD", path: `${WARMUP}/more` }),
      await call(r.proxy, { method: "HEAD", path: `${WARMUP}/` }),
    ];
    expect(answers.map((a) => a.status)).toEqual([401, 401, 401, 401, 401]);
    expect(r.upstream.requests).toEqual([]);
    expect(r.logged).toEqual(Array(5).fill("unauthorized"));
    // With the bearer, a GET there is an ordinary route: forwarded.
    const ok = await call(r.proxy, {
      method: "GET",
      path: WARMUP,
      bearer: true,
    });
    expect(ok.status).toBe(200);
    expect(r.upstream.requests.map((q) => `${q.method} ${q.url}`)).toEqual([
      `GET ${WARMUP}`,
    ]);
  });

  test("a transform that names no probe answers none: the HEAD is 401", async () => {
    const r = await rig({ ...TOY, probes: undefined });
    const a = await call(r.proxy, { method: "HEAD", path: WARMUP });
    expect(a.status).toBe(401);
    expect(r.logged).toEqual(["unauthorized"]);
  });
});

describe("the trace", () => {
  test("each answer, method and path; never a header, the bearer, a body or the query", async () => {
    const r = await rig();
    const secret = "BODY-SECRET-0123456789";
    await call(r.proxy, {
      method: "POST",
      path: "/v1/messages?beta=QUERY-SECRET",
      bearer: true,
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    });
    await call(r.proxy, {
      method: "POST",
      path: "/v1/messages?beta=QUERY-SECRET",
      headers: { authorization: `Bearer ${KEY}` },
      body: secret,
    });
    await call(r.proxy, { method: "GET", path: "/other", bearer: true });
    await call(r.proxy, { method: "GET", path: "/v1/a%2Fb", bearer: true });
    await call(r.proxy, {
      method: "GET",
      path: `/v1/${"x".repeat(TRACE_PATH_CHARS * 2)}`,
      bearer: true,
    });
    expect(r.traced).toEqual([
      "forward POST /v1/messages",
      "401 POST /v1/messages",
      "404 GET /other",
      "404 GET <unsafe target>",
      `forward GET ${`/v1/${"x".repeat(TRACE_PATH_CHARS * 2)}`.slice(0, TRACE_PATH_CHARS)}…`,
    ]);
    const all = r.traced.join("\n");
    for (const s of [KEY, TOKEN, secret, "QUERY-SECRET", "%2F"]) {
      expect(all).not.toContain(s);
    }
  });
});
