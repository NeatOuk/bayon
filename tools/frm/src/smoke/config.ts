import {
  hashConfig,
  renderMission,
  sha256Hex,
  type JsonValue,
  type MissionText,
} from "@bayon/core";
import type { ConfigRows } from "@bayon/db/operator";
import {
  SHIPPED_ALLOWLISTS,
  type MissionSaveRequest,
  type SpawnRequest,
} from "@bayon/proto";
import {
  FIXTURE_RUNNER_ID,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { HANG_WALL_CLOCK_MS } from "./budget.js";
import {
  BASE_BRANCH,
  DOCTRINE_PATH,
  type FixtureRepo,
} from "./fixture-repo.js";

// The operator config the smoke seeds (§4), the missions it saves over the API, and the fixture
// scripts its agents run.

export const SMOKE = {
  /** The executor the supervisor upserts at boot (amendment 4); the smoke seeds none of its own. */
  executor: "local",
  repo: "smoke-repo",
  workspace: "smoke-ws",
  relPath: "repo",
  role: "builder",
  hangRunClass: "smoke_hang",
  hangWallClockMs: HANG_WALL_CLOCK_MS,
  prompt: "Add a line to README.md that says the smoke was here.",
  readmeLine: "smoke was here",
} as const;

/**
 * The M0 profiles' MCP allowlist: the builder's shipped tools. Their sessions are builders, and one
 * mounting none is admission's `no_tools`, since it could not write back.
 */
export const SMOKE_TOOLS = SHIPPED_ALLOWLISTS.builder;

/** The smoke's agents: `build` makes the change, `gated` holds a run open, `hang` never ends. */
export type SmokeAgent = "build" | "gated" | "hang";
const AGENT_IDS: Readonly<Record<SmokeAgent, string>> = {
  build: "smoke-build",
  gated: "smoke-gated",
  hang: "smoke-hang",
};
export const SMOKE_AGENTS = Object.keys(AGENT_IDS) as readonly SmokeAgent[];

/** A smoke agent's id, which is also its name: the `:agent` of the missions routes. */
export const agentId = (agent: SmokeAgent): string => AGENT_IDS[agent];

/** Every smoke agent's mission, saved as v1 over `POST /missions/:agent` once the API is up. */
export const MISSION: MissionText = {
  who_md: "A builder in the M0 smoke test.",
  what_md: "One README line.",
  how_md: "Edit README.md in the worktree.",
  laws_md: "Touch nothing else.",
};
/** A mission the smoke saves as v1: the agent's name and its text. */
export interface SmokeMission {
  readonly name: string;
  readonly text: MissionText;
}

/** The v1 save of `text`. */
export const missionRequest = (text: MissionText): MissionSaveRequest => ({
  ...text,
  note: "seeded by frm smoke",
  base_version: 0,
});
export const MISSION_REQUEST: MissionSaveRequest = missionRequest(MISSION);

/** The mission text of the agent named `name`, which its run 1 carries: the core template over
 * `text` (default MISSION). */
export const missionTextOf = (
  name: string,
  text: MissionText = MISSION,
): string => renderMission(name, text);

/** The hash the agent named `name` must carry: sha256 of its mission text. */
export const missionHashOf = (
  name: string,
  text: MissionText = MISSION,
): Promise<string> => sha256Hex(missionTextOf(name, text));

/** The hash a smoke agent's mission must carry. */
export const missionHash = (agent: SmokeAgent): Promise<string> =>
  missionHashOf(AGENT_IDS[agent]);

const usage = {
  tokens_in: 1_200,
  tokens_out: 340,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
};

/** One real README edit (appended before the events), the canonical sequence, and usage. */
export const BUILD_SCRIPT: FixtureScriptInput = {
  runs: [
    {
      appends: [{ path: "README.md", text: `${SMOKE.readmeLine}\n` }],
      events: [
        { kind: "turn_start", runner_type: "smoke.step", payload: {} },
        {
          kind: "tool_call",
          runner_type: "smoke.tool",
          tool_name: "edit",
          payload: { call_id: "call-1", input: { path: "README.md" } },
        },
        {
          kind: "tool_result",
          runner_type: "smoke.tool",
          tool_name: "edit",
          status: "ok",
          payload: { call_id: "call-1" },
        },
        {
          kind: "file_change",
          runner_type: "smoke.tool",
          payload: {
            path: "README.md",
            change: "modify",
            lines_added: 1,
            lines_removed: 0,
          },
        },
        { kind: "smoke_unknown", runner_type: "smoke.unknown", payload: {} },
        {
          kind: "turn_end",
          runner_type: "smoke.step",
          payload: { usage, stop_reason: "end_turn" },
        },
      ],
      spend: { ...usage, cost_usd: 0.0029 },
    },
  ],
};

/** The kinds BUILD_SCRIPT leaves in `events`, in order; its unknown kind is kept (Invariant 4). */
export const BUILD_SEQUENCE = [
  "session_init",
  "turn_start",
  "tool_call",
  "tool_result",
  "file_change",
  "runner_native",
  "turn_end",
  "terminal",
] as const;

/** A run that stops at its gate and stays open until interrupted. */
export const GATED_SCRIPT: FixtureScriptInput = {
  runs: [
    {
      events: [
        { kind: "turn_start", runner_type: "smoke.step", payload: {} },
        {
          kind: "assistant_text",
          runner_type: "smoke.text",
          text: "waiting at the gate",
          payload: {},
        },
      ],
      gate: "release",
    },
  ],
};
export const GATED_SEQUENCE = [
  "session_init",
  "turn_start",
  "assistant_text",
] as const;

/** A run that ignores interrupt and SIGTERM: only the run timer's kill ends it. */
export const HANG_SCRIPT: FixtureScriptInput = {
  runs: [
    {
      events: [{ kind: "turn_start", runner_type: "smoke.step", payload: {} }],
      then: "hard_hang",
    },
  ],
};

/** A `session.spawn` body for one of the smoke's agents. */
export function spawnRequest(
  agent: SmokeAgent,
  runnerId: string,
): SpawnRequest {
  return {
    agent_id: AGENT_IDS[agent],
    role: SMOKE.role,
    run_class: agent === "hang" ? SMOKE.hangRunClass : "build",
    workspace_id: SMOKE.workspace,
    runner_id: agent === "build" ? runnerId : FIXTURE_RUNNER_ID,
    executor_id: SMOKE.executor,
    prompt: SMOKE.prompt,
  };
}

export interface SmokeConfig {
  /** Rows with no runner or executor reference: seeded before the supervisor boots and loads them. */
  readonly beforeBoot: ConfigRows;
  /** Rows that reference the runners and the executor the supervisor upserts at boot. */
  readonly afterBoot: ConfigRows;
  /** The build agent's mission hash, which its run 1 must record (§8.1). */
  readonly missionHash: string;
}

/** A profile row: the sandbox flags carry a fixture script; the allowlist names its MCP tools. */
export async function profile(
  id: string,
  runnerId: string,
  tier: string,
  sandbox: Readonly<Record<string, unknown>>,
  now: number,
  toolAllowlist?: readonly string[],
) {
  const sandbox_json = JSON.stringify(sandbox);
  const tools =
    toolAllowlist === undefined
      ? {}
      : { tool_allowlist_json: JSON.stringify(toolAllowlist) };
  const content: JsonValue = {
    runner_id: runnerId,
    model_tier: tier,
    sandbox_json,
    ...tools,
  };
  const hash = await hashConfig(content);
  return {
    id,
    name: id,
    runner_id: runnerId,
    model_tier: tier,
    sandbox_json,
    ...tools,
    version: 1,
    hash,
    created_at: now,
  };
}

/**
 * The config for one smoke. The `build` agent uses `runnerId`; `gated` and `hang` always use the
 * fixture runner, whose script rides in the profile's sandbox flags (the runner row's defaults ⊕
 * permission ⊕ sandbox become SpawnSpec.flags). Agents start with no mission: the API sets
 * `agents.mission_id` when the smoke saves each one's v1.
 */
export async function smokeConfig(o: {
  readonly now: number;
  readonly repo: FixtureRepo;
  readonly runnerId: string;
}): Promise<SmokeConfig> {
  const fixture = o.runnerId === FIXTURE_RUNNER_ID;
  const tools = SMOKE_TOOLS;
  const profiles = [
    await profile(
      "smoke-build",
      o.runnerId,
      fixture ? "standard" : "cheap",
      fixture ? { script: BUILD_SCRIPT } : {},
      o.now,
      tools,
    ),
    await profile(
      "smoke-gated",
      FIXTURE_RUNNER_ID,
      "standard",
      { script: GATED_SCRIPT },
      o.now,
      tools,
    ),
    await profile(
      "smoke-hang",
      FIXTURE_RUNNER_ID,
      "standard",
      { script: HANG_SCRIPT },
      o.now,
      tools,
    ),
  ];
  const agents = SMOKE_AGENTS.map((agent) => ({
    id: AGENT_IDS[agent],
    name: AGENT_IDS[agent],
    kind: "builder" as const,
    runner_id: agent === "build" ? o.runnerId : FIXTURE_RUNNER_ID,
    executor_id: SMOKE.executor,
    profile_id: `smoke-${agent}`,
    workspace_id: SMOKE.workspace,
    created_at: o.now,
  }));
  return {
    missionHash: await missionHash("build"),
    beforeBoot: {
      repos: [
        {
          id: SMOKE.repo,
          name: SMOKE.repo,
          origin_url: o.repo.origin,
          mirror_path: o.repo.mirror,
          default_base_branch: BASE_BRANCH,
          doctrine_paths_json: JSON.stringify([DOCTRINE_PATH]),
        },
      ],
      run_classes: [
        {
          name: SMOKE.hangRunClass,
          context_tokens_cap: 25_000,
          max_turns: 120,
          max_tool_calls: 500,
          wall_clock_ms: SMOKE.hangWallClockMs,
          cost_cap_usd: 1,
          handoff_at_turns: 0,
          default_tier: "standard",
        },
      ],
      // The lifecycle's grace periods, short so a stop or a hang resolves in seconds.
      // No disk floor: the local executor measures this host's real disk under FRM_HOME
      //, and a smoke tests the fleet, not how full the operator's disk is. The floor
      // itself is covered by the health and admission tests. No nightly backup: its
      // catch-up would take one at boot, reading the operator's Keychain; the M4 smoke backs up
      // with a test key of its own.
      settings: {
        "lifecycle.interrupt_grace_ms": 1_000,
        "lifecycle.kill_grace_ms": 1_000,
        "admission.disk_min_free_pct": 0,
        "backup.enabled": 0,
      },
    },
    afterBoot: {
      workspaces: [
        {
          id: SMOKE.workspace,
          name: SMOKE.workspace,
          kind: "single",
          default_executor_id: SMOKE.executor,
        },
      ],
      workspace_repos: [
        {
          workspace_id: SMOKE.workspace,
          repo_id: SMOKE.repo,
          rel_path: SMOKE.relPath,
          role: "primary",
        },
      ],
      profiles,
      agents,
    },
  };
}
