// The context proxy through this adapter (spec M12), on the stand-in through the real
// turn host and the real local executor, (on macOS) inside the real Seatbelt profile, with an echo
// upstream as the provider: opencode's provider points at the proxy with an {env:} header, the
// bearer is in its env and nowhere in its config or argv, the profile opens the proxy's port and
// not the provider's, frames fold into the run's terminal, and the proxy goes with the host.
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  echoUnder,
  startFakeUpstream,
  type FakeUpstream,
} from "../../fake-upstream.js";
import { createOpencodeAdapter } from "./adapter.js";
import { DEFAULTS, MODELS } from "./registration.js";
import { confinement } from "./confine.js";
import { ProviderBlock } from "./home.js";
import { seatbeltProfile } from "./sandbox.js";
import { STUB_OPENCODE } from "./testing/stub.js";

const executor = new LocalExecutor({ id: "local", slots: new SlotCounter(8) });
const adapter = createOpencodeAdapter({
  bin: [process.execPath, STUB_OPENCODE],
  graceMs: 300,
  contextLog: () => undefined,
  ...(process.platform === "darwin" ? {} : { unsandboxed: true }),
});
const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-oc-ctx-")));

let upstream: FakeUpstream;
beforeAll(async () => {
  upstream = await startFakeUpstream();
});
afterAll(async () => {
  await upstream.close();
  rmSync(root, { recursive: true, force: true });
});

function within<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out: ${what}`)), 15_000).unref();
    }),
  ]);
}

let n = 0;
function specOf(on = true): SpawnSpec {
  const base = join(root, `s${++n}`);
  const cwd = join(base, "work");
  mkdirSync(cwd, { recursive: true });
  return {
    sessionId: `01OCCTX${n}`,
    cwd,
    homeDir: join(base, "home"),
    env: {
      PATH: process.env["PATH"] ?? "",
      OLLAMA_BASE_URL: `${upstream.url}/v1`,
    },
    model: "ollama/gemma4:26b",
    flags: { ...DEFAULTS },
    ...(on
      ? {
          contextCompression: {
            ruleset: CONTEXT_RULESET,
            // Beside the worktree, in the session root: outside every root the session writes.
            storeDir: join(base, CONTEXT_STORE_DIR),
            token: randomBytes(32).toString("hex"),
          },
        }
      : {}),
  };
}

const stubFile = (s: SpawnSpec, file: string): string =>
  readFileSync(join(s.homeDir, "xdg/data/opencode/stub", file), "utf8");

async function spawned(s: SpawnSpec): Promise<SessionHandle> {
  const home = await adapter.prepareHome(s, executor);
  if (!home.ok) throw new Error(home.error.message);
  const h = await within(adapter.spawn(s, executor), "spawn");
  if (!h.ok) throw new Error(h.error.message);
  return h.value;
}

async function oneRun(
  h: SessionHandle,
  records: AsyncIterator<RawRecord>,
): Promise<MappedEvent[]> {
  const mapper = adapter.createMapper({ prices: MODELS });
  expect(
    (
      await adapter.send(h, {
        runId: "run-1",
        text: "Reply with the single word OK.",
        promptPath: "/p",
      })
    ).ok,
  ).toBe(true);
  const out: MappedEvent[] = [];
  for (let offset = 0; ;) {
    const next = await within(records.next(), "a record");
    if (next.done === true) return out;
    const events = mapper.map({ offset, bytes: next.value.bytes, ts: 1 });
    offset += next.value.bytes.length + 1;
    out.push(...events);
    if (events.some((e) => e.kind === "terminal")) return out;
  }
}

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

interface Config {
  readonly provider: Record<
    string,
    { options?: { baseURL?: string; headers?: Record<string, string> } }
  >;
  readonly permission: { external_directory: Record<string, string> };
}

describe("opencode behind the context proxy", { timeout: 60_000 }, () => {
  test("its provider is the proxy, its bearer an {env:} header; the sandbox opens the proxy, not the provider", async () => {
    const s = specOf();
    const bearer = s.contextCompression?.token ?? "";
    const h = await spawned(s);
    const events = await oneRun(h, adapter.records(h)[Symbol.asyncIterator]());
    const config = JSON.parse(stubFile(s, "config-0.json")) as Config;
    const options = config.provider["ollama"]?.options ?? {};
    const port = Number(new URL(options.baseURL ?? "http://x").port);
    expect(options.baseURL).toBe(`http://127.0.0.1:${port}`);
    expect(options.headers).toEqual({ "x-frm-proxy": "{env:FRM_CTX_TOKEN}" });
    // opencode's own tools may open the store's originals (the sandbox keeps writes out).
    expect(
      config.permission.external_directory[
        `${s.contextCompression?.storeDir ?? ""}/*`
      ],
    ).toBe("allow");
    const raw = stubFile(s, "config-0.json");
    expect(raw).not.toContain(bearer);
    const argv = stubFile(s, "argv-0.json");
    expect(argv).not.toContain(bearer);
    // opencode's env holds it (a digest here); the provider's own address it no longer needs.
    const creds = JSON.parse(stubFile(s, "env-0.json")) as Record<
      string,
      string
    >;
    expect(creds["FRM_CTX_TOKEN"]).toBe(
      createHash("sha256").update(bearer).digest("hex"),
    );
    expect(JSON.parse(stubFile(s, "env-names-0.json"))).not.toContain(
      "OLLAMA_BASE_URL",
    );
    // The call went through the proxy (from inside the sandbox), upstream without the bearer.
    expect(stubFile(s, "model-calls.jsonl")).toContain('"status":200');
    const calls = upstream.requests.filter(
      (r) => r.url === "/v1/chat/completions",
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((r) => r.headers["x-frm-proxy"] === undefined)).toBe(
      true,
    );
    expect(
      events.find((e) => e.kind === "terminal")?.payload["context"],
    ).toMatchObject({
      ruleset: CONTEXT_RULESET,
      calls: 1,
    });
    expect(await listening(port)).toBe(true);
    await within(adapter.stop(h, "graceful"), "stop");
    expect(await listening(port)).toBe(false);
  });

  test("a provider URL with a path, set on the model as an operator does (Ollama's /v1): the proxy forwards under it", async () => {
    // An Ollama stand-in that answers nothing outside `/v1`, as the real one does.
    const ollama = await startFakeUpstream(echoUnder("/v1"));
    try {
      const s: SpawnSpec = {
        ...specOf(),
        env: { PATH: process.env["PATH"] ?? "" },
        modelSettings: { provider_url: `${ollama.url}/v1` },
      };
      const h = await spawned(s);
      const events = await oneRun(
        h,
        adapter.records(h)[Symbol.asyncIterator](),
      );
      await within(adapter.stop(h, "graceful"), "stop");
      expect(ollama.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /v1/chat/completions",
      ]);
      expect(stubFile(s, "model-calls.jsonl")).toBe('{"status":200}\n');
      expect(
        events.find((e) => e.kind === "terminal")?.payload["context"],
      ).toMatchObject({ calls: 1 });
    } finally {
      await ollama.close();
    }
  });

  test("a kill closes the proxy too", async () => {
    const s = specOf();
    const h = await spawned(s);
    const config = JSON.parse(stubFile(s, "config-0.json")) as Config;
    const port = Number(
      new URL(config.provider["ollama"]?.options?.baseURL ?? "http://x").port,
    );
    expect(await listening(port)).toBe(true);
    await within(adapter.stop(h, "kill"), "kill");
    expect(await listening(port)).toBe(false);
  });

  test("without compression nothing changes: the provider's own URL, its port in the profile, no bearer", async () => {
    const s = specOf(false);
    const h = await spawned(s);
    const config = JSON.parse(stubFile(s, "config-0.json")) as Config;
    expect(config.provider["ollama"]?.options).toEqual({
      baseURL: "{env:OLLAMA_BASE_URL}",
    });
    expect(JSON.parse(stubFile(s, "env-0.json"))).not.toHaveProperty(
      "FRM_CTX_TOKEN",
    );
    await within(adapter.stop(h, "graceful"), "stop");
  });

  test("refused: no provider address to proxy, or an executor that is not local", async () => {
    const s = specOf();
    const none = await adapter.spawn(
      { ...s, env: { PATH: s.env["PATH"] ?? "" } },
      executor,
    );
    expect(none.ok ? "spawned" : none.error.message).toMatch(
      /needs the provider's base URL/,
    );
    expect(adapter.compressesContext?.({ kind: "container" })).toBe(false);
    expect(adapter.compressesContext?.({ kind: "local" })).toBe(true);
  });
});

describe.skipIf(process.platform !== "darwin")(
  "inside Seatbelt, for real",
  { timeout: 60_000 },
  () => {
    const block = ProviderBlock.parse(DEFAULTS.providers.ollama);

    test("the profile opens the proxy's loopback port and closes the provider's port and DNS", async () => {
      const s = specOf();
      const on = await confinement(executor, s, undefined, block, false, 41234);
      const off = await confinement(executor, s, undefined, block, false);
      if (!on.ok || !off.ok) throw new Error("no profile");
      const [, , proxied = ""] = on.value;
      const [, , direct = ""] = off.value;
      expect(proxied).toContain(
        '(allow network-outbound (remote ip "localhost:41234"))',
      );
      expect(proxied).not.toContain(`*:${upstream.port}`);
      expect(proxied).not.toContain("mDNSResponder");
      expect(direct).toContain(
        `(allow network-outbound (remote tcp "*:${upstream.port}"))`,
      );
      expect(direct).not.toContain("localhost:41234");
    });

    /** One session, one turn per text; each turn's tool output. */
    async function turns(
      s: SpawnSpec,
      texts: readonly string[],
    ): Promise<string[]> {
      const h = await spawned(s);
      const records = adapter.records(h)[Symbol.asyncIterator]();
      const outputs: string[] = [];
      for (const [i, text] of texts.entries()) {
        const sent = await adapter.send(h, {
          runId: `t${i}`,
          text,
          promptPath: "/p",
        });
        expect(sent.ok).toBe(true);
        const lines: string[] = [];
        for (;;) {
          const next = await within(records.next(), "a record");
          if (next.done === true) break;
          const line = new TextDecoder().decode(next.value.bytes);
          lines.push(line);
          if (line.includes('"stopReason"')) break;
        }
        outputs.push(lines.filter((l) => l.includes('"rawOutput"')).join("\n"));
      }
      await within(adapter.stop(h, "graceful"), "stop");
      return outputs;
    }

    /** The model's shell runs `nc` at the provider's port; the tool's output. */
    const ncProvider = async (s: SpawnSpec): Promise<string> =>
      (
        await turns(s, [
          `Run exactly: \`nc -z -w 2 127.0.0.1 ${upstream.port}; echo exit=$?\``,
        ])
      ).join("");

    test("the store: its read tool opens an original, and every write there is refused", async () => {
      const s = specOf();
      const store = s.contextCompression?.storeDir ?? "";
      // As the supervisor's proxy leaves it: the store, one original in it.
      mkdirSync(store, { recursive: true, mode: 0o700 });
      const original = join(store, `${"a".repeat(64)}.txt`);
      writeFileSync(original, "the whole original\n");
      const elsewhere = join(dirname(dirname(store)), "not-granted.txt");
      writeFileSync(elsewhere, "not for the model\n");
      const [read, refused, write, move] = await turns(s, [
        `Read exactly: \`${original}\``,
        `Read exactly: \`${elsewhere}\``,
        `Run exactly: \`echo planted > ${store}/planted.txt; echo exit=$?\``,
        `Run exactly: \`mv ${store} ${store}-moved; echo exit=$?\``,
      ]);
      expect(read).toContain("the whole original");
      // Its permission grants the store alone outside the worktree.
      expect(refused).toContain(
        "prevents you from using this specific tool call",
      );
      expect(refused).not.toContain("not for the model");
      // Seatbelt: no write in the store, nor of the store's path.
      expect(write).toContain("exit=");
      expect(write).not.toContain("exit=0");
      expect(existsSync(join(store, "planted.txt"))).toBe(false);
      expect(move).not.toContain("exit=0");
      expect(existsSync(original)).toBe(true);
    });

    test("the model's shell reaches the provider directly without compression, and not with it", async () => {
      expect(await ncProvider(specOf(false))).toContain("exit=0");
      const s = specOf();
      const out = await ncProvider(s);
      expect(out).toContain("exit=");
      expect(out).not.toContain("exit=0");
      // Its own model call went through the proxy from inside the same sandbox.
      expect(stubFile(s, "model-calls.jsonl")).toContain('"status":200');
    });
  },
);

test("the profile: a loopback port for the proxy, and none of it without one", () => {
  const base = {
    writable: ["/w"],
    denyWrite: [],
    denyRead: [],
    providerPorts: [],
    dns: false,
  };
  const off = seatbeltProfile(base);
  expect(seatbeltProfile({ ...base, loopbackPorts: [] })).toBe(off);
  const on = seatbeltProfile({ ...base, loopbackPorts: [41234] });
  expect(on).toContain(
    '(allow network-outbound (remote ip "localhost:41234"))',
  );
  expect(
    on.replace('(allow network-outbound (remote ip "localhost:41234"))\n', ""),
  ).toBe(off);
});
