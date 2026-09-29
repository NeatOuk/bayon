// What the codex-exec adapter registers at supervisor boot (amendment 4): its runner row, its caps
// (§5.1, App. B) and one models row per tier. The Codex CLI is external and pinned: spawn refuses
// any other version, and a change decertifies the pair (M3-b).
import type { RunnerCaps } from "@bayon/core";
import type { ModelRow, Registration } from "../../adapter.js";
import { API_KEY_ENV, AUTH_JSON_ENV } from "./home.js";

export const RUNNER_ID = "codex-exec";
/** The mapper, argv and host are written against this CLI; any other is refused. */
export const PINNED_VERSION = "0.154.0";
/** The first line `codex --version` prints for the pinned CLI. */
export const VERSION_LINE = `codex-cli ${PINNED_VERSION}`;

/**
 * The credentials a session may resolve onto, in the order the supervisor tries them (one-of: it
 * injects exactly one). The whole `auth.json` is the OAuth login, whose refresh token rotates when
 * the CLI refreshes it — two live sessions sharing one would log each other out.
 */
export const SECRET_ENV_ANY_OF = [[API_KEY_ENV], [AUTH_JSON_ENV]] as const;

/** Credentials that serve one live session at a time. */
const SINGLE_SESSION_SECRETS: readonly string[] = [AUTH_JSON_ENV];

/**
 * §5.1 `concurrentSessions` for this runner, from the credentials it declares it may resolve onto.
 * Which one a session actually gets is decided per spawn — the supervisor reads the host secret
 * store in `buildEnv`, long after registration hashed these caps and after admission ran — so the
 * cap cannot be read off a live session without varying with what the store happens to hold and
 * lapsing the certification on every boot. §5.1's rule settles it: declare the narrower value
 * unless the wider one is certain. It is certain only when no alternative is a single-session
 * credential, which is a change to these rows — one deliberate decertification, not a nightly one.
 */
export const concurrentSessionsOf = (
  anyOf: readonly (readonly string[])[],
): boolean =>
  !anyOf.some((group) =>
    group.some((name) => SINGLE_SESSION_SECRETS.includes(name)),
  );

export const CAPS: RunnerCaps = {
  structuredEvents: true, // exec --json
  multiTurnInProcess: false, // one process per turn; turn N+1 is `exec resume` under one handle
  resumable: true, // `exec resume <thread>`, the thread id kept in <home>/thread.json
  // False while auth.json is one of the credentials a session may resolve onto (§5.1): admission
  // then admits one session of this runner at a time and queues the rest.
  concurrentSessions: concurrentSessionsOf(SECRET_ENV_ANY_OF),
  costReporting: true, // tokens reported per turn, priced from the models rows (design Q4)
  tokenCounting: false, // pre-flight uses the §5.1 approximation with a 15 % margin
  toolApprovalCallback: false, // exec forces approval_policy=never; the sandbox is the policy
  sandboxModes: true, // sandbox_mode, per executor kind (design Q5); suite-unverified
  mcpClient: true, // mcp_servers.<name>.url + bearer_token_env_var
  hooks: false, // untrusted hooks need trust, never bypassed
  pty: false, // exec is headless
  outputSchema: true, // --output-schema + -o, from SendSpec.output
  imageInput: false, // -i is not wired
  subagents: false, // features.multi_agent is off; collab items map to runner_native
};

// Model ids from 0.154.0's catalog (codex-rs/models-manager/models.json): sol "most capable",
// terra "balanced", luna "fast and affordable". Prices: OpenAI's published API rates, standard tier,
// effective 2026-07-30, in USD per Mtok. contextTokens is the catalog window; OpenAI bills a prompt
// above 272K at 2x input / 1.5x output, which these flat rows (and so the spend ledger) do not model.
// A model outside these rows is refused at spawn, so nothing runs unpriced.
export const MODELS: readonly ModelRow[] = [
  {
    id: `${RUNNER_ID}.complex`,
    tier: "complex",
    model: "gpt-5.6-sol",
    effort: "high",
    priceInPerMtok: 5,
    priceOutPerMtok: 30,
    priceCacheReadPerMtok: 0.5,
    priceCacheWritePerMtok: 6.25,
    contextTokens: 272_000,
  },
  {
    id: `${RUNNER_ID}.standard`,
    tier: "standard",
    model: "gpt-5.6-terra",
    effort: "medium",
    priceInPerMtok: 2,
    priceOutPerMtok: 12,
    priceCacheReadPerMtok: 0.2,
    priceCacheWritePerMtok: 2.5,
    contextTokens: 272_000,
  },
  {
    id: `${RUNNER_ID}.cheap`,
    tier: "cheap",
    model: "gpt-5.6-luna",
    effort: "low",
    priceInPerMtok: 0.2,
    priceOutPerMtok: 1.2,
    priceCacheReadPerMtok: 0.02,
    priceCacheWritePerMtok: 0.25,
    contextTokens: 272_000,
  },
];

/**
 * The runner row's `defaults_json`. The supervisor resolves exactly one of `secretEnvAnyOf` from
 * the host secret store into the child's env (Invariant 11): CODEX_API_KEY by default, or the whole
 * auth.json `codex login` writes, which the turn host puts in the private home (local only).
 * `containerInstall` and `egressHosts` feed the container image and gateway (M3-f).
 */
export const DEFAULTS = {
  secretEnvAnyOf: SECRET_ENV_ANY_OF,
  /**
   * core's READS_GRANTED_LOGIN: this adapter places a login granted in place
   * (SpawnSpec.grantedLogin) as auth.json and writes the rotated one back, so a grant stands in for
   * the one-of above. The supervisor refuses a grant to a runner that does not declare this.
   */
  readsGrantedLogin: true,
  secretHints: {
    [API_KEY_ENV]:
      "an OpenAI API key: security add-generic-password -s foreman -a CODEX_API_KEY -w",
    [AUTH_JSON_ENV]:
      "the whole auth.json that `codex login` writes; local executors only, one session at a time",
  },
  hashInputs: ["AGENTS.md"],
  bin: ["codex"],
  hostNode: "node",
  sandboxByKind: {
    local: "workspace-write",
    container: "danger-full-access",
    remote: "workspace-write",
  },
  initTimeoutMs: 60_000,
  mcpStartupTimeoutSec: 20,
  containerInstall: [`npm install -g @openai/codex@${PINNED_VERSION}`],
  egressHosts: ["api.openai.com"],
  /**
   * The smallest context a session with the CLI's own tools needs before it reads a file: its
   * instructions and tool schemas. An estimate until a real run measures it. Admission
   * refuses a run class whose context cap is below it (context_baseline).
   */
  sessionBaselineTokens: 10_000,
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
