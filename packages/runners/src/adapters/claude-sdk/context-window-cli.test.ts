// an earlier change/235 on the real CLI: the pinned bundled binary against a local stand-in for the Messages
// API, behind a real context proxy as a compression-on session runs. A dummy key, no model call, no
// Keychain, nothing leaving 127.0.0.1; skipped where this platform bundles no binary. The stub CLI
// cannot be the evidence: what is tested is the CLI's own window rule and what it sends.
//
// 1. Every registered row's window is the one the CLI reports for it behind the proxy (its result
//    frame's modelUsage[…].contextWindow): 1M only for a string with the `[1m]` opt-in, which puts
//    the `context-1m-2025-08-07` beta on the request and sends the bare id; 200k otherwise. The
//    controls: Sonnet 5 and Opus 5.5, both native 1M in 2.1.283's catalog, get 1M only against the
//    first-party host. Opus 5.5 is a model this CLI knows (no unrecognized_model, its own output
//    cap and list price); 2.1.269 did not know it at all.
// 2. Through the adapter, the complex row reaches the API as `claude-opus-5-5` with the 1M beta and
//    its own effort (Opus 5.5 would default to medium), and the turn ends ok.
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
import { z } from "zod";
import type { SpawnSpec } from "../../adapter.js";
import { startModelProxy } from "../../model-proxy.js";
import { bundledBinary } from "./adapter.js";
import { CLAUDE_CONTEXT } from "./context.js";
import { DEFAULTS, MODELS } from "./registration.js";
import { inlineEnv, sessionEnv } from "./session-env.js";
import {
  KEY,
  QUIET,
  closeStandIn,
  mainLoop,
  oneTurn,
  runCliOutput,
  standIn,
  type Hit,
  type StandIn,
} from "./testing/real-cli.js";
import {
  DEFAULT_WINDOW,
  ONE_M_SUFFIX,
  ONE_M_WINDOW,
  bareModel,
  hasOneM,
} from "./window.js";

const BINARY = bundledBinary();
const PRESENT = BINARY !== undefined && existsSync(BINARY);

/** The CLI's own switch that makes it take a custom base URL as first party (a control only). */
const ASSUME_FIRST_PARTY = "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL";
const ONE_M_BETA = "context-1m-2025-08-07";

const complex = MODELS.find((m) => m.tier === "complex" && m.standby !== true);
const standard = MODELS.find((m) => m.tier === "standard");

/** The result frame's per-model usage, keyed by the string spawned. */
const ResultOut = z.object({
  is_error: z.boolean(),
  modelUsage: z.record(
    z.string(),
    z.looseObject({
      contextWindow: z.number(),
      maxOutputTokens: z.number().optional(),
      costBasis: z.string().optional(),
    }),
  ),
});

/** Opus 5.5's output cap in 2.1.283's catalog (2.1.269, not knowing the model, gave it 32,000). */
const OPUS_5_5_MAX_OUTPUT = 128_000;
/** What the CLI prints on stderr for a model its catalog does not know. */
const UNRECOGNIZED = "unrecognized_model";

/** What one main-loop request carried: the id the API is sent, its betas, its effort. */
const Body = z.looseObject({
  model: z.string(),
  output_config: z.looseObject({ effort: z.string() }).optional(),
});
const sent = (hit: Hit) => {
  const body = Body.parse(JSON.parse(hit.body));
  const beta = hit.headers["anthropic-beta"];
  return {
    model: body.model,
    betas: (typeof beta === "string" ? beta : "").split(","),
    effort: body.output_config?.effort,
  };
};

describe.skipIf(!PRESENT)(
  "the pinned CLI's context window, behind the context proxy",
  { timeout: 180_000 },
  () => {
    const hits: Hit[] = [];
    let api: StandIn | undefined;
    let root = "";
    let sessions = 0;

    beforeAll(async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "frm-window-")));
      api = await standIn(hits);
    });
    afterAll(async () => {
      await closeStandIn(api);
      rmSync(root, { recursive: true, force: true });
    });

    /** A fresh session layout on `model`, the operator's env: the dummy key and `env`. */
    function session(
      model: string,
      effort: string | undefined,
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
        sessionId: `01WINDOW${sessions}`,
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
        model,
        ...(effort === undefined ? {} : { effort }),
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

    /**
     * One `-p` turn of the bare binary with the adapter's env: the window and output cap it
     * reports, the basis of its cost, its stderr, and what it sent.
     */
    async function turn(
      spec: SpawnSpec,
      env: Readonly<Record<string, string>>,
      settingsEnv: Readonly<Record<string, unknown>>,
    ): Promise<{
      readonly window: number | undefined;
      readonly maxOutput: number | undefined;
      readonly costBasis: string | undefined;
      readonly stderr: string;
      readonly hit: Hit;
    }> {
      const args = [
        "-p",
        "Reply with ok.",
        "--output-format",
        "json",
        "--setting-sources=",
        "--settings",
        JSON.stringify({ env: settingsEnv }),
        "--model",
        spec.model,
        ...(spec.effort === undefined ? [] : ["--effort", spec.effort]),
        "--max-turns",
        "1",
      ];
      const out = await runCliOutput(BINARY ?? "", args, spec.cwd, {
        ...env,
        CLAUDE_CONFIG_DIR: spec.homeDir,
      });
      const result = ResultOut.parse(JSON.parse(out.stdout));
      expect(result.is_error).toBe(false);
      const [hit] = mainLoop(hits);
      if (hit === undefined) throw new Error("no main-loop request");
      const usage = result.modelUsage[spec.model];
      return {
        window: usage?.contextWindow,
        maxOutput: usage?.maxOutputTokens,
        costBasis: usage?.costBasis,
        stderr: out.stderr,
        hit,
      };
    }

    /** The bare binary behind a real context proxy to the stand-in, as a compression-on session runs. */
    async function throughProxy(spec: SpawnSpec) {
      const token = randomBytes(32).toString("hex");
      const started = await startModelProxy({
        upstream: api?.url ?? "",
        token,
        transform: CLAUDE_CONTEXT,
        onFrame: () => undefined,
        storeDir: join(dirname(spec.cwd), CONTEXT_STORE_DIR),
        writable: [spec.cwd, spec.homeDir],
      });
      if (!started.ok) throw new Error(started.error.message);
      const proxy = { url: started.value.url, token };
      try {
        const inline = inlineEnv(spec, undefined, proxy);
        if (!inline.ok) throw new Error(inline.error.message);
        return await turn(
          spec,
          sessionEnv(spec, undefined, proxy),
          inline.value,
        );
      } finally {
        await started.value.close();
      }
    }

    /** Unproxied, the stand-in taken as the first-party host: what a session without compression gets. */
    async function firstParty(spec: SpawnSpec) {
      const inline = inlineEnv(spec, undefined);
      if (!inline.ok) throw new Error(inline.error.message);
      return turn(spec, spec.env, inline.value);
    }

    test("every registered row's window is the one the CLI gives it behind the proxy", async () => {
      const seen: string[] = [];
      for (const m of MODELS) {
        const { window, maxOutput, stderr, hit } = await throughProxy(
          session(m.model, m.effort),
        );
        const request = sent(hit);
        seen.push(
          `${m.id}: ${m.model} → window ${String(window)}, max output ${String(maxOutput)}, ` +
            `body ${request.model}, 1M beta ${String(request.betas.includes(ONE_M_BETA))}, ` +
            `effort ${String(request.effort)}`,
        );
        // Every registered model is in the pinned CLI's catalog.
        expect(stderr, m.id).not.toContain(UNRECOGNIZED);
        expect([m.id, window]).toEqual([m.id, m.contextTokens]);
        expect(window).toBe(hasOneM(m.model) ? ONE_M_WINDOW : DEFAULT_WINDOW);
        // The API is sent the bare id; the opt-in rides as the beta, and only with the suffix.
        expect(request.model).toBe(bareModel(m.model));
        expect(request.betas.includes(ONE_M_BETA)).toBe(hasOneM(m.model));
        if (m.effort !== undefined) expect(request.effort).toBe(m.effort);
      }
      // The evidence the spike quotes.
      console.info(`windows behind the proxy:\n${seen.join("\n")}`);
    });

    test("controls: without the opt-in, Sonnet 5 and Opus 5.5 get 1M on the first-party host alone", async () => {
      const sonnet = standard?.model ?? "";
      const opus = bareModel(complex?.model ?? "");
      expect(sonnet).toBe("claude-sonnet-5");
      expect(opus).toBe("claude-opus-5-5");
      const direct = {
        ANTHROPIC_BASE_URL: api?.url ?? "",
        [ASSUME_FIRST_PARTY]: "1",
      };

      expect((await throughProxy(session(sonnet, "high"))).window).toBe(
        DEFAULT_WINDOW,
      );
      expect((await firstParty(session(sonnet, "high", direct))).window).toBe(
        ONE_M_WINDOW,
      );
      // Opus 5.5 is in 2.1.283's catalog, native 1M: the same rule as Sonnet 5.
      const opusDirect = await firstParty(session(opus, "xhigh", direct));
      expect(opusDirect.window).toBe(ONE_M_WINDOW);
      const opusProxied = await throughProxy(session(opus, "xhigh"));
      expect(opusProxied.window).toBe(DEFAULT_WINDOW);
      // With the opt-in, 1M on the first-party host too.
      const optedIn = `${opus}${ONE_M_SUFFIX}`;
      const optedInDirect = await firstParty(session(optedIn, "xhigh", direct));
      expect(optedInDirect.window).toBe(ONE_M_WINDOW);
      // A model the CLI knows: no notice, its own output cap on the wire, priced at its list.
      for (const known of [opusDirect, opusProxied, optedInDirect]) {
        expect(known.stderr).not.toContain(UNRECOGNIZED);
        expect(known.maxOutput).toBe(OPUS_5_5_MAX_OUTPUT);
        expect(known.costBasis).toBe("list");
        expect(
          (JSON.parse(known.hit.body) as { max_tokens?: unknown }).max_tokens,
        ).toBe(OPUS_5_5_MAX_OUTPUT);
      }
    });

    test("through the adapter, compression on: the complex row reaches the API as claude-opus-5-5 with the 1M beta and its own effort", async () => {
      expect(complex).toMatchObject({
        model: "claude-opus-5-5[1m]",
        effort: "xhigh",
        contextTokens: ONE_M_WINDOW,
      });
      const spec = session(
        complex?.model ?? "",
        complex?.effort,
        { ANTHROPIC_BASE_URL: api?.url ?? "" },
        true,
      );
      const turned = await oneTurn(spec, "Reply with ok.");
      expect(turned.outcome).toBe("ok");
      const [hit] = mainLoop(hits);
      if (hit === undefined) throw new Error("no main-loop request");
      expect(sent(hit)).toMatchObject({
        model: "claude-opus-5-5",
        effort: "xhigh",
      });
      expect(sent(hit).betas).toContain(ONE_M_BETA);
    });
  },
);
