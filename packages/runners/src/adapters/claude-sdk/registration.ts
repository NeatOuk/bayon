// What this adapter registers at supervisor boot (amendment 4): its runner row, its caps (§5.1,
// App. A) and its models rows, one active per tier. Runner and model names live here, never in the
// db seed.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { RunnerCaps } from "@bayon/core";
import { z } from "zod";
import type { ModelRow, Registration } from "../../adapter.js";
import { claudeContainerDefaults } from "./container.js";
import { DOCTRINE_FILES } from "./doctrine.js";
import { DEFAULT_WINDOW, ONE_M_SUFFIX, ONE_M_WINDOW } from "./window.js";

export const RUNNER_ID = "claude-sdk";
export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

export const CAPS: RunnerCaps = {
  structuredEvents: true,
  multiTurnInProcess: true,
  resumable: true, // `resume`, with the transcript inside the session's home
  concurrentSessions: true, // a key or an OAuth token serves every live session at once
  costReporting: true,
  tokenCounting: false, // pre-flight uses the §5.1 approximation with a 15 % margin
  // Unwired (permissionPrompts 'none'): declaring it would fail conformance test 12.
  toolApprovalCallback: false,
  sandboxModes: false, // unmapped, so untrusted work is container-only
  mcpClient: true,
  hooks: false, // unwired: no hook reaches the supervisor yet
  pty: true, // the same binary with `--resume`
  // The SDK's outputFormat, fixed per process from SpawnSpec.output; the answer is written to
  // SendSpec.output.path (structured-output.ts).
  outputSchema: true,
  imageInput: true,
  subagents: true,
};

// Prices re-checked 2026-09-28 against the published list prices (cache writes are the 5-minute
// ones). They feed only the estimated spend path; reported costs come from the runner.
//
// contextTokens is the window the pinned CLI gives the session (window.ts), not the
// model's own: 1M only for a string with the CLI's `[1m]` opt-in, else its 200k default, which is
// what a session behind the context proxy gets. A certificate pins the model string, so a row may
// change its window freely but its string only to be certified again.
export const MODELS: readonly ModelRow[] = [
  {
    // Opus 5.5. The pinned CLI (2.1.283; 2.1.269 refused it) knows it: native 1M against
    // the first-party host only, so a proxied session needs the opt-in; an output cap of 128,000
    // tokens; priced at its list, as below. Its effort default is medium, so the row sets its own;
    // the CLI sends it as output_config.effort.
    id: `${RUNNER_ID}.complex-opus-5-5`,
    tier: "complex",
    model: `claude-opus-5-5${ONE_M_SUFFIX}`,
    effort: "xhigh",
    priceInPerMtok: 4,
    priceOutPerMtok: 20,
    priceCacheReadPerMtok: 0.2,
    priceCacheWritePerMtok: 5,
    contextTokens: ONE_M_WINDOW,
  },
  {
    // The tier's model before Opus 5.5, kept with its certificates: an operator switches back with
    // PATCH /runners/claude-sdk/models/claude-sdk.complex {"active": true}.
    id: `${RUNNER_ID}.complex`,
    tier: "complex",
    model: "claude-opus-5",
    effort: "xhigh",
    priceInPerMtok: 5,
    priceOutPerMtok: 25,
    priceCacheReadPerMtok: 0.5,
    priceCacheWritePerMtok: 6.25,
    contextTokens: DEFAULT_WINDOW,
    standby: true,
  },
  {
    id: `${RUNNER_ID}.standard`,
    tier: "standard",
    model: "claude-sonnet-5",
    effort: "high",
    priceInPerMtok: 2,
    priceOutPerMtok: 10,
    priceCacheReadPerMtok: 0.2,
    priceCacheWritePerMtok: 2.5,
    contextTokens: DEFAULT_WINDOW,
  },
  {
    id: `${RUNNER_ID}.cheap`,
    tier: "cheap",
    model: "claude-haiku-4-5",
    priceInPerMtok: 1,
    priceOutPerMtok: 5,
    priceCacheReadPerMtok: 0.1,
    priceCacheWritePerMtok: 1.25,
    contextTokens: DEFAULT_WINDOW,
  },
];

/**
 * The runner row's `defaults_json`. The supervisor resolves secrets from the host secret store into
 * the child's env (Invariant 11) and hashes the files `hashInputs` names; both by name only.
 * `secretEnvAnyOf` is one-of, first match in this order, and only that one is injected: the CLI
 * would prefer an API key over an OAuth token if it had both. `secretHints` say how to get each.
 * The container facts (`containerInstall`, `egressHosts`) come from the installed SDK's manifest
 * at registration (container.ts).
 */
export const DEFAULTS = {
  secretEnvAnyOf: [["ANTHROPIC_API_KEY"], ["CLAUDE_CODE_OAUTH_TOKEN"]],
  secretHints: {
    ANTHROPIC_API_KEY: "an API key from the Claude Console",
    CLAUDE_CODE_OAUTH_TOKEN:
      "a one-year subscription OAuth token: run `claude setup-token`",
  },
  /** The doctrine the adapter reads into the system prompt (doctrine.ts), and nothing else. */
  hashInputs: [...DOCTRINE_FILES],
  /**
   * the subagent tool is withheld by default, because its background mode ends a run
   * with work still pending. A run ends on its terminal event (Invariant 3) and nothing restarts a
   * session on its own, so a turn that signs off waiting for a background agent waits forever. A
   * profile that genuinely needs subagents sets its own `disallowedTools` and takes that knowingly.
   */
  disallowedTools: ["Task"],
  /**
   * no settings file at all. A repository's own settings can set the env the CLI and
   * its tools run with and name commands the CLI runs (hooks, helpers) with the session's
   * credential in reach; its doctrine reaches the agent through the system prompt instead. The
   * adapter refuses a profile that names a source.
   */
  settingSources: [],
  permissionMode: "acceptEdits",
  permissionPrompts: "none",
  initTimeoutMs: 60_000,
  /**
   * The smallest context a session with this runner's own tools needs before it reads a file: its
   * system prompt and tool definitions, 15-25k tokens as the dogfood pilot measured them
   *. Admission refuses a run class whose context cap is below it (context_baseline).
   */
  sessionBaselineTokens: 20_000,
} as const;

const Versioned = z.looseObject({ version: z.string().min(1) });

function readVersion(path: string): string {
  try {
    const parsed = Versioned.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data.version : "unknown";
  } catch {
    return "unknown"; // an unreadable install shows up as `unknown` in the runners row
  }
}

const sdkDir = (): string =>
  dirname(createRequire(import.meta.url).resolve(SDK_PACKAGE));

/** The CLI version the installed SDK bundles, read from its manifest. */
const bundledCli = (): string => readVersion(join(sdkDir(), "manifest.json"));

/** The installed SDK's manifest.json, parsed; undefined when unreadable. */
function sdkManifest(): unknown {
  try {
    return JSON.parse(readFileSync(join(sdkDir(), "manifest.json"), "utf8"));
  } catch {
    return undefined; // the container facts then say why no image can hold the CLI
  }
}

/** The installed SDK's own version alone (what the update check compares to npm). */
export const sdkVersion = (): string =>
  readVersion(join(sdkDir(), "package.json"));

/** `<sdk version> (cli <bundled cli version>)`, read from the installed SDK at runtime. */
export function detectVersion(): string {
  return `${sdkVersion()} (cli ${bundledCli()})`;
}

export function registration(): Registration {
  return {
    models: MODELS,
    runner: {
      id: RUNNER_ID,
      kind: "llm_sdk",
      adapter: RUNNER_ID,
      versionDetected: detectVersion(),
      caps: CAPS,
      // The image's lines and the gateway's allowlist, or why no image can hold it.
      defaults: { ...DEFAULTS, ...claudeContainerDefaults(sdkManifest()) },
    },
  };
}
