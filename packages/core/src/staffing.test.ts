import { describe, expect, test } from "vitest";
import { TICKET_STATUSES } from "./laws/statuses.js";
import { SessionState } from "./states.js";
import {
  AWAITING_STATUSES,
  HELD_STATUSES,
  RELEASABLE_HOLDER_STATES,
  STAFFABLE_STATUSES,
  agentUnfit,
  phaseBoundary,
  pickAgent,
  staffPlan,
  staffPlanFor,
  staleHolder,
  type StaffCandidate,
} from "./staffing.js";

describe("staffPlan: the run class from the ticket status (amendment h)", () => {
  test.each([
    ["prioritized", "standard", { transition: true, runClass: "spike" }],
    ["staffed", "complex", { transition: false, runClass: "spike" }],
    ["spiking", "cheap", { transition: false, runClass: "spike" }],
    ["planned", "standard", { transition: false, runClass: "build" }],
    ["building", "cheap", { transition: false, runClass: "build" }],
    ["building", "complex", { transition: false, runClass: "build_complex" }],
    ["rework", "complex", { transition: false, runClass: "build_complex" }],
    ["planned", "complex", { transition: false, runClass: "build_complex" }],
    ["review_fix", "complex", { transition: false, runClass: "fix" }],
  ] as const)("%s (%s) → %o", (status, tier, plan) => {
    expect(staffPlan(status, tier)).toEqual(plan);
  });

  test("every other status is not staffable", () => {
    for (const status of TICKET_STATUSES) {
      const staffable = (STAFFABLE_STATUSES as readonly string[]).includes(
        status,
      );
      expect(staffPlan(status, "standard") !== null, status).toBe(staffable);
    }
  });
});

describe("staffPlanFor: a pending hand-off makes its ticket staffable whatever the legacy status (plan rule 3)", () => {
  const pending = { runClass: "build" };

  test("handoff_pending and other unstaffable statuses take the predecessor's run class, with no move", () => {
    for (const status of ["handoff_pending", "backlog"] as const) {
      expect(staffPlanFor(status, "standard", pending), status).toEqual({
        transition: false,
        runClass: "build",
      });
    }
  });

  // Pre-existing bug, not one the phase-boundary hand-off introduced: a session dying
  // mid-code_review has always left a degraded row with exactly this effect. Phase-change hand-offs
  // only make it routine, which is why it is fixed here.
  test("a waiting room is not reopened: the predecessor's class is the wrong answer there", () => {
    for (const status of AWAITING_STATUSES) {
      expect(staffPlanFor(status, "standard", pending), status).toBeNull();
      // And without a hand-off it was already null, so nothing else moved.
      expect(staffPlanFor(status, "standard", null), status).toBeNull();
    }
  });

  test("AWAITING_STATUSES are exactly the review rooms, and never a held or staffable status", () => {
    expect(AWAITING_STATUSES).toEqual([
      "plan_review",
      "code_review",
      "qa_harness",
      "qa_human",
    ]);
    for (const status of AWAITING_STATUSES) {
      expect(TICKET_STATUSES, status).toContain(status);
      expect(HELD_STATUSES, status).not.toContain(status);
      expect(STAFFABLE_STATUSES as readonly string[], status).not.toContain(
        status,
      );
    }
  });

  test("a staffable status keeps its own plan", () => {
    expect(staffPlanFor("staffed", "standard", pending)).toEqual({
      transition: false,
      runClass: "spike",
    });
  });

  test("a closed or held ticket stays unstaffable", () => {
    for (const status of [
      "done",
      "rejected",
      "blocked",
      "parked",
      "split",
    ] as const) {
      expect(staffPlanFor(status, "standard", pending), status).toBeNull();
    }
  });

  test("without a pending hand-off it is staffPlan", () => {
    for (const status of TICKET_STATUSES) {
      expect(staffPlanFor(status, "complex", null), status).toEqual(
        staffPlan(status, "complex"),
      );
    }
  });
});

//, decision 1: a phase boundary is derived from staffPlan, never enumerated, so the two
// cannot drift. Every row here is an edge of the §3.2 table (packages/core/src/laws/table.ts).
describe("phaseBoundary: where a session's phase ends (§7.1)", () => {
  test.each([
    // edge, the session's class, the status the move LANDED on, the phase it hands on to
    ["submit_plan", "spike", "plan_review", null],
    // trivial ticket: submit_plan carries it past plan_review to planned. Judging the
    // edge's nominal `to` instead of the landed status strands exactly this ticket.
    ["submit_plan (advance)", "spike", "planned", "build"],
    ["request_review", "build", "code_review", null],
    ["resubmit", "fix", "code_review", null],
    ["ask_human", "build", "prioritized", "spike"],
    ["pass_review", "build", "qa_harness", null],
  ] as const)("%s is a boundary", (_edge, runClass, landed, to) => {
    expect(phaseBoundary(runClass, landed, "standard")).toEqual({ to });
  });

  test.each([
    ["start_build", "build", "planned"],
    ["rebuild", "build", "rework"],
    ["revise_plan", "spike", "spiking"],
    ["staff", "spike", "staffed"],
  ] as const)("%s is not", (_edge, runClass, landed) => {
    expect(phaseBoundary(runClass, landed, "standard")).toBeNull();
  });

  test("it is exactly staffPlan's answer, for every status and every run class", () => {
    const classes = ["spike", "build", "build_complex", "fix", "review"];
    for (const status of TICKET_STATUSES) {
      for (const tier of ["cheap", "standard", "complex"]) {
        const asked = staffPlan(status, tier)?.runClass ?? null;
        for (const runClass of classes) {
          expect(
            phaseBoundary(runClass, status, tier),
            `${status} ${tier} ${runClass}`,
          ).toEqual(asked === runClass ? null : { to: asked });
        }
      }
    }
  });

  test("a complex ticket's build phase is build_complex, so the tier decides the boundary", () => {
    expect(phaseBoundary("build", "planned", "complex")).toEqual({
      to: "build_complex",
    });
    expect(phaseBoundary("build_complex", "planned", "complex")).toBeNull();
    expect(phaseBoundary("build_complex", "planned", "standard")).toEqual({
      to: "build",
    });
  });
});

const agent = (
  o: Partial<StaffCandidate> & { id: string },
): StaffCandidate => ({
  kind: "builder",
  runner_id: "r1",
  enabled: true,
  max_concurrency: 1,
  created_at: 10,
  busy: 0,
  ...o,
});

describe("pickAgent: role_bindings[role], else the oldest enabled agent below max_concurrency", () => {
  test("no binding: the oldest free agent of the role, ties broken by id", () => {
    const agents = [
      agent({ id: "b", created_at: 5 }),
      agent({ id: "a", created_at: 5 }),
      agent({ id: "old", created_at: 1, kind: "reviewer" }),
      agent({ id: "young", created_at: 9 }),
    ];
    expect(pickAgent("builder", null, agents, "fleet")?.id).toBe("a");
    expect(pickAgent("reviewer", null, agents, "fleet")?.id).toBe("old");
    expect(pickAgent("investigator", null, agents, "fleet")).toBeNull();
  });

  test("a disabled agent is skipped", () => {
    const agents = [
      agent({ id: "off", created_at: 1, enabled: false }),
      agent({ id: "on", created_at: 2 }),
    ];
    expect(pickAgent("builder", null, agents, "fleet")?.id).toBe("on");
    expect(
      pickAgent("builder", null, [agents[0] as StaffCandidate], "fleet"),
    ).toBeNull();
  });

  test("an agent at max_concurrency is skipped; below it is free", () => {
    const full = agent({
      id: "full",
      created_at: 1,
      busy: 2,
      max_concurrency: 2,
    });
    const room = agent({
      id: "room",
      created_at: 2,
      busy: 1,
      max_concurrency: 2,
    });
    expect(pickAgent("builder", null, [full, room], "fleet")?.id).toBe("room");
    expect(pickAgent("builder", null, [full], "fleet")).toBeNull();
  });

  test("a binding picks its runner's agent over an older one elsewhere", () => {
    const agents = [
      agent({ id: "r1-old", created_at: 1, runner_id: "r1" }),
      agent({ id: "r2", created_at: 2, runner_id: "r2" }),
    ];
    const binding = { runner_id: "r2", fallback_runner_id: null };
    expect(pickAgent("builder", binding, agents, "fleet")?.id).toBe("r2");
  });

  test("a bound runner with no free agent falls back to the fallback runner, never further", () => {
    const agents = [
      agent({ id: "r2", created_at: 1, runner_id: "r2", busy: 1 }),
      agent({ id: "r3", created_at: 2, runner_id: "r3" }),
      agent({ id: "r1", created_at: 0, runner_id: "r1" }),
    ];
    expect(
      pickAgent(
        "builder",
        { runner_id: "r2", fallback_runner_id: "r3" },
        agents,
        "fleet",
      )?.id,
    ).toBe("r3");
    expect(
      pickAgent(
        "builder",
        { runner_id: "r2", fallback_runner_id: null },
        agents,
        "fleet",
      ),
    ).toBeNull();
  });
});

// a project's own agents are the operator's runner choice (§9.8), so a project may mix
// runners — a builder on runner-a and one on runner-b — and the global binding does not narrow them.
describe("pickAgent in a project's scope: the oldest free agent, whatever its runner", () => {
  const mixed = [
    agent({ id: "on-a", created_at: 1, runner_id: "runner-a" }),
    agent({ id: "on-b", created_at: 2, runner_id: "runner-b" }),
  ];
  const boundToB = { runner_id: "runner-b", fallback_runner_id: null };

  test("the oldest free agent wins over the binding's runner", () => {
    expect(pickAgent("builder", boundToB, mixed, "project")?.id).toBe("on-a");
    expect(pickAgent("builder", null, mixed, "project")?.id).toBe("on-a");
  });

  test("a busy oldest agent passes to the next free one on another runner", () => {
    const busyA = [
      agent({ id: "on-a", created_at: 1, runner_id: "runner-a", busy: 1 }),
      agent({ id: "on-b", created_at: 2, runner_id: "runner-b" }),
    ];
    const boundToA = { runner_id: "runner-a", fallback_runner_id: null };
    expect(pickAgent("builder", boundToA, busyA, "project")?.id).toBe("on-b");
  });

  test("disabled and full agents are still skipped; none free is null", () => {
    const none = [
      agent({ id: "on-a", runner_id: "runner-a", enabled: false }),
      agent({ id: "on-b", runner_id: "runner-b", busy: 1 }),
    ];
    expect(pickAgent("builder", boundToB, none, "project")).toBeNull();
  });

  test("the same agents in the fleet's scope still honour the binding", () => {
    expect(pickAgent("builder", boundToB, mixed, "fleet")?.id).toBe("on-b");
    expect(
      pickAgent(
        "builder",
        { runner_id: "runner-c", fallback_runner_id: null },
        mixed,
        "fleet",
      ),
    ).toBeNull();
  });
});

describe("agentUnfit: why a named agent cannot take a session now", () => {
  test.each<[string, Partial<StaffCandidate>, string | null]>([
    ["free", {}, null],
    ["a slot left", { busy: 1, max_concurrency: 2 }, null],
    [
      "another kind",
      { kind: "reviewer" },
      "agent x is a reviewer, not a builder",
    ],
    ["disabled", { enabled: false }, "agent x is disabled"],
    [
      "every slot held",
      { busy: 2, max_concurrency: 2 },
      "agent x is at its max_concurrency (2)",
    ],
  ])("%s", (_, o, why) => {
    expect(agentUnfit("builder", agent({ id: "x", ...o }))).toBe(why);
  });
});

describe("staleHolder: the silence rule staffing's release is allowed to act on", () => {
  const NOW = 1_700_000_000_000;
  const SILENT = 1_800_000;
  const holder = (o: Partial<Parameters<typeof staleHolder>[0]> = {}) => ({
    state: "running" as const,
    last_event_at: NOW - SILENT,
    ...o,
  });

  test("silent for exactly the threshold is stale; a millisecond less is not", () => {
    expect(staleHolder(holder(), NOW, SILENT)).toBe(true);
    expect(
      staleHolder(holder({ last_event_at: NOW - SILENT + 1 }), NOW, SILENT),
    ).toBe(false);
  });

  test("a session that has never spoken is never stale: its spawn is still landing", () => {
    expect(staleHolder(holder({ last_event_at: null }), NOW, SILENT)).toBe(
      false,
    );
  });

  test("no setting is never stale: a ticket is not taken away over a number we could not read", () => {
    expect(staleHolder(holder({ last_event_at: 0 }), NOW, null)).toBe(false);
  });

  test.each(
    SessionState.options.filter(
      (state) =>
        !(RELEASABLE_HOLDER_STATES as readonly string[]).includes(state),
    ),
  )("%s is not a state a holder is released from", (state) => {
    // human_attached and awaiting_approval are alive with someone in the room, handoff_writing is
    // already releasing, and the rest have ended: the arm's own predicate, exactly.
    expect(staleHolder(holder({ state, last_event_at: 0 }), NOW, SILENT)).toBe(
      false,
    );
  });

  test.each(RELEASABLE_HOLDER_STATES)(
    "%s past the threshold is stale",
    (state) => {
      expect(
        staleHolder(holder({ state, last_event_at: 0 }), NOW, SILENT),
      ).toBe(true);
    },
  );
});
