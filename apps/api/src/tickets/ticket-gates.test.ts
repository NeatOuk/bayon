import { FakeClock, type Actor, type FrmError, type Result } from "@bayon/core";
import { getTicket, listTicketGates, openDb } from "@bayon/db";
import { resolveFinding } from "@bayon/db/api";
import {
  listCommands,
  newSessionInput,
  seedHolders,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "@bayon/db/testing";
import { afterAll, describe, expect, test } from "vitest";
import { finding, gate, passed } from "../gates/fixtures.js";
import { TicketService } from "./ticket-service.js";

// The M3 gate laws through the TicketService: rounds open in the transition's
// transaction, the stale-review guard and its operator override, law facts over every attempt, and
// the round-open race. Decisions are seeded as rows (the supervisor's decideGate is tested in db).

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 8));
unwrap(
  await seedRows(t.db, {
    tickets: [
      ticketRow(1, { status: "building" }),
      ticketRow(2, { status: "code_review" }),
      ticketRow(3, { status: "plan_review", non_trivial: 1 }),
      ticketRow(4, { status: "building" }),
      ticketRow(5, { status: "code_review" }),
      ticketRow(6, { status: "code_review" }),
      ticketRow(7, { status: "code_review" }),
      ticketRow(8, { status: "plan_review" }),
      ticketRow(9, { status: "qa_harness" }),
      ticketRow(10, { status: "building", non_trivial: 1 }),
    ],
  }),
);
unwrap(await seedHolders(t.db, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
const other = unwrap(await openDb({ path: t.path, clock }));
afterAll(async () => {
  unwrap(await other.close());
  t.cleanup();
});

const service = new TicketService({ db: t.db, clock, workRoot: null });
const OPERATOR: Actor = { kind: "operator" };
const W = (n: number): Actor => ({ kind: "worker", sessionId: `S-${n}` });

const value = <T>(result: Result<T>): T => {
  if (!result.ok)
    throw new Error(`${result.error.class}: ${result.error.message}`);
  return result.value;
};
const failure = <T>(result: Result<T>): FrmError => {
  if (result.ok) throw new Error("expected an error");
  return result.error;
};
const refusedFor = (reason: string) => ({
  class: "law_refused",
  cause: { reason },
});

const gatesOf = async (num: number) =>
  unwrap(await listTicketGates(t.db, `ticket-${num}`));
const gateRuns = async () =>
  unwrap(await listCommands(t.db))
    .filter((c) => c.type === "gate.run")
    .map((c) => JSON.parse(c.payload_json) as { gate_id: string });
const versionOf = async (num: number) =>
  unwrap(await getTicket(t.db, `ticket-${num}`)).version;

describe("rounds and the stale-review guard", () => {
  test("request_review opens code_review 1 with its gate.run; the worker's request_fix waits; the operator's supersedes; resubmit opens round 2", async () => {
    value(await service.transition("1", 1, { to: "code_review" }, W(1)));
    const [round1] = await gatesOf(1);
    expect(round1).toMatchObject({
      kind: "code_review",
      attempt: 1,
      state: "running",
    });
    expect((await gateRuns()).map((c) => c.gate_id)).toContain(round1?.id);

    expect(
      failure(await service.transition("1", 2, { to: "review_fix" }, W(1))),
    ).toMatchObject({
      ...refusedFor("gate_running"),
      cause: { rule: "request_fix" },
    });

    value(await service.transition("1", 2, { to: "review_fix" }, OPERATOR));
    expect((await gatesOf(1))[0]).toMatchObject({
      state: "failed",
      evidence_json: '{"reason":"superseded"}',
    });

    value(await service.transition("1", 3, { to: "code_review" }, W(1)));
    expect((await gatesOf(1)).map((g) => [g.attempt, g.state])).toEqual([
      [1, "failed"],
      [2, "running"],
    ]);
    const detail = value(await service.get("1", OPERATOR));
    expect(detail.economics.review_rounds).toBe(2);
    // The board card carries the same count.
    const board = value(await service.list({ limit: 100 }));
    expect(board.items.find((i) => i.num === 1)?.review_rounds).toBe(2);
    expect(board.items.find((i) => i.num === 9)?.review_rounds).toBe(0);
    // Amendment b: the round count is the view's; nothing writes the tickets column.
    expect(unwrap(await getTicket(t.db, "ticket-1")).review_rounds).not.toBe(2);
  });

  test("a non-trivial ticket's round opens code_review and ce_review at one attempt", async () => {
    value(await service.transition("10", 1, { to: "code_review" }, W(10)));
    expect(
      (await gatesOf(10)).map((g) => [g.kind, g.attempt, g.state]),
    ).toEqual([
      ["ce_review", 1, "running"],
      ["code_review", 1, "running"],
    ]);
  });

  test("revise_plan: the worker waits while plan_review runs; the operator supersedes it", async () => {
    unwrap(
      await seedRows(t.db, { gates: [gate("g3", 3, { kind: "plan_review" })] }),
    );
    expect(
      failure(await service.transition("3", 1, { to: "spiking" }, W(3))),
    ).toMatchObject({
      ...refusedFor("gate_running"),
      cause: { rule: "revise_plan" },
    });
    value(await service.transition("3", 1, { to: "spiking" }, OPERATOR));
    expect((await gatesOf(3))[0]).toMatchObject({ state: "failed" });
  });

  test("a trivial ticket's approve_plan needs no plan_review gate (amendment c)", async () => {
    value(await service.transition("8", 1, { to: "planned" }, W(8)));
  });
});

describe("the gate laws over the stored gates", () => {
  test("the smoke's review: a failed round's major is unresolved_findings; resolved, the gate is still not passed; round 2 passes", async () => {
    unwrap(
      await seedRows(t.db, {
        gates: [
          gate("g2a", 2, {
            state: "failed",
            evidence_json: '{"reason":"blocking_findings"}',
          }),
        ],
        findings: [finding("f2", "g2a")],
      }),
    );
    const pass = async () =>
      service.transition("2", await versionOf(2), { to: "qa_harness" }, W(2));
    expect(failure(await pass())).toMatchObject(
      refusedFor("unresolved_findings"),
    );
    unwrap(
      await resolveFinding(t.db, {
        finding_id: "f2",
        run_id: "R-2",
        note: "fixed",
        by: { actor_kind: "session", actor_id: "S-2" },
      }),
    );
    expect(failure(await pass())).toMatchObject(refusedFor("gate_not_passed"));
    unwrap(await seedRows(t.db, { gates: [passed("g2b", 2, { attempt: 2 })] }));
    expect(value(await pass()).status).toBe("qa_harness");
  });

  test("an open major on attempt 1 blocks after attempt 2 passes", async () => {
    unwrap(
      await seedRows(t.db, {
        gates: [
          gate("g5a", 5, { state: "failed" }),
          passed("g5b", 5, { attempt: 2 }),
        ],
        findings: [finding("f5", "g5a")],
      }),
    );
    expect(
      failure(await service.transition("5", 1, { to: "qa_harness" }, W(5))),
    ).toMatchObject(refusedFor("unresolved_findings"));
  });

  test("a waived gate passes, even with an open major", async () => {
    unwrap(
      await seedRows(t.db, {
        gates: [
          gate("g6", 6, {
            state: "waived",
            waived_by: "operator",
            waive_reason: "the reviewer misread the diff",
          }),
        ],
        findings: [finding("f6", "g6")],
      }),
    );
    value(await service.transition("6", 1, { to: "qa_harness" }, W(6)));
  });

  test("passed without evidence is refused (§10.3)", async () => {
    unwrap(
      await seedRows(t.db, { gates: [gate("g7", 7, { state: "passed" })] }),
    );
    expect(
      failure(await service.transition("7", 1, { to: "qa_harness" }, W(7))),
    ).toMatchObject(refusedFor("missing_evidence"));
  });

  // an earlier change gave `facts.qa` a writer, so the refusal is now the honest one: there is no QA run
  // for this ticket, rather than "QA facts do not exist yet". The operator's override is unchanged,
  // and it is what a project running no harness still passes on.
  test("pass_harness: a worker with no QA run is refused; the operator's override with a note passes", async () => {
    expect(
      failure(await service.transition("9", 1, { to: "qa_human" }, W(9))),
    ).toMatchObject(refusedFor("qa_not_passed"));
    value(
      await service.transition(
        "9",
        1,
        { to: "qa_human", override_note: "this project runs no harness" },
        OPERATOR,
      ),
    );
  });

  // The review's MEDIUM: the override used to leave the harness running. `pass_harness` and
  // `fail_harness` carry no supersede for the machine — `harnessStep` waits while a QA gate runs —
  // but the operator may take them at any time, and a gate left `running` keeps its job on a slot
  // until the wall clock, with nothing coming to decide it.
  test("an operator's override while the harness runs supersedes the gate and stops its job", async () => {
    unwrap(
      await seedRows(t.db, {
        tickets: [ticketRow(11, { status: "qa_harness" })],
        gates: [
          gate("g-qa-live", 11, {
            kind: "qa_harness",
            state: "running",
            repo_id: null,
            subject_kind: "workspace",
          }),
        ],
      }),
    );
    unwrap(await seedHolders(t.db, [11]));
    unwrap(
      await seedRows(t.db, {
        sessions: [
          {
            ...newSessionInput(),
            id: "S-QA",
            created_at: clock.now(),
            ticket_id: "ticket-11",
            gate_id: "g-qa-live",
            state: "running",
          },
        ],
      }),
    );
    value(
      await service.transition(
        "11",
        1,
        {
          to: "qa_human",
          override_note: "the harness is wrong; passing by hand",
        },
        OPERATOR,
      ),
    );
    expect(unwrap(await getTicket(t.db, "ticket-11")).status).toBe("qa_human");
    const [row] = unwrap(await listTicketGates(t.db, "ticket-11"));
    expect(row).toMatchObject({ state: "failed" });
    expect(JSON.parse(String(row?.evidence_json))).toEqual({
      reason: "superseded",
    });
    // …and its job is told to stop, rather than running on to the wall clock.
    const stops = unwrap(await listCommands(t.db)).filter(
      (c) => c.type === "session.stop",
    );
    expect(stops.map((c) => JSON.parse(c.payload_json))).toContainEqual({
      session_id: "S-QA",
      mode: "kill",
    });
  });
});

describe("the round-open race", () => {
  test("two request_review on one version: one wins, one 409, one gate and one gate.run", async () => {
    const both = Promise.withResolvers<undefined>();
    let arrived = 0;
    const afterFacts = async () => {
      arrived += 1;
      if (arrived === 2) both.resolve(undefined);
      await both.promise;
    };
    const racers = [
      new TicketService({
        db: t.db,
        clock,
        workRoot: null,
        hooks: { afterFacts },
      }),
      new TicketService({
        db: other,
        clock,
        workRoot: null,
        hooks: { afterFacts },
      }),
    ];
    const before = (await gateRuns()).length;
    const results = await Promise.all(
      racers.map((r) => r.transition("4", 1, { to: "code_review" }, W(4))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({
      ok: false,
      error: { class: "conflict", cause: { current_version: 2 } },
    });
    expect(await gatesOf(4)).toHaveLength(1);
    expect(await gateRuns()).toHaveLength(before + 1);
  });
});
