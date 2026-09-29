import type { ConfigRows } from "@bayon/db/operator";
import {
  SHIPPED_ALLOWLISTS,
  type CreateTicketRequest,
  type SpawnRequest,
} from "@bayon/proto";
import {
  FIXTURE_RUNNER_ID,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { SMOKE, profile } from "./config.js";
import type { ExpectedCall } from "./m1-assertions.js";
import { parityRows } from "../parity-config.js";

// The M3 acceptance test's config (plan "M3 — Acceptance"): three non-trivial tickets, the fixture
// builders that work them (one session per step, each committing its work so a gate reviews HEAD),
// a fixture reviewer (heuristic, held to its FINDINGS sentinel) and the reviewer whose stand-in CLI
// declares outputSchema (schema mode, which code_review needs). No real model, no network.

export const M3 = {
  /** At the repo root: a `.md` path is a plan path (laws.plan_paths), so submit_plan's diff is clean. */
  planPath: "PLAN.md",
  /** The code the stand-in reviewer reads: its planted bug is `a - b`; the fix makes it `a + b`. */
  codePath: "add.js",
  /** Two complexity facts: score 6, tier complex, so non_trivial (plan_review and ce_review open). */
  complexity: { sensitive_data: true, concurrency: true },
  runClass: "build",
  /** gates.wall_clock_ms while the hanging review runs (step 8); the value before is put back. */
  hangWallClockMs: 3_000,
  resolveNote: "add() adds now: fixed in this session's commit.",
  qaOverride:
    "M3 smoke: no QA harness until M5, so the operator passes it with this note.",
  /** The stand-in reviewer passes a review whose prompt carries this; only plan_review's has the plan. */
  cleanReviewMarker: "frm-stub: clean review",
  agents: {
    spike: "smoke-m3-spike",
    build: "smoke-m3-build",
    fix: "smoke-m3-fix",
    qa: "smoke-m3-qa",
    spikeHang: "smoke-m3-spike-hang",
    spikeSame: "smoke-m3-spike-same",
    review: "smoke-m3-review",
    reviewSchema: "smoke-m3-review-schema",
  },
  /** A fixture reviewer's profile that never answers, bound for step 8 by `profile_id`. */
  reviewHangProfile: "smoke-m3-review-hang",
} as const;

/** No plan_path: each spike submits its own over MCP, no operator write sets it. */
const ticket = (title: string, body_md: string): CreateTicketRequest => ({
  title,
  type: "feature",
  body_md,
  workspace_id: SMOKE.workspace,
  complexity_facts: { ...M3.complexity },
});

/** T (steps 2–7), T2 (step 8) and T3 (step 9), as the operator files them. */
export const M3_TICKETS = {
  main: ticket(
    "M3 smoke: add() must add",
    `${M3.codePath}'s add(a, b) must return a + b. Plan it, build it, get it through review.`,
  ),
  hang: ticket(
    "M3 smoke: a plan review that never answers",
    "Its plan reviewer hangs: the gate times out and is retried once.",
  ),
  same: ticket(
    "M3 smoke: a plan reviewed on the builder's own runner",
    "Its plan reviewer shares the builder's runner, and the evidence says so.",
  ),
} as const;

const plan = (lines: readonly string[]): string =>
  `${["# Plan", "", ...lines].join("\n")}\n`;

/** Each ticket's plan, committed by its spike session at PLAN_PATH. */
export const PLANS = {
  main: plan([
    `1. ${M3.codePath} exports add(a, b), returning a + b.`,
    "2. Get it through code review, fixing what the review finds.",
    "",
    M3.cleanReviewMarker,
  ]),
  hang: plan(["Nothing to build: this plan's review is what is tested."]),
  same: plan(["Nothing to build: this plan's review is what is tested."]),
} as const;

/** add.js, with the planted bug (`-`) or fixed (`+`). */
export const addJs = (op: "-" | "+"): string =>
  `// Returns the sum of a and b.\nexport function add(a, b) {\n  return a ${op} b;\n}\n`;

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
const say = (text: string) => ({
  kind: "assistant_text",
  runner_type: "smoke.text",
  text,
  payload: {},
});

type RunInput = FixtureScriptInput["runs"][number];
type StepInput = NonNullable<RunInput["mcp"]>[number];

/** A clean heuristic review: no finding line, and the sentinel that says so. */
const cleanReview = (verdict: string): RunInput => ({
  events: [turnStart, say(`${verdict}\nFINDINGS: 0`), turnEnd],
});

/**
 * A builder's script: its one run, and the review ce_review asks of the builder's own agent
 * (§10.3). The reviewer works in a detached worktree at head, where add.js is committed; no builder
 * starts with it, each in a fresh worktree off the base.
 */
const builder = (run: RunInput): FixtureScriptInput => ({
  runs: [run],
  variants: [
    {
      exists: M3.codePath,
      runs: [cleanReview("Deep pass: add() is sound.")],
    },
  ],
});

/**
 * The hand-off run each phase session now writes: its `ticket_update` crosses a phase
 * boundary, so the API ships a `session.handoff` with the move and the supervisor starts this run
 * once the working turn has ended. Without it the stand-in's process would be gone before the
 * command was claimed and the packet would be degraded — a flake, not a finding (spike risk 4).
 *
 * Exported for step 10's T4 session, which ends a phase too. A session that crosses a
 * boundary without this run takes a second, unscripted run — which re-runs the working script,
 * commits again, and moves the HEAD its gate is pinned to out from under the smoke's assertion.
 */
export const handoffRun = (who: string): RunInput => ({
  events: [turnStart],
  mcp: [
    {
      tool: "handoff_write",
      args: {
        goal_line: `The ${who} phase is done; the next one takes it from here.`,
        decisions: [`${who}: as the ticket asked.`],
        traps: ["None found."],
        next_steps: [
          "Accept this hand-off.",
          "Read the ticket.",
          "Carry on from there.",
        ],
      },
    },
  ],
  events_after: [turnEnd],
});

/** A builder whose run ends a phase: its working run, then the hand-off the boundary asks for. */
const handingOff = (who: string, run: RunInput): FixtureScriptInput => {
  const base = builder(run);
  return { ...base, runs: [...base.runs, handoffRun(who)] };
};

const get = (
  ticketId: string,
  fields: Readonly<Record<string, string | number | boolean | null>>,
): StepInput => ({
  tool: "ticket_get",
  args: { ticket: ticketId },
  expect: { fields: { ...fields } },
  save: { v: "ticket.version" },
});

const move = (ticketId: string, status: string): StepInput => ({
  tool: "ticket_update",
  args: { ticket: ticketId, version: { $saved: "v" }, status },
  expect: { fields: { status } },
  save: { v: "version" },
});

/** submit_plan by the spike itself: its plan's path and the move in one call. */
const submitPlan = (ticketId: string): StepInput => ({
  tool: "ticket_update",
  args: {
    ticket: ticketId,
    version: { $saved: "v" },
    plan_path: M3.planPath,
    status: "plan_review",
  },
  expect: { fields: { status: "plan_review" } },
  save: { v: "version" },
});

/**
 * The spike: commits the plan, then start_spike, then submit_plan with its own plan_path (which
 * opens plan_review). The ticket was filed without one: no operator write sets it.
 */
export const spikeScript = (
  ticketId: string,
  text: string,
): FixtureScriptInput =>
  handingOff("spike", {
    appends: [{ path: M3.planPath, text }],
    commit: "plan: what this ticket builds",
    events: [turnStart],
    mcp: [
      get(ticketId, { "ticket.status": "staffed", "ticket.plan_path": null }),
      move(ticketId, "spiking"),
      submitPlan(ticketId),
    ],
    events_after: [turnEnd],
  });

/** The build: commits add.js with its bug, then request_review (round 1). */
export const buildScript = (ticketId: string): FixtureScriptInput =>
  handingOff("build", {
    appends: [{ path: M3.codePath, text: addJs("-") }],
    commit: "add(): a first cut",
    events: [turnStart],
    mcp: [
      get(ticketId, { "ticket.status": "building" }),
      move(ticketId, "code_review"),
    ],
    events_after: [turnEnd],
  });

/** The fix: commits add.js fixed, resolves round 1's finding by its id, then resubmits (round 2). */
export const fixScript = (ticketId: string): FixtureScriptInput =>
  handingOff("fix", {
    appends: [{ path: M3.codePath, text: addJs("+") }],
    commit: "add(): add, not subtract",
    events: [turnStart],
    mcp: [
      {
        tool: "ticket_get",
        args: { ticket: ticketId },
        expect: {
          fields: {
            "ticket.status": "review_fix",
            open_findings_total: 1,
            "open_findings.0.file": M3.codePath,
          },
        },
        save: { finding: "open_findings.0.id" },
      },
      {
        tool: "finding_resolve",
        args: { finding: { $saved: "finding" }, note: M3.resolveNote },
        expect: { fields: { status: "resolved" } },
      },
      get(ticketId, { "ticket.status": "review_fix", open_findings_total: 0 }),
      move(ticketId, "code_review"),
    ],
    events_after: [turnEnd],
  });

/** A worker trying pass_harness: until M5 only the operator's override with a note may. */
export const qaScript = (ticketId: string): FixtureScriptInput =>
  builder({
    events: [turnStart],
    mcp: [
      get(ticketId, { "ticket.status": "qa_harness" }),
      {
        tool: "ticket_update",
        args: {
          ticket: ticketId,
          version: { $saved: "v" },
          status: "qa_human",
        },
        expect: { refused: "missing_evidence" },
      },
    ],
    events_after: [turnEnd],
  });

const okCall = (tool: string): ExpectedCall => ({ tool, outcome: "ok" });

/**
 * Each builder session's mcp_call events, in order, across every run it makes. The three phase
 * sessions end with `handoff_write`: their status move crosses a phase boundary, which releases
 * them. B4 does not — its `ticket_update` is refused, so nothing moved and no phase
 * ended, and it is stopped by the operator as every M3 builder used to be.
 */
export const M3_CALLS = {
  spike: [
    okCall("ticket_get"),
    okCall("ticket_update"),
    okCall("ticket_update"),
    okCall("handoff_write"),
  ],
  build: [
    okCall("ticket_get"),
    okCall("ticket_update"),
    okCall("handoff_write"),
  ],
  fix: [
    okCall("ticket_get"),
    okCall("finding_resolve"),
    okCall("ticket_get"),
    okCall("ticket_update"),
    okCall("handoff_write"),
  ],
  qa: [
    okCall("ticket_get"),
    { tool: "ticket_update", outcome: "refused", reason: "missing_evidence" },
  ],
} as const satisfies Readonly<Record<string, readonly ExpectedCall[]>>;

/** The fixture reviewer's clean plan review, and the one that never answers. */
export const REVIEW_SCRIPT: FixtureScriptInput = {
  runs: [cleanReview("The plan is sound: no findings.")],
};
export const HANG_REVIEW_SCRIPT: FixtureScriptInput = {
  runs: [{ events: [turnStart], then: "hang" }],
};

export interface M3TicketIds {
  readonly main: string;
  readonly hang: string;
  readonly same: string;
}

/**
 * The builders (scripted on the filed tickets' ids), the fixture reviewer, the reviewer on the
 * runner whose stand-in declares outputSchema, and **the parity checker's own rows**; each with its
 * profile. Seeded once T, T2 and T3 exist, as the M1 smoke seeds its agent after ticket A.
 *
 * The parity checker rides here because this is the gate engine's fleet: its rows are
 * operator config like every other agent's, and until something seeds them `chooseParityJob` finds
 * no enabled `kind='util'` agent and every `parity_check` fails `no_reviewer` — a gate that cannot
 * be decided, which is exactly what the default-off switch exists to postpone, not to hide.
 */
export async function m3Rows(o: {
  readonly now: number;
  readonly tickets: M3TicketIds;
  readonly schemaRunner: string;
  /** FRM_HOME, which the parity job's profile carries into the child's env. */
  readonly home: string;
}): Promise<ConfigRows> {
  const parity = await parityRows({ now: o.now, home: o.home });
  const a = M3.agents;
  const builders: readonly (readonly [string, FixtureScriptInput])[] = [
    [a.spike, spikeScript(o.tickets.main, PLANS.main)],
    [a.build, buildScript(o.tickets.main)],
    [a.fix, fixScript(o.tickets.main)],
    [a.qa, qaScript(o.tickets.main)],
    [a.spikeHang, spikeScript(o.tickets.hang, PLANS.hang)],
    [a.spikeSame, spikeScript(o.tickets.same, PLANS.same)],
  ];
  const reviewer = (
    id: string,
    runnerId: string,
    tier: string,
    sandbox: Readonly<Record<string, unknown>>,
  ) => profile(id, runnerId, tier, sandbox, o.now, SHIPPED_ALLOWLISTS.reviewer);
  const profiles = [
    ...(await Promise.all(
      builders.map(([id, script]) =>
        profile(
          id,
          FIXTURE_RUNNER_ID,
          "standard",
          { script },
          o.now,
          SHIPPED_ALLOWLISTS.builder,
        ),
      ),
    )),
    await reviewer(a.review, FIXTURE_RUNNER_ID, "standard", {
      script: REVIEW_SCRIPT,
    }),
    await reviewer(M3.reviewHangProfile, FIXTURE_RUNNER_ID, "standard", {
      script: HANG_REVIEW_SCRIPT,
    }),
    // The runner's own defaults; the cheapest tier every registration prices.
    await reviewer(a.reviewSchema, o.schemaRunner, "cheap", {}),
  ];
  const agent = (
    id: string,
    kind: "builder" | "reviewer",
    runnerId: string,
    workspaceId: string | null,
  ) => ({
    id,
    name: id,
    kind,
    runner_id: runnerId,
    executor_id: SMOKE.executor,
    profile_id: id,
    workspace_id: workspaceId,
    created_at: o.now,
  });
  return {
    run_classes: parity.run_classes ?? [],
    profiles: [...profiles, ...(parity.profiles ?? [])],
    agents: [
      ...builders.map(([id]) =>
        agent(id, "builder", FIXTURE_RUNNER_ID, SMOKE.workspace),
      ),
      agent(a.review, "reviewer", FIXTURE_RUNNER_ID, null),
      agent(a.reviewSchema, "reviewer", o.schemaRunner, null),
      ...(parity.agents ?? []),
    ],
  };
}

/** `POST /sessions` for one builder step on its ticket: a fresh worktree off the base. */
export const builderSpawn = (
  agent: string,
  ticketId: string,
  /** The multi-repo workspace for step 10's T4; the single one for everything else. */
  workspaceId: string = SMOKE.workspace,
): SpawnRequest => ({
  agent_id: agent,
  role: "builder",
  run_class: M3.runClass,
  workspace_id: workspaceId,
  runner_id: FIXTURE_RUNNER_ID,
  executor_id: SMOKE.executor,
  prompt: `Take your step on ticket ${ticketId}.`,
  ticket_id: ticketId,
});
