// What the opencode adapter registers at supervisor boot (amendment 4): its runner row, its caps
// (§5.1) and one models row per tier. OpenCode is external and pinned: spawn and health refuse any
// other version, and a change decertifies the pair.
import type { RunnerCaps } from "@bayon/core";
import type { ModelRow, Registration } from "../../adapter.js";

export const RUNNER_ID = "opencode";
/** The host, frames and mapper are written against this version's ACP agent; any other is refused. */
export const PINNED_VERSION = "1.18.33";
/** The one line `opencode --version` prints for the pinned version. */
export const VERSION_LINE = PINNED_VERSION;

export const CAPS: RunnerCaps = {
  structuredEvents: true, // `opencode acp`: JSON-RPC notifications and responses
  multiTurnInProcess: true, // one acp process serves every turn of the session
  resumable: true, // session/resume <ses_…>, the session kept in the home's opencode.db
  concurrentSessions: true, // no single-session credential: every session has its own home and DB
  // Tokens come from the runner, priced from the models rows; see the runner matrix: ACP reports a
  // turn's last model call only (design §8).
  costReporting: true,
  tokenCounting: false, // pre-flight uses the §5.1 approximation
  toolApprovalCallback: false, // every rule is allow or deny; a stray `ask` is refused by the host
  sandboxModes: false, // one sandbox, not modes: Seatbelt on local macOS, the container elsewhere (confine.ts)
  mcpClient: true, // config `mcp.foreman`, through the host's loopback proxy that adds the bearer
  hooks: false, // plugins are off (OPENCODE_PURE)
  pty: false, // headless: no interactive takeover
  outputSchema: true, // checked emulation: the host validates the final answer (design §6)
  imageInput: false, // not wired
  subagents: false, // the `task` tool is denied
};

/** Local models served by an Ollama host: free, so every price is 0. Operators edit the rows. */
const ollama = (tier: ModelRow["tier"], name: string): ModelRow => ({
  id: `${RUNNER_ID}.${tier}`,
  tier,
  model: `ollama/${name}`,
  priceInPerMtok: 0,
  priceOutPerMtok: 0,
  priceCacheReadPerMtok: 0,
  priceCacheWritePerMtok: 0,
  // What the Ollama server must be configured to serve (design fact 15): opencode's own prompt
  // is ~2 050 tokens and Ollama's 4096 default truncates the conversation.
  contextTokens: 32_768,
});

export const MODELS: readonly ModelRow[] = [
  ollama("complex", "qwen3.8:27b"),
  ollama("standard", "gemma4:26b"),
  ollama("cheap", "nemotron-3.5-lightning:30b"),
];

/** The env var the default Ollama provider reads its base URL from (`http://<host>:11434/v1`). */
export const OLLAMA_BASE_URL_ENV = "OLLAMA_BASE_URL";

/**
 * The runner row's `defaults_json`. `providers` holds opencode provider blocks. The one shipped
 * names no address: Ollama's base URL is operator data, read by opencode from the child's env
 * (`{env:…}`), which the operator fills from the host secret store through a profile's
 * secret_refs, or replaces with a literal URL in the row. A hosted provider's block takes its key
 * the same way, `options.apiKey: "{env:NAME}"`. Ollama needs no key, so no secret is declared.
 */
export const DEFAULTS = {
  secretEnvAnyOf: [],
  hashInputs: ["AGENTS.md"],
  bin: ["opencode"],
  hostNode: "node",
  initTimeoutMs: 60_000,
  providers: {
    ollama: {
      npm: "@ai-sdk/openai-compatible",
      name: "Ollama",
      options: { baseURL: `{env:${OLLAMA_BASE_URL_ENV}}` },
    },
  },
  containerUnready:
    "no image installs opencode yet (no containerInstall line); its tool processes also escape a container's group probe (design §3)",
  egressHosts: [],
  egressNote:
    "the model provider's host: an Ollama host on the operator's network, or a hosted provider's API",
  /** opencode's system prompt and tool schemas, measured in the spike (design fact 15). */
  sessionBaselineTokens: 2_100,
} as const;

export function registration(): Registration {
  return {
    models: MODELS,
    runner: {
      id: RUNNER_ID,
      kind: "llm_cli",
      adapter: RUNNER_ID,
      versionDetected: VERSION_LINE,
      caps: CAPS,
      defaults: DEFAULTS,
    },
  };
}
