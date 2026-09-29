// The context proxy through this adapter (spec M12), with the real SDK, the stub CLI and
// the real local executor, an echo upstream standing in for the API: where the proxy's URL and bearer
// go (the URL pinned in the inline settings and the env, the bearer in the env only), frames folded
// into the run's terminal, the proxy gone with the process, an adopt behind a new proxy sending the
// same bytes, and a session without compression exactly as before.
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTEXT_RULESET, CONTEXT_STORE_DIR } from "@bayon/core";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type {
  MappedEvent,
  RawRecord,
  SessionHandle,
  SpawnSpec,
} from "../../adapter.js";
import {
  CTX_JSON_FILE,
  CTX_LOG_FILE,
  contextJson,
  contextLog,
} from "../../conformance/tests/t17-compression.js";
import {
  echoUnder,
  startFakeUpstream,
  type FakeUpstream,
} from "../../fake-upstream.js";
import { createClaudeSdkAdapter } from "./adapter.js";
import { DEFAULT_BASE_URL, pinnedEnv } from "./pinned-env.js";
import { DEFAULTS, MODELS } from "./registration.js";

const STUB = fileURLToPath(new URL("./testing/stub-cli.mjs", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-sdk-ctx-")));
const local = new LocalExecutor({ id: "local", slots: new SlotCounter(16) });
const logged: string[] = [];
const adapter = createClaudeSdkAdapter({
  pathToExecutable: STUB,
  executable: "node",
  contextLog: (event, detail) => logged.push(`${event} ${detail ?? ""}`),
});

let upstream: FakeUpstream;
beforeAll(async () => {
  upstream = await startFakeUpstream();
});
afterAll(async () => {
  await upstream.close();
  rmSync(root, { recursive: true, force: true });
});

/** Real processes run on real time: a deadline, never a sleep. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`deadline: ${what}`)),
          20_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const token = () => randomBytes(32).toString("hex");
const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

let n = 0;
function spec(
  o: { readonly on?: boolean; readonly env?: Record<string, string> } = {},
): SpawnSpec {
  const base = join(root, `s${++n}`);
  const cwd = join(base, "work");
  const homeDir = join(base, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  return {
    sessionId: `01CTX${n}`,
    cwd,
    homeDir,
    env: {
      PATH: process.env["PATH"] ?? "",
      ANTHROPIC_BASE_URL: upstream.url,
      ...o.env,
    },
    model: "claude-haiku-4-5",
    flags: { ...DEFAULTS },
    ...(o.on === false
      ? {}
      : {
          contextCompression: {
            ruleset: CONTEXT_RULESET,
            // Beside the worktree, in the session root: outside every root the session writes.
            storeDir: join(base, CONTEXT_STORE_DIR),
            token: token(),
          },
        }),
  };
}

const homeJson = (s: SpawnSpec, file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(s.homeDir, file), "utf8")) as Record<
    string,
    unknown
  >;
const argvOf = (s: SpawnSpec): string[] =>
  JSON.parse(readFileSync(join(s.homeDir, "argv.json"), "utf8")) as string[];
const inlineSettingsEnv = (s: SpawnSpec): Record<string, unknown> => {
  const argv = argvOf(s);
  return (
    JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "{}") as {
      env: Record<string, unknown>;
    }
  ).env;
};

async function spawned(
  s: SpawnSpec,
  how: "spawn" | "adopt" = "spawn",
): Promise<SessionHandle> {
  const r = await within(adapter[how](s, local), how);
  if (!r.ok) throw new Error(`${how} failed: ${r.error.message}`);
  return r.value;
}

/** One run through the records, mapped: its events, up to its terminal. */
async function oneRun(
  h: SessionHandle,
  records: AsyncIterator<RawRecord>,
): Promise<MappedEvent[]> {
  expect(
    (await adapter.send(h, { runId: "r", text: "go", promptPath: "/p.md" })).ok,
  ).toBe(true);
  const mapper = adapter.createMapper({ prices: MODELS });
  const out: MappedEvent[] = [];
  for (let offset = 0; ;) {
    const next = await within(records.next(), "the next record");
    if (next.done === true) return out;
    const events = mapper.map({ offset, bytes: next.value.bytes, ts: 1 });
    offset += next.value.bytes.length + 1;
    out.push(...events);
    if (events.some((e) => e.kind === "terminal")) return out;
  }
}

/** Whether anything listens on 127.0.0.1:`port` (a refused connection is no). */
const listening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/", method: "GET" },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on("error", () => resolve(false));
    req.end();
  });

const proxyPortOf = (s: SpawnSpec): number =>
  Number(new URL(String(inlineSettingsEnv(s)["ANTHROPIC_BASE_URL"])).port);

describe("claude-sdk behind the context proxy", { timeout: 60_000 }, () => {
  test("the proxy's URL is pinned inline and in the env, its bearer only in the env; frames fold", async () => {
    const s = spec();
    const bearer = s.contextCompression?.token ?? "";
    const h = await spawned(s);
    const records = adapter.records(h)[Symbol.asyncIterator]();
    const events = await oneRun(h, records);
    const inline = inlineSettingsEnv(s);
    const url = String(inline["ANTHROPIC_BASE_URL"]);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(url).not.toBe(upstream.url);
    // The CLI's effective env (--settings over the process env) names the proxy too.
    expect(homeJson(s, "settings-env.json")["ANTHROPIC_BASE_URL"]).toBe(url);
    expect(inline).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
    expect(JSON.stringify(argvOf(s))).not.toContain(bearer);
    // The store of originals is granted to the CLI's own tools, so Read and Grep open it.
    const argv = argvOf(s);
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe(
      s.contextCompression?.storeDir,
    );
    expect(homeJson(s, "auth.json")["ANTHROPIC_CUSTOM_HEADERS"]).toBe(
      sha256(`x-frm-proxy: ${bearer}`),
    );
    // The call went through: upstream, without the bearer; the frame folded into the terminal.
    const calls = upstream.requests.filter(
      (r) => r.url === "/v1/messages?beta=true",
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((r) => r.headers["x-frm-proxy"] === undefined)).toBe(
      true,
    );
    expect(
      readFileSync(join(s.homeDir, "model-calls.jsonl"), "utf8"),
    ).toContain('"status":200');
    const terminal = events.find((e) => e.kind === "terminal");
    expect(terminal?.payload["context"]).toMatchObject({
      ruleset: CONTEXT_RULESET,
      calls: 1,
    });
    expect(
      events.some(
        (e) => e.kind === "runner_native" && e.runner_type === "frm.ctx",
      ),
    ).toBe(false);
    const port = proxyPortOf(s);
    expect(await listening(port)).toBe(true);
    await within(adapter.stop(h, "graceful"), "stop");
    expect(await listening(port)).toBe(false);
  });

  test("an operator base URL with a path keeps it: the proxy forwards under it", async () => {
    // A gateway that answers nothing outside its own path, as a real one does.
    const gateway = await startFakeUpstream(echoUnder("/gateway"));
    try {
      const s = spec({ env: { ANTHROPIC_BASE_URL: `${gateway.url}/gateway` } });
      const h = await spawned(s);
      const events = await oneRun(
        h,
        adapter.records(h)[Symbol.asyncIterator](),
      );
      await within(adapter.stop(h, "graceful"), "stop");
      expect(gateway.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /gateway/v1/messages?beta=true",
      ]);
      expect(readFileSync(join(s.homeDir, "model-calls.jsonl"), "utf8")).toBe(
        '{"status":200}\n',
      );
      expect(events.find((e) => e.kind === "terminal")?.payload).toMatchObject({
        outcome: "ok",
        context: { calls: 1 },
      });
    } finally {
      await gateway.close();
    }
  });

  test("a kill closes the proxy too", async () => {
    const s = spec();
    const h = await spawned(s);
    const port = proxyPortOf(s);
    expect(await listening(port)).toBe(true);
    await within(adapter.stop(h, "kill"), "kill");
    expect(await listening(port)).toBe(false);
  });

  test("an adopt behind a new proxy and bearer sends the same compressed bytes", async () => {
    const s = spec({ env: {} });
    writeFileSync(join(s.cwd, CTX_LOG_FILE), contextLog("E-31337", "fedcba"));
    writeFileSync(join(s.cwd, CTX_JSON_FILE), contextJson("TAG-fedcba"));
    const files = JSON.stringify({ log: CTX_LOG_FILE, json: CTX_JSON_FILE });
    const ctx = { ...s, env: { ...s.env, FRM_STUB_CTX: files } };
    const bodies = async (spawnSpec: SpawnSpec, how: "spawn" | "adopt") => {
      const before = upstream.requests.length;
      const h = await spawned(spawnSpec, how);
      const events = await oneRun(
        h,
        adapter.records(h)[Symbol.asyncIterator](),
      );
      await within(adapter.stop(h, "graceful"), "stop");
      return {
        port: proxyPortOf(spawnSpec),
        events,
        sent: upstream.requests.slice(before).map((r) => r.body.toString()),
        runner: h.runnerSessionId ?? "",
      };
    };
    const first = await bodies(ctx, "spawn");
    const second = await bodies(
      {
        ...ctx,
        resumeRunnerSessionId: first.runner,
        contextCompression: {
          ruleset: CONTEXT_RULESET,
          storeDir: s.contextCompression?.storeDir ?? "",
          token: token(),
        },
      },
      "adopt",
    );
    expect(second.port).not.toBe(first.port);
    expect(first.sent).toHaveLength(2);
    expect(second.sent).toEqual(first.sent);
    expect(first.sent[0]).toContain("[frm-ctx ctx1]");
    const answer = first.events.find((e) => e.kind === "assistant_text");
    expect(answer?.kind === "assistant_text" ? answer.text : "").toBe(
      "E-31337 TAG-fedcba",
    );
    // Two originals, each under its own sha.
    const store = s.contextCompression?.storeDir ?? "";
    const stored = readdirSync(store).toSorted();
    expect(stored).toHaveLength(2);
    for (const name of stored) {
      const text = readFileSync(join(store, name), "utf8");
      expect(name).toBe(`${sha256(text)}.txt`);
    }
    // Only the other tests' bearer-less probes were logged: nothing here failed open.
    expect(logged.filter((l) => !l.startsWith("unauthorized"))).toEqual([]);
  });

  test("without compression nothing changes: no proxy, the inline env exactly the pins", async () => {
    const s = spec({ on: false });
    const h = await spawned(s);
    await oneRun(h, adapter.records(h)[Symbol.asyncIterator]());
    const pins = pinnedEnv(s.env);
    expect(pins.ok && inlineSettingsEnv(s)).toEqual(
      pins.ok ? pins.value : null,
    );
    expect(inlineSettingsEnv(s)["ANTHROPIC_BASE_URL"]).toBe(upstream.url);
    expect(homeJson(s, "auth.json")).not.toHaveProperty(
      "ANTHROPIC_CUSTOM_HEADERS",
    );
    expect(existsSync(join(s.homeDir, "model-calls.jsonl"))).toBe(false);
    expect(argvOf(s)).not.toContain("--add-dir");
    await within(adapter.stop(h, "graceful"), "stop");
    const bare = spec({ on: false, env: { ANTHROPIC_BASE_URL: "" } });
    const h2 = await spawned({
      ...bare,
      env: { PATH: bare.env["PATH"] ?? "" },
    });
    expect(inlineSettingsEnv(bare)["ANTHROPIC_BASE_URL"]).toBe(
      DEFAULT_BASE_URL,
    );
    await within(adapter.stop(h2, "graceful"), "stop");
  });

  test("refused before anything starts: an egress proxy, a profile's inline headers, a container", async () => {
    const proxied = await adapter.spawn(
      spec({ env: { HTTPS_PROXY: "http://proxy.invalid:3128" } }),
      local,
    );
    expect(proxied.ok ? "spawned" : proxied.error.message).toMatch(
      /egress proxy/,
    );
    const headers = spec();
    const inline = await adapter.spawn(
      {
        ...headers,
        flags: {
          ...DEFAULTS,
          settings: { env: { ANTHROPIC_CUSTOM_HEADERS: "x-a: b" } },
        },
      },
      local,
    );
    expect(inline.ok ? "spawned" : inline.error.message).toMatch(
      /inline ANTHROPIC_CUSTOM_HEADERS/,
    );
    expect(adapter.compressesContext?.({ kind: "container" })).toBe(false);
    expect(adapter.compressesContext?.({ kind: "local" })).toBe(true);
    // Neither refusal left a stub process behind: nothing wrote its argv.
    expect(existsSync(join(headers.homeDir, "argv.json"))).toBe(false);
  });

  test("a takeover is never compressed: its argv and env name no proxy", async () => {
    const s = spec();
    const r = await adapter.interactiveResume(
      s,
      "00000000-0000-4000-8000-000000000000",
      local,
    );
    if (!r.ok) throw new Error(r.error.message);
    const settings = JSON.parse(
      r.value.argv[r.value.argv.indexOf("--settings") + 1] ?? "{}",
    ) as {
      env: Record<string, unknown>;
    };
    expect(settings.env["ANTHROPIC_BASE_URL"]).toBe(upstream.url);
    expect(r.value.env["ANTHROPIC_CUSTOM_HEADERS"]).toBeUndefined();
    expect(JSON.stringify(r.value)).not.toContain(
      s.contextCompression?.token ?? "none",
    );
  });
});
