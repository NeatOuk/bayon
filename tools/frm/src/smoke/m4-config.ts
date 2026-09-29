import { FIXTURE_RUNNER_ID } from "@bayon/runners/fixture";
import type { FixtureScriptInput } from "@bayon/runners/fixture";
import type { SpawnRequest } from "@bayon/proto";
import {
  SMOKE,
  SMOKE_TOOLS,
  missionHash,
  profile,
  type SmokeConfig,
} from "./config.js";
import {
  BASE_BRANCH,
  DOCTRINE_PATH,
  type FixtureRepo,
} from "./fixture-repo.js";

// `frm smoke --m4` (spec §16): the M4 acceptance test — "you can pull the host's plug and
// lose only in-flight turns". Its own agents, because the M0 smoke's three are shaped for one
// session at a time: M4 needs several alive at once, one holding a run open across a SIGKILL, one
// leaving its worktree dirty, and one queued behind a slot cap so the restart has something to
// re-admit.

/** The M4 agents, by what each one is for in the plug cycle. */
export const M4 = {
  /** Holds a run open at its gate: killed mid-turn, it is the session that must be adopted. */
  held: "m4-held",
  /**
   * Ends its run and idles: adopted across the plug with no run to interrupt. A second session for
   * this same agent is what queues — 012's `max_concurrency` is 1, so it waits on `concurrency`
   * until the idle one ends, which is the mechanism plug.test.ts already proves. Queueing this way
   * rather than on the executor's slots keeps the smoke independent of LOCAL_EXECUTOR_SLOTS, a
   * constant in the supervisor's boot rather than anything an operator config can set.
   */
  idle: "m4-idle",
  /** Leaves an uncommitted edit behind: its worktree is the one the sweep must keep. */
  dirty: "m4-dirty",
} as const;
export type M4Agent = (typeof M4)[keyof typeof M4];

/** The daily cap the budget phase starts at: under one run's cost, so the next spawn is queued. */
export const M4_TINY_CAP_USD = 0.0001;
/** The cap the budget phase raises to, comfortably over what the smoke's runs cost. */
export const M4_RAISED_CAP_USD = 100;

const usage = {
  tokens_in: 400,
  tokens_out: 120,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
};

const turn = [
  { kind: "turn_start", runner_type: "smoke.step", payload: {} },
  {
    kind: "turn_end",
    runner_type: "smoke.step",
    payload: { usage, stop_reason: "end_turn" },
  },
];

/** Runs to its terminal and idles, committing its edit: a clean worktree the sweep may remove. */
export const M4_IDLE_SCRIPT: FixtureScriptInput = {
  runs: [
    {
      appends: [{ path: "README.md", text: "m4 idle\n" }],
      commit: "m4: the idle session's change",
      events: turn,
      spend: { ...usage, cost_usd: 0.002 },
    },
  ],
};

/**
 * Holds its run open at the gate until released or interrupted. Killed there, its run is the
 * in-flight turn M4 is allowed to lose: `interrupted`, then the session adopted.
 */
export const M4_HELD_SCRIPT: FixtureScriptInput = {
  runs: [
    {
      events: [
        { kind: "turn_start", runner_type: "smoke.step", payload: {} },
        {
          kind: "assistant_text",
          runner_type: "smoke.text",
          text: "holding the turn open",
          payload: {},
        },
      ],
      gate: "release",
    },
  ],
};

/**
 * Appends without committing, so the change stays in the working tree. A dirty worktree is work in
 * progress: the sweep keeps it (Invariant: "Deleting a dirty worktree to tidy up → never").
 */
export const M4_DIRTY_SCRIPT: FixtureScriptInput = {
  runs: [
    {
      appends: [{ path: "README.md", text: "m4 uncommitted\n" }],
      events: turn,
      spend: { ...usage, cost_usd: 0.002 },
    },
  ],
};

/** A `session.spawn` body for one of M4's agents; every one runs the fixture runner on local. */
export const m4Spawn = (agent: M4Agent): SpawnRequest => ({
  agent_id: agent,
  role: SMOKE.role,
  run_class: "build",
  workspace_id: SMOKE.workspace,
  runner_id: FIXTURE_RUNNER_ID,
  executor_id: SMOKE.executor,
  prompt: SMOKE.prompt,
});

const SCRIPTS: Readonly<Record<M4Agent, FixtureScriptInput>> = {
  [M4.held]: M4_HELD_SCRIPT,
  [M4.idle]: M4_IDLE_SCRIPT,
  [M4.dirty]: M4_DIRTY_SCRIPT,
};

/**
 * M4's own config: the M0 smoke's repo and workspace, its four agents, and the settings the plug
 * cycle needs — `idle` and `queued` share one concurrency place so a spawn queues, and the local
 * executor gets M4_SLOTS places so the other three run at once.
 */
export async function m4Config(o: {
  readonly now: number;
  readonly repo: FixtureRepo;
  readonly runnerId: string;
}): Promise<SmokeConfig> {
  const agents = Object.values(M4).map((agent) => ({
    id: agent,
    name: agent,
    kind: "builder" as const,
    runner_id: FIXTURE_RUNNER_ID,
    executor_id: SMOKE.executor,
    profile_id: `profile-${agent}`,
    workspace_id: SMOKE.workspace,
    created_at: o.now,
    // One place each (012's default): a second session for the same agent queues on `concurrency`.
    max_concurrency: 1,
  }));
  const profiles = await Promise.all(
    Object.values(M4).map((agent) =>
      profile(
        `profile-${agent}`,
        FIXTURE_RUNNER_ID,
        "standard",
        { script: SCRIPTS[agent] },
        o.now,
        // Without an allowlist admission refuses the spawn (`no_tools`): a session that cannot
        // call a single MCP tool could never write anything back.
        SMOKE_TOOLS,
      ),
    ),
  );
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
      settings: {
        // Short graces: a plug cycle kills process groups outright, and what survives it should be
        // reaped in seconds rather than held by a grace the smoke would only wait out.
        "lifecycle.interrupt_grace_ms": 1_000,
        "lifecycle.kill_grace_ms": 1_000,
        // The local executor measures this host's real disk; a smoke tests the fleet,
        // not how full the operator's disk is. The floor has its own tests.
        "admission.disk_min_free_pct": 0,
        // No nightly backup: its catch-up would take one at boot from the operator's Keychain.
        // The backup phase writes its own with a test key instead.
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
