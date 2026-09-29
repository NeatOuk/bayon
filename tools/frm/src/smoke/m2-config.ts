import {
  DEFAULT_RUN_CLASSES,
  type JsonValue,
  type MissionText,
} from "@bayon/core";
import type { ConfigRows } from "@bayon/db/operator";
import { SHIPPED_ALLOWLISTS, type CreateTicketRequest } from "@bayon/proto";
import {
  FIXTURE_RUNNER_ID,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { M2_PULSE_INTERVAL_MS } from "./budget.js";
import {
  SMOKE,
  profile,
  smokeConfig,
  type SmokeConfig,
  type SmokeMission,
} from "./config.js";
import type { FixtureRepo } from "./fixture-repo.js";

// The M2 acceptance test's config (plan "M2 — Acceptance"): an orchestrator that pulses on a
// 20 s hybrid policy, one builder, the staffed run class handing off at a turn ceiling, and ticket
// T. On the fixture runner both agents are scripted; with a real runner they are models.

export const M2 = {
  orch: "smoke-orch",
  builder: "smoke-m2-builder",
  /** What staffing runs a prioritized or staffed ticket as (core staffPlan): hands off early here. */
  runClass: "spike",
  handoffAtTurns: { fixture: 3, real: 2 },
  /** budget.daily_cap_usd: staffing and the pulse gate check it (M2 amendment f). */
  dailyCapUsd: 2,
  pulse: {
    mode: "hybrid",
    interval_ms: M2_PULSE_INTERVAL_MS,
    debounce_ms: 1_000,
    min_gap_ms: 2_000,
    // The trailing-hour cap must never bind inside the smoke: a slow host runs a cron pulse every
    // 20 s while a successor's spawn is queued, and a bound cap defers the next wake by up to an
    // hour. The smoke's deadline allows at most ~50 wakes; 60 is out of reach.
    max_per_hour: 60,
    jitter_pct: 0,
  },
  /** The pulse run class's context cap (002): every pulse's context pack fits it. */
  packCapTokens: 6_000,
  title: "M2 smoke: the hand-off chain ticket",
  /** A word of the title: the orchestrator's ticket_search finds T by it. */
  searchWord: "chain",
  /** The file the builders append to: S1 creates it, S2 finds it in the inherited worktree. */
  notes: "M2-SMOKE.md",
  blockedReason: "smoke: the chain is complete",
  unblockCondition: "the operator reviews the chain",
} as const;

/** A hand-off packet's path in the worktree. */
export const packetPath = (n: number): string => `.foreman/handoff-${n}.md`;

const FIXTURE_BODY =
  "The M2 smoke's ticket: four fixture sessions take it over in turn, and the last one blocks it.";
const REAL_BODY = [
  "Docs-only: this ticket is foreman's M2 smoke check.",
  "If you were handed a hand-off packet, call handoff_accept with no arguments first.",
  `Then append one line to ${M2.notes} saying which session of the chain you are. Change no other file.`,
  `If the packet you were handed is handoff-2, the chain is done: after accepting it, block this ticket with ticket_update (status "blocked", blocked_reason "${M2.blockedReason}", unblock_condition "${M2.unblockCondition}") and stop.`,
].join("\n\n");

/** Ticket T, as the operator files it (then prioritizes it: the last operator write). */
export const m2Ticket = (real: boolean): CreateTicketRequest => ({
  title: M2.title,
  type: "docs",
  body_md: real ? REAL_BODY : FIXTURE_BODY,
});

const usage = {
  tokens_in: 400,
  tokens_out: 80,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
};
const turnStart = {
  kind: "turn_start",
  runner_type: "smoke.step",
  payload: {},
};
const turnEnd = {
  kind: "turn_end",
  runner_type: "smoke.step",
  payload: { usage, stop_reason: "end_turn" },
};

/**
 * One pulse: find T, staff it (refused once T is blocked or already worked: the pulse still
 * reports), then report. Every pulse is a fresh session, so every one runs this. It names T as
 * `#1`, as a model reading a pulse pack does; the search checks T is ticket 1.
 */
export const ORCH_SCRIPT: FixtureScriptInput = {
  runs: [
    {
      events: [turnStart],
      mcp: [
        {
          tool: "ticket_search",
          args: { q: M2.searchWord },
          expect: { fields: { "rows.0.title": M2.title, "rows.0.num": 1 } },
        },
        {
          tool: "ticket_staff",
          args: { ticket: "#1", role: "builder" },
          expect: { refusal_ok: true },
        },
        {
          tool: "pulse_report",
          args: {
            summary_md: "Looked for the chain ticket and asked to staff it.",
            actions: ["ticket_staff(chain ticket, builder)"],
          },
        },
      ],
      events_after: [turnEnd],
    },
  ],
};

type RunInput = FixtureScriptInput["runs"][number];
type StepInput = NonNullable<RunInput["mcp"]>[number];

const accept: StepInput = {
  tool: "handoff_accept",
  expect: { fields: { created: true } },
};

/** The hand-off run (run 2): the judgement, one turn, then its terminal. */
const handoffRun = (who: string): RunInput => ({
  events: [turnStart],
  mcp: [
    {
      tool: "handoff_write",
      args: {
        goal_line: `Finish the chain ticket that ${who} worked.`,
        decisions: [`${who} kept to ${M2.notes}.`],
        traps: ["None found."],
        next_steps: [
          "Accept this hand-off.",
          `Read ${M2.notes}.`,
          "Carry on from there.",
        ],
      },
    },
  ],
  events_after: [turnEnd],
});

/** S1: claims T, writes the notes file, reaches the turn ceiling at its gate; run 2 hands off. */
const s1: RunInput = {
  appends: [{ path: M2.notes, text: "S1 took the ticket\n" }],
  events: [turnStart],
  mcp: [{ ...accept, expect: { fields: { created: true, handoff_id: null } } }],
  events_after: [turnEnd, turnStart, turnEnd, turnStart, turnEnd],
  gate: "release",
};

/**
 * S2: accepts handoff-1 by the label its packet header shows, adds to S1's file, asks
 * to hand off at its gate; run 2 hands off.
 */
const s2: RunInput = {
  appends: [{ path: M2.notes, text: "S2 continued from handoff-1\n" }],
  events: [turnStart],
  mcp: [
    { ...accept, args: { id: "handoff-1" } },
    {
      tool: "handoff_request",
      args: { note: "the M2 smoke asks for a hand-off" },
      expect: { fields: { created: true } },
    },
  ],
  events_after: [turnEnd],
  gate: "release",
};

/** S3: accepts handoff-2, edits README, holds at its gate until the smoke SIGKILLs it. */
const s3: RunInput = {
  appends: [{ path: "README.md", text: "S3 was here when it died\n" }],
  events: [turnStart],
  mcp: [accept],
  events_after: [turnEnd],
  gate: "release",
};

/** S4: accepts handoff-3 (degraded), then blocks T. */
const s4: RunInput = {
  events: [turnStart],
  mcp: [
    { ...accept, save: { ticket: "ticket_id" } },
    {
      tool: "ticket_get",
      args: { ticket: { $saved: "ticket" } },
      save: { version: "ticket.version" },
    },
    {
      tool: "ticket_update",
      args: {
        ticket: { $saved: "ticket" },
        version: { $saved: "version" },
        status: "blocked",
        blocked_reason: M2.blockedReason,
        unblock_condition: M2.unblockCondition,
      },
    },
  ],
  events_after: [turnEnd],
};

/**
 * The builder: one profile for all four sessions. Each successor works in the worktree it
 * inherits, so the packets there say which it is; a resumed process crashes (S3's adoption).
 */
export const BUILDER_SCRIPT: FixtureScriptInput = {
  crash_on_resume: true,
  runs: [s1, handoffRun("S1")],
  variants: [
    { exists: packetPath(3), runs: [s4] },
    { exists: packetPath(2), runs: [s3] },
    { exists: packetPath(1), runs: [s2, handoffRun("S2")] },
  ],
};

/** The staffed run class, handing off at the ceiling for this runner. */
export const staffedClass = (real: boolean) =>
  DEFAULT_RUN_CLASSES.filter((c) => c.name === M2.runClass).map((c) => ({
    ...c,
    handoff_at_turns: real ? M2.handoffAtTurns.real : M2.handoffAtTurns.fixture,
  }));

/** The tunables the chain needs; a real runner keeps the default interrupt and kill graces. */
export const m2Settings = (real: boolean): Record<string, JsonValue> => ({
  "budget.daily_cap_usd": M2.dailyCapUsd,
  // S3 is adopted once (its resume crashes), then marked dead: the degraded packet.
  "lifecycle.adopt_max": 1,
  "reconciler.interval_ms": 1_000,
  ...(real
    ? {
        "lifecycle.interrupt_grace_ms": 10_000,
        "lifecycle.kill_grace_ms": 5_000,
      }
    : {}),
});

/** The orchestrator and the builder, with their profiles (scripts on the fixture runner). */
export async function m2Rows(o: {
  readonly now: number;
  readonly runnerId: string;
}): Promise<Pick<ConfigRows, "profiles" | "agents">> {
  const fixture = o.runnerId === FIXTURE_RUNNER_ID;
  const tier = fixture ? "standard" : "cheap";
  const sandbox = (script: FixtureScriptInput) => (fixture ? { script } : {});
  return {
    profiles: [
      await profile(
        M2.orch,
        o.runnerId,
        tier,
        sandbox(ORCH_SCRIPT),
        o.now,
        SHIPPED_ALLOWLISTS.orchestrator,
      ),
      await profile(
        M2.builder,
        o.runnerId,
        tier,
        sandbox(BUILDER_SCRIPT),
        o.now,
        SHIPPED_ALLOWLISTS.builder,
      ),
    ],
    agents: [
      {
        id: M2.orch,
        name: M2.orch,
        kind: "orchestrator",
        runner_id: o.runnerId,
        executor_id: SMOKE.executor,
        profile_id: M2.orch,
        workspace_id: null,
        pulse_mode: M2.pulse.mode,
        pulse_interval_ms: M2.pulse.interval_ms,
        pulse_debounce_ms: M2.pulse.debounce_ms,
        pulse_min_gap_ms: M2.pulse.min_gap_ms,
        pulse_max_per_hour: M2.pulse.max_per_hour,
        pulse_jitter_pct: M2.pulse.jitter_pct,
        created_at: o.now,
      },
      {
        id: M2.builder,
        name: M2.builder,
        kind: "builder",
        runner_id: o.runnerId,
        executor_id: SMOKE.executor,
        profile_id: M2.builder,
        workspace_id: SMOKE.workspace,
        max_concurrency: 1,
        created_at: o.now,
      },
    ],
  };
}

/** The M0 smoke's repo and workspace with M2's agents in place of M0's, and M2's tunables. */
export async function m2Config(o: {
  readonly now: number;
  readonly repo: FixtureRepo;
  readonly runnerId: string;
}): Promise<SmokeConfig> {
  const base = await smokeConfig(o);
  const real = o.runnerId !== FIXTURE_RUNNER_ID;
  return {
    missionHash: base.missionHash,
    beforeBoot: {
      ...base.beforeBoot,
      run_classes: [
        ...(base.beforeBoot.run_classes ?? []),
        ...staffedClass(real),
      ],
      settings: { ...base.beforeBoot.settings, ...m2Settings(real) },
    },
    afterBoot: { ...base.afterBoot, ...(await m2Rows(o)) },
  };
}

/**
 * The orchestrator's own mission: with the builders' README mission, a real model read
 * the ticket's work as its own. It routes, staffs and escalates; the builders do the work.
 */
export const ORCH_MISSION: MissionText = {
  who_md: "The orchestrator of foreman's M2 smoke check.",
  what_md:
    "Route the chain ticket through its hand-offs: staff it, and staff a successor for every pending hand-off.",
  how_md:
    "Route, staff and escalate through your MCP tools: ticket_staff (role builder), human_ask when stuck, pulse_report every pulse. Builders do the ticket's work.",
  laws_md:
    "Never do ticket work yourself: you have no file or shell tools, by design. Never change a ticket's status or block it on a worker's behalf.",
};

/**
 * The builders' mission, as T's real body asks: one line to the notes file, no other
 * file. It replaces the M0 smoke's README mission, which contradicted T.
 */
export const BUILDER_MISSION: MissionText = {
  who_md:
    "A builder in foreman's M2 smoke check: one session of the chain ticket's hand-off chain.",
  what_md: `Record your place in the chain: append one line to ${M2.notes} saying which session of the chain you are.`,
  how_md:
    "If you were handed a hand-off packet, call handoff_accept with no arguments first. Then follow the ticket's body.",
  laws_md: `Change no other file than ${M2.notes}.`,
};

/** The agents whose mission v1 the smoke saves over REST, before T. */
export const M2_MISSIONS: readonly SmokeMission[] = [
  { name: M2.orch, text: ORCH_MISSION },
  { name: M2.builder, text: BUILDER_MISSION },
];
