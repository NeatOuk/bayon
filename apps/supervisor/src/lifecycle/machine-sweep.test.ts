// The machine-step sweep, through a real reconciler pass over a real temp SQLite file.
// A gate's decision takes its machine step itself; the sweep takes the ones no decision is coming
// to take — the operator waived the round's last failed gate, a ticket came back into review after
// its gates had decided — and writes nothing at all when no edge applies.
import { FakeClock, ok, type ReviewFinding } from "@bayon/core";
import { getTicket, type Db } from "@bayon/db";
import { decideGate } from "@bayon/db/supervisor";
// The operator's waive and unblock are the API's writes: the test makes them with the API's own
// writers, which @bayon/db/testing re-exports because apps/supervisor may not import @bayon/db/api.
import {
  OPERATOR,
  dumpAllRows,
  seedRows,
  tempDb,
  ticketRow,
  transitionTicket,
  unwrap,
  waiveGate,
} from "@bayon/db/testing";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  fixtureProgram,
} from "@bayon/runners/fixture";
import { afterAll, describe, expect, test } from "vitest";
import { MACHINE_SWEEP_MAX, sweepMachineSteps } from "./machine-sweep.js";
import {
  EXECUTOR_ID,
  lifecycleRows,
  startLifecycle,
  tempHome,
  type LogLine,
} from "./testing/fixtures.js";

const T0 = 1_700_000_000_000;
const EVIDENCE = {
  command: "review --json",
  exit_code: 0,
  duration_ms: 1_200,
  cost_usd: 0.4,
  artifact_paths: ["gates/g/review.json"],
  run_id: "R-review",
  session_id: "S-review",
  runner_id: "fixture",
  runner_version: "1.0.0",
  executor_id: "local",
  model: null,
  subject: {
    repo_id: null,
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    files: 2,
  },
  findings: {
    total: 0,
    by_severity: { blocker: 0, major: 0, minor: 0, nit: 0 },
    parse: "schema",
  },
  flags: {},
};
const MAJOR: ReviewFinding = {
  severity: "major",
  summary: "the null check is gone",
  file: "src/a.ts",
  line: 3,
  category: null,
  detail_md: null,
};

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** A booted lifecycle whose loop never fires on its own: each pass here is an explicit one. */
async function booted() {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  unwrap(
    await seedRows(
      t.db,
      lifecycleRows({
        healthArgv: ["ok"],
        settings: { "reconciler.interval_ms": 86_400_000 },
      }),
    ),
  );
  const home = tempHome("frm-ms-");
  const slots = new SlotCounter(1);
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor: new FakeExecutor({
      id: EXECUTOR_ID,
      slots,
      programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0 },
    }),
    slots,
    adapter: createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock }),
  });
  cleanups.push(async () => {
    await started.lifecycle.shutdown();
    t.cleanup();
    home.cleanup();
  });
  return { ...started, db: t.db, clock };
}

/** A running gate on `ticketId`, then its decision. */
async function decided(
  db: Db,
  id: string,
  ticketId: string,
  o: {
    readonly kind?: "code_review" | "ce_review";
    readonly evidence?: unknown;
    readonly findings?: readonly ReviewFinding[];
  } = {},
) {
  unwrap(
    await seedRows(db, {
      gates: [
        {
          id,
          ticket_id: ticketId,
          kind: o.kind ?? "code_review",
          state: "running",
          subject_kind: "diff",
          subject_ref: "unpinned",
          started_at: T0,
        },
      ],
    }),
  );
  return unwrap(
    await decideGate(db, {
      gate_id: id,
      session_id: null,
      evidence: o.evidence ?? EVIDENCE,
      findings: o.findings ?? [],
    }),
  );
}

const statusOf = async (db: Db, id: string) =>
  unwrap(await getTicket(db, id)).status;

/** The rows a machine step writes or reads: none may change on a pass with nothing to do. */
async function stepRows(db: Db) {
  const all = unwrap(await dumpAllRows(db));
  return {
    tickets: all["tickets"],
    ticket_events: all["ticket_events"],
    audit_log: all["audit_log"],
    gates: all["gates"],
    commands: all["commands"],
  };
}

const sweptLines = (logs: readonly LogLine[]) =>
  logs.filter((l) => l.msg.startsWith("machine-step sweep"));

describe("the machine-step sweep, on each reconciler pass", () => {
  test("the operator waives the last failed gate: the next pass advances the ticket, once", async () => {
    const w = await booted();
    unwrap(
      await seedRows(w.db, {
        tickets: [ticketRow(1, { status: "code_review" })],
      }),
    );
    const d = await decided(w.db, "g1", "ticket-1", {
      evidence: { reason: "no_reviewer" },
    });
    expect(d.advance).toMatchObject({ advanced: false });
    await w.lifecycle.reconcile();
    expect(await statusOf(w.db, "ticket-1")).toBe("code_review");

    unwrap(
      await waiveGate(w.db, {
        gate_id: "g1",
        reason: "reviewed by hand",
        by: OPERATOR,
      }),
    );
    // A waive is not a decision: nothing moves until the sweep looks.
    expect(await statusOf(w.db, "ticket-1")).toBe("code_review");
    await w.lifecycle.reconcile();
    expect(await statusOf(w.db, "ticket-1")).toBe("qa_harness");
    const rows = await stepRows(w.db);
    expect(rows.ticket_events).toContainEqual(
      expect.objectContaining({
        kind: "transition",
        actor_kind: "supervisor",
        actor_id: "gate_engine",
        from_status: "code_review",
        to_status: "qa_harness",
      }),
    );
    expect(
      rows.audit_log?.filter(
        (a) => (a as { action: string }).action === "supervisor.advance_ticket",
      ),
    ).toHaveLength(1);
    expect(sweptLines(w.logs)).toContainEqual(
      expect.objectContaining({
        msg: "machine-step sweep: a resting ticket moved on",
        obj: { ticketId: "ticket-1", rule: "pass_review", to: "qa_harness" },
      }),
    );

    // Idempotent: the next pass finds it moved on and writes nothing.
    const before = await stepRows(w.db);
    await w.lifecycle.reconcile();
    expect(await stepRows(w.db)).toEqual(before);
  });

  test("a ticket back in review after its gates decided (unblocked, or a restart between) advances on the next pass", async () => {
    const w = await booted();
    unwrap(
      await seedRows(w.db, {
        tickets: [
          ticketRow(1, { status: "blocked" }),
          ticketRow(2, { status: "blocked", non_trivial: 1 }),
        ],
      }),
    );
    // Decided while blocked: no machine step applies to a blocked ticket.
    expect((await decided(w.db, "g1", "ticket-1")).advance).toMatchObject({
      advanced: false,
      status: "blocked",
    });
    await decided(w.db, "g2", "ticket-2", { findings: [MAJOR] });
    await decided(w.db, "g3", "ticket-2", { kind: "ce_review" });
    expect(await statusOf(w.db, "ticket-2")).toBe("blocked");
    // The operator unblocks both back to code_review (the API's write, as the API makes it).
    for (const id of ["ticket-1", "ticket-2"]) {
      unwrap(
        await transitionTicket(
          w.db,
          {
            id,
            version: 1,
            to: "code_review",
            by: OPERATOR,
            patch: { blocked_reason: null, unblock_condition: null },
          },
          () => ok(undefined),
        ),
      );
    }
    await w.lifecycle.reconcile();
    expect(await statusOf(w.db, "ticket-1")).toBe("qa_harness");
    expect(await statusOf(w.db, "ticket-2")).toBe("review_fix");
  });

  test("a pass with nothing to do writes nothing", async () => {
    const w = await booted();
    unwrap(
      await seedRows(w.db, {
        tickets: [
          ticketRow(1, { status: "code_review" }),
          ticketRow(2, { status: "code_review" }),
          ticketRow(3, { status: "plan_review", non_trivial: 1 }),
          ticketRow(4, { status: "qa_harness" }),
          ticketRow(5, { status: "building" }),
        ],
      }),
    );
    // A failure that did not judge the code, carrying a blocker: never a fix round.
    await decided(w.db, "g1", "ticket-1", {
      evidence: { reason: "reviewer_error" },
      findings: [MAJOR],
    });
    // A gate still running: not even looked at.
    unwrap(
      await seedRows(w.db, {
        gates: [
          {
            id: "g2",
            ticket_id: "ticket-2",
            kind: "code_review",
            state: "running",
            subject_kind: "diff",
            subject_ref: "unpinned",
            started_at: T0,
          },
        ],
      }),
    );
    const before = await stepRows(w.db);
    await w.lifecycle.reconcile();
    await w.lifecycle.reconcile();
    expect(await stepRows(w.db)).toEqual(before);
    // Nothing moved, and nothing failed.
    expect(sweptLines(w.logs)).toEqual([]);
  });

  // a ticket that crossed pass_review while its project ran no QA has no QA gate, and
  // nothing but this sweep will ever open one.
  test("a ticket at qa_harness owed a QA gate gets exactly one, however many passes look", async () => {
    const w = await booted();
    unwrap(
      await seedRows(w.db, {
        workspaces: [
          {
            id: "ws-qa",
            name: "ws-qa",
            kind: "single",
            qa_mode: "command",
            qa_cmd: "./scripts/check",
          },
        ],
      }),
    );
    unwrap(
      await seedRows(w.db, {
        tickets: [
          ticketRow(1, { status: "qa_harness", workspace_id: "ws-qa" }),
          // No QA in its project: owed nothing, exactly as before.
          ticketRow(2, { status: "qa_harness" }),
        ],
      }),
    );
    const qaGates = async (ticketId: string) =>
      ((await stepRows(w.db)).gates ?? []).filter(
        (g) =>
          (g as { ticket_id: string; kind: string }).ticket_id === ticketId &&
          (g as { kind: string }).kind === "qa_harness",
      ) as { id: string; state: string; round: number }[];

    await w.lifecycle.reconcile();
    const [opened, ...more] = await qaGates("ticket-1");
    expect(more).toEqual([]);
    expect(opened).toMatchObject({ state: "running", round: 1 });
    expect(await qaGates("ticket-2")).toEqual([]);
    expect(await statusOf(w.db, "ticket-1")).toBe("qa_harness");
    expect(sweptLines(w.logs)).toContainEqual(
      expect.objectContaining({
        msg: "machine-step sweep: opened the QA gate a ticket at qa_harness was owed",
        obj: { ticketId: "ticket-1", gateIds: [opened?.id] },
      }),
    );
    // One summary line for the pass, beside the per-ticket one.
    expect(
      sweptLines(w.logs).filter(
        (l) => l.msg === "machine-step sweep: opened owed QA gates this pass",
      ),
    ).toEqual([
      expect.objectContaining({
        obj: expect.objectContaining({ advanced: 0, opened: 1 }),
      }),
    ]);
    // No command: the gate engine's poll starts it (§9.5).
    expect((await stepRows(w.db)).commands).toEqual([]);

    // Running: the next passes do not even look at it.
    const before = await stepRows(w.db);
    await w.lifecycle.reconcile();
    await w.lifecycle.reconcile();
    expect(await stepRows(w.db)).toEqual(before);

    // Decided as infra: the round has its QA gate, so no pass reopens it (a rerun is the operator's).
    unwrap(
      await decideGate(w.db, {
        gate_id: opened?.id ?? "",
        session_id: null,
        evidence: { reason: "no_reviewer" },
        findings: [],
      }),
    );
    const decidedRows = await stepRows(w.db);
    await w.lifecycle.reconcile();
    await w.lifecycle.reconcile();
    expect((await stepRows(w.db)).gates).toEqual(decidedRows.gates);
  });

  test("more resting tickets than one pass's cap: each pass carries on after the last, then wraps", async () => {
    const w = await booted();
    const n = MACHINE_SWEEP_MAX + 1;
    unwrap(
      await seedRows(w.db, {
        tickets: Array.from({ length: n }, (_, i) =>
          ticketRow(i + 1, { status: "code_review", updated_at: i }),
        ),
      }),
    );
    const quiet = () => undefined;
    const ctx = { db: w.db, log: { info: quiet, warn: quiet, error: quiet } };
    expect(await sweepMachineSteps(ctx)).toEqual({
      looked: MACHINE_SWEEP_MAX,
      advanced: 0,
      opened: 0,
    });
    expect(await sweepMachineSteps(ctx)).toEqual({
      looked: 1,
      advanced: 0,
      opened: 0,
    });
    expect(await sweepMachineSteps(ctx)).toEqual({
      looked: MACHINE_SWEEP_MAX,
      advanced: 0,
      opened: 0,
    });
  });
});
