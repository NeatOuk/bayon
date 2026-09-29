// an earlier change on the real CLI: the pinned bundled binary behind a real context proxy, against a local
// stand-in for the Messages API. A dummy key, no model call, no Keychain, nothing leaving 127.0.0.1;
// skipped where this platform bundles no binary. The stub CLI cannot be the evidence: what is tested
// is the CLI's own tool search rule and its own start-up requests.
//
// 1. Tool search. The CLI turns it off under a base URL that is not its first-party host, which the
//    proxy is. With the env the adapter now builds for a first-party upstream, the first main-loop
//    request through the proxy carries the tools an unproxied first-party session sends; the same
//    env without the flag (the build before) inlines every tool. A first-party upstream cannot be
//    reached from a test, so that arm runs the bare binary with the adapter's own env builders and
//    the stand-in plays the upstream; the control is the stand-in taken as first party with the
//    CLI's own switch. Through the adapter, an upstream that is not first party keeps tool search off,
//    as the CLI keeps it off there without the proxy.
// 2. The start-up request without the bearer: the CLI's preconnect, `HEAD /api/hello`, with no
//    credential at all. The proxy answers it; nothing is forwarded and nothing is warned.
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONTEXT_RULESET, CONTEXT_STORE_DIR } from "@bayon/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { SpawnSpec } from "../../adapter.js";
import { PROXY_HEADER, startModelProxy } from "../../model-proxy.js";
import { bundledBinary } from "./adapter.js";
import { CLAUDE_CONTEXT, PRECONNECT_PATH } from "./context.js";
import { DEFAULTS } from "./registration.js";
import { TOOL_SEARCH_ENV, inlineEnv, sessionEnv } from "./session-env.js";
import {
  KEY,
  MODEL,
  QUIET,
  closeStandIn,
  isMessages,
  mainLoop,
  oneTurn,
  runCli,
  standIn,
  toolsOf,
  type Hit,
  type StandIn,
} from "./testing/real-cli.js";

const BINARY = bundledBinary();
const PRESENT = BINARY !== undefined && existsSync(BINARY);

/** The CLI's own switch that makes it take a custom base URL as first party (pinned "" by default). */
const ASSUME_FIRST_PARTY = "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL";

/** One `-p` turn with no settings file, as the adapter runs it, and the adapter's inline env. */
const turnArgs = (settingsEnv: Readonly<Record<string, unknown>>): string[] => [
  "-p",
  "Reply with ok.",
  "--output-format",
  "json",
  "--setting-sources=",
  "--settings",
  JSON.stringify({ env: settingsEnv }),
  "--model",
  MODEL,
  "--max-turns",
  "1",
];

/** `env` as built, or without the tool search flag: the env this adapter built before the change. */
const kept = <T>(
  env: Readonly<Record<string, T>>,
  withFlag: boolean,
): Record<string, T> =>
  Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => withFlag || name !== TOOL_SEARCH_ENV,
    ),
  );

const within5 = (a: number, b: number): boolean => Math.abs(a - b) <= 0.05 * b;

describe.skipIf(!PRESENT)(
  "the pinned CLI behind the context proxy",
  { timeout: 120_000 },
  () => {
    const hits: Hit[] = [];
    let api: StandIn | undefined;
    let root = "";
    let sessions = 0;

    beforeAll(async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "frm-tool-search-")));
      api = await standIn(hits);
    });
    afterAll(async () => {
      await closeStandIn(api);
      rmSync(root, { recursive: true, force: true });
    });

    /** A fresh session layout and the operator's env: the dummy key, no base URL of its own. */
    function session(
      env: Record<string, string> = {},
      compress = false,
    ): SpawnSpec {
      hits.length = 0;
      const base = join(root, `s${++sessions}`);
      const cwd = join(base, "work");
      const homeDir = join(base, "home");
      const home = join(base, "os-home");
      for (const dir of [cwd, homeDir, home])
        mkdirSync(dir, { recursive: true });
      return {
        sessionId: `01TOOLSEARCH${sessions}`,
        cwd,
        homeDir,
        env: {
          // With the vitest setup's stand-in `security` first: nothing reaches the real Keychain.
          PATH: process.env["PATH"] ?? "",
          HOME: home,
          ...QUIET,
          ANTHROPIC_API_KEY: KEY,
          ...env,
        },
        model: MODEL,
        flags: { ...DEFAULTS },
        ...(compress
          ? {
              contextCompression: {
                ruleset: CONTEXT_RULESET,
                storeDir: join(base, CONTEXT_STORE_DIR),
                token: randomBytes(32).toString("hex"),
              },
            }
          : {}),
      };
    }

    /** The first request of the CLI's main loop (the one that offers Bash). */
    function firstMainLoop(): Hit {
      const [first] = mainLoop(hits);
      if (first === undefined) throw new Error("no main-loop request");
      return first;
    }

    /** The bare binary with the env the adapter builds for `spec` behind a real proxy to the stand-in. */
    async function throughProxy(
      spec: SpawnSpec,
      withFlag: boolean,
    ): Promise<{
      readonly hit: Hit;
      readonly traced: string[];
      readonly logged: string[];
    }> {
      const traced: string[] = [];
      const logged: string[] = [];
      const token = randomBytes(32).toString("hex");
      const started = await startModelProxy({
        upstream: api?.url ?? "",
        token,
        transform: CLAUDE_CONTEXT,
        onFrame: () => undefined,
        storeDir: join(dirname(spec.cwd), CONTEXT_STORE_DIR),
        writable: [spec.cwd, spec.homeDir],
        log: (event) => logged.push(event),
        trace: (line) => traced.push(line),
      });
      if (!started.ok) throw new Error(started.error.message);
      const proxy = { url: started.value.url, token };
      try {
        const inline = inlineEnv(spec, undefined, proxy);
        if (!inline.ok) throw new Error(inline.error.message);
        const child = kept(
          {
            ...sessionEnv(spec, undefined, proxy),
            CLAUDE_CONFIG_DIR: spec.homeDir,
          },
          withFlag,
        );
        const settings = kept(inline.value, withFlag);
        await runCli(BINARY ?? "", turnArgs(settings), spec.cwd, child);
      } finally {
        await started.value.close();
      }
      return { hit: firstMainLoop(), traced, logged };
    }

    test("a first-party upstream behind the proxy: the tools an unproxied session sends, not every schema inline", async () => {
      // Control: an unproxied session on the first-party host, the stand-in taken as that host.
      const control = session({
        ANTHROPIC_BASE_URL: api?.url ?? "",
        [ASSUME_FIRST_PARTY]: "1",
      });
      const controlEnv = inlineEnv(control, undefined);
      if (!controlEnv.ok) throw new Error(controlEnv.error.message);
      await runCli(BINARY ?? "", turnArgs(controlEnv.value), control.cwd, {
        ...control.env,
        CLAUDE_CONFIG_DIR: control.homeDir,
      });
      const unproxied = toolsOf(firstMainLoop());

      // The adapter's env for a proxied session on the default (first-party) upstream.
      const proxied = session();
      expect(
        sessionEnv(proxied, undefined, { url: "u", token: "t" }),
      ).toMatchObject({ [TOOL_SEARCH_ENV]: "true" });
      const after = await throughProxy(proxied, true);
      const before = await throughProxy(session(), false);
      const now = toolsOf(after.hit);
      const then = toolsOf(before.hit);
      // The evidence the spike quotes.
      console.info(
        `tool search: unproxied ${JSON.stringify(unproxied)}\n` +
          `proxied, with the flag ${JSON.stringify(now)}\n` +
          `proxied, without it ${JSON.stringify(then)}`,
      );

      expect(unproxied.names).toContain("ToolSearch");
      expect(unproxied.deferred).toBeGreaterThan(0);
      expect(now.names).toEqual(unproxied.names);
      expect(within5(now.toolBytes, unproxied.toolBytes)).toBe(true);
      expect(within5(now.bodyBytes, unproxied.bodyBytes)).toBe(true);
      // Without the flag, as before this change: no tool search, every schema inline.
      expect(then.names).not.toContain("ToolSearch");
      expect(then.deferred).toBe(0);
      expect(then.names.length).toBeGreaterThan(now.names.length);
      expect(then.toolBytes).toBeGreaterThan(1.5 * now.toolBytes);
      // It went through the proxy: its bearer stripped, the credential passed on.
      expect(after.hit.headers[PROXY_HEADER]).toBeUndefined();
      expect(after.hit.headers["x-api-key"]).toBe(KEY);
      expect(after.traced).toContain("forward POST /v1/messages");
    });

    test("the start-up request without the bearer is the CLI's preconnect, HEAD /api/hello, with no credential", async () => {
      // Unproxied, with the proxy's header set by hand: every API call carries it but this one.
      const bearer = randomBytes(32).toString("hex");
      const spec = session({
        ANTHROPIC_BASE_URL: api?.url ?? "",
        ANTHROPIC_CUSTOM_HEADERS: `${PROXY_HEADER}: ${bearer}`,
      });
      const turn = await oneTurn(spec, "Reply with ok.");
      expect(turn.outcome).toBe("ok");
      const bare = hits.filter((h) => h.headers[PROXY_HEADER] === undefined);
      expect(bare.map((h) => `${h.method} ${h.url}`)).toEqual([
        `HEAD ${PRECONNECT_PATH}`,
      ]);
      const [hello] = bare;
      expect(hello?.headers["x-api-key"]).toBeUndefined();
      expect(hello?.headers["authorization"]).toBeUndefined();
      expect(hello?.body).toBe("");
      const calls = hits.filter(isMessages);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call.headers[PROXY_HEADER]).toBe(bearer);
    });

    test("through the adapter with compression on: the proxy answers the preconnect, and a non-first-party upstream keeps tool search off", async () => {
      // Unproxied against the same stand-in (not first party): the CLI's own choice there.
      const plain = session({ ANTHROPIC_BASE_URL: api?.url ?? "" });
      expect((await oneTurn(plain, "Reply with ok.")).outcome).toBe("ok");
      const unproxied = toolsOf(firstMainLoop());

      const traced: string[] = [];
      const logged: string[] = [];
      const spec = session({ ANTHROPIC_BASE_URL: api?.url ?? "" }, true);
      const turn = await oneTurn(spec, "Reply with ok.", {
        contextLog: (event) => logged.push(event),
        contextTrace: (line) => traced.push(line),
      });
      expect(turn.outcome).toBe("ok");
      // The preconnect was answered by the proxy, and went no further.
      expect(traced).toContain(`probe HEAD ${PRECONNECT_PATH}`);
      expect(traced.filter((l) => l.startsWith("401"))).toEqual([]);
      expect(logged).not.toContain("unauthorized");
      expect(hits.map((h) => h.url)).not.toContain(PRECONNECT_PATH);
      // Tool search as the upstream would have it: off here, as without the proxy.
      const proxied = toolsOf(firstMainLoop());
      expect(unproxied.names).not.toContain("ToolSearch");
      expect(proxied.names).toEqual(unproxied.names);
      expect(proxied.deferred).toBe(0);
    });
  },
);
