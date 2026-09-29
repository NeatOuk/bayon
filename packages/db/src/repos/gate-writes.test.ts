import { err } from "@bayon/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  OPERATOR,
  addSession,
  gateDb,
  listCommands,
  seedRows,
  unwrap,
} from "../testing.js";
import type { TicketActor } from "./ticket-common.js";
import {
  EVIDENCE,
  allow,
  exec,
  findingRow,
  gateRow,
  planFor,
  rows,
} from "./fixtures.js";
import { decideGate } from "./gate-decide.js";
import {
  rerunGate,
  resolveFinding,
  waiveFinding,
  waiveGate,
} from "./gate-writes.js";
import { appendTicketEvent } from "./ticket-events.js";
import { transitionTicket } from "./ticket-transition.js";
import { getTicket } from "./tickets.js";

// The API's gate writers against a real temp SQLite file: rounds with
// their gate.run commands inside the transition's transaction, supersede, rerun, waive, resolve.

let t: Awaited<ReturnType<typeof gateDb>>;
beforeEach(async () => {
  t = await gateDb(["building", "code_review", "building"]);
});
afterEach(() => t.cleanup());

const WORKER: TicketActor = { actor_kind: "session", actor_id: "S-1" };

const move = async (
  num: number,
  from: Parameters<typeof planFor>[0],
  to: Parameters<typeof planFor>[1],
  by: TicketActor = WORKER,
) => {
  const ticket = unwrap(await getTicket(t.db, `ticket-${num}`));
  return transitionTicket(
    t.db,
    { id: ticket.id, version: ticket.version, to, by },
    allow,
    undefined,
    planFor(from, to),
  );
};

const gatesOf = (num: number) =>
  rows(
    t.db,
    "SELECT * FROM gates WHERE ticket_id = ? ORDER BY kind, attempt, repo_id",
    `ticket-${num}`,
  ) as Record<string, unknown>[];

const gateEvents = (num: number) =>
  (
    rows(
      t.db,
      "SELECT actor_kind, actor_id, payload_json FROM ticket_events WHERE ticket_id = ? AND kind = 'gate' ORDER BY id",
      `ticket-${num}`,
    ) as { actor_kind: string; actor_id: string; payload_json: string }[]
  ).map((e) => ({
    ...e,
    payload: JSON.parse(e.payload_json) as Record<string, unknown>,
  }));

describe("rounds open inside the transition's transaction", () => {
  test("request_review opens code_review 1 running, with its gate.run command and a gate event", async () => {
    unwrap(await move(1, "building", "code_review"));
    const [gate, ...rest] = gatesOf(1);
    expect(rest).toEqual([]);
    expect(gate).toMatchObject({
      kind: "code_review",
      state: "running",
      attempt: 1,
      repo_id: null,
      required: 1,
      subject_kind: "diff",
      subject_ref: "unpinned",
      evidence_json: null,
      findings_total: 0,
      findings_unresolved: 0,
      reviewer_session_id: null,
      started_at: t.clock.now(),
      decided_at: null,
      waived_by: null,
      waive_reason: null,
    });
    const commands = unwrap(await listCommands(t.db)).filter(
      (c) => c.type === "gate.run",
    );
    expect(commands).toHaveLength(1);
    const payload = JSON.parse(commands[0]?.payload_json ?? "{}") as {
      gate_id: string;
      session_id: string;
    };
    expect(payload.gate_id).toBe(gate?.["id"]);
    expect(payload.session_id).toMatch(/^[0-9A-Z]{26}$/);
    expect(commands[0]?.idempotency_key).toBe(
      `gate.run:${String(gate?.["id"])}`,
    );
    expect(gateEvents(1)).toMatchObject([
      {
        actor_kind: "session",
        actor_id: "S-1",
        payload: {
          step: "open",
          kind: "code_review",
          attempt: 1,
          session_id: payload.session_id,
        },
      },
    ]);
  });

  test("a non-trivial ticket's round opens code_review and ce_review, one shared attempt across repos", async () => {
    exec(t.db, "UPDATE tickets SET non_trivial = 1 WHERE id = 'ticket-1'");
    unwrap(
      await seedRows(t.db, {
        repos: [
          { id: "r1", name: "r1", mirror_path: "/m/r1" },
          { id: "r2", name: "r2", mirror_path: "/m/r2" },
        ],
      }),
    );
    unwrap(
      await seedRows(t.db, {
        ticket_repos: [
          { ticket_id: "ticket-1", repo_id: "r1" },
          { ticket_id: "ticket-1", repo_id: "r2" },
        ],
        gates: [
          gateRow("old", {
            ticket_id: "ticket-1",
            state: "failed",
            attempt: 2,
            repo_id: "r2",
          }),
        ],
      }),
    );
    unwrap(await move(1, "building", "code_review"));
    const opened = gatesOf(1).filter((g) => g["state"] === "running");
    expect(opened.map((g) => [g["kind"], g["repo_id"], g["attempt"]])).toEqual([
      ["ce_review", "r1", 1],
      ["ce_review", "r2", 1],
      ["code_review", "r1", 3],
      ["code_review", "r2", 3],
    ]);
    expect(
      unwrap(await listCommands(t.db)).filter((c) => c.type === "gate.run"),
    ).toHaveLength(4);
  });

  //, 023: the stamped round is what lets `gatePassed` tell "this round opened no gate of
  // that kind" from "this ticket never had one".
  test("a round is stamped one past the ticket's highest, every kind of it sharing the number", async () => {
    exec(t.db, "UPDATE tickets SET non_trivial = 1 WHERE id = 'ticket-1'");
    unwrap(
      await seedRows(t.db, {
        gates: [
          gateRow("old", {
            ticket_id: "ticket-1",
            state: "failed",
            attempt: 2,
            round: 2,
          }),
        ],
      }),
    );
    unwrap(await move(1, "building", "code_review"));
    const opened = gatesOf(1).filter((g) => g["state"] === "running");
    expect(opened.map((g) => [g["kind"], g["round"]])).toEqual([
      ["ce_review", 3],
      ["code_review", 3],
    ]);
  });

  test("a failing gate.run insert rolls back the status, the gates and the events", async () => {
    exec(
      t.db,
      "CREATE TEMP TRIGGER no_gate_run BEFORE INSERT ON commands WHEN NEW.type = 'gate.run' BEGIN SELECT RAISE(ABORT, 'refused by test'); END",
    );
    const before = unwrap(await getTicket(t.db, "ticket-1"));
    expect((await move(1, "building", "code_review")).ok).toBe(false);
    const after = unwrap(await getTicket(t.db, "ticket-1"));
    expect([after.status, after.version]).toEqual([
      before.status,
      before.version,
    ]);
    expect(gatesOf(1)).toEqual([]);
    expect(
      rows(t.db, "SELECT id FROM ticket_events WHERE ticket_id = 'ticket-1'"),
    ).toEqual([]);
  });

  test("a refused transition opens no gate", async () => {
    const ticket = unwrap(await getTicket(t.db, "ticket-1"));
    const refused = await transitionTicket(
      t.db,
      { id: ticket.id, version: ticket.version, to: "code_review", by: WORKER },
      () => err({ class: "law_refused", message: "no", retryable: false }),
      undefined,
      planFor("building", "code_review"),
    );
    expect(refused.ok).toBe(false);
    expect(gatesOf(1)).toEqual([]);
  });

  test("the operator's request_fix supersedes the running reviews; a later decideGate conflicts (in sequence: gate-race.test.ts interleaves them)", async () => {
    unwrap(
      await seedRows(t.db, {
        gates: [
          gateRow("g-code", { ticket_id: "ticket-2" }),
          gateRow("g-ce", { ticket_id: "ticket-2", kind: "ce_review" }),
          gateRow("g-plan", {
            ticket_id: "ticket-2",
            kind: "plan_review",
            state: "passed",
          }),
        ],
      }),
    );
    unwrap(await move(2, "code_review", "review_fix", OPERATOR));
    expect(
      gatesOf(2).map((g) => [g["id"], g["state"], g["evidence_json"]]),
    ).toEqual([
      ["g-ce", "failed", '{"reason":"superseded"}'],
      ["g-code", "failed", '{"reason":"superseded"}'],
      ["g-plan", "passed", null],
    ]);
    expect(gateEvents(2).map((e) => e.payload["step"])).toEqual([
      "supersede",
      "supersede",
    ]);
    const late = await decideGate(t.db, {
      gate_id: "g-code",
      session_id: null,
      evidence: EVIDENCE,
      findings: [],
    });
    expect(late).toMatchObject({
      ok: false,
      error: { class: "conflict", cause: { state: "failed" } },
    });
  });

  test("park supersedes every running gate", async () => {
    unwrap(
      await seedRows(t.db, {
        gates: [
          gateRow("g-a", { ticket_id: "ticket-2" }),
          gateRow("g-b", { ticket_id: "ticket-2", kind: "plan_review" }),
        ],
      }),
    );
    unwrap(await move(2, "code_review", "parked", OPERATOR));
    expect(gatesOf(2).map((g) => g["state"])).toEqual(["failed", "failed"]);
  });

  test("gate and finding events have their own writers", async () => {
    for (const kind of ["gate", "finding"]) {
      expect(
        await appendTicketEvent(t.db, {
          ticket_id: "ticket-1",
          kind,
          ...OPERATOR,
        }),
      ).toMatchObject({ ok: false, error: { class: "validation" } });
    }
  });
});

describe("rerunGate (POST /gates/:id/run)", () => {
  test("opens attempt n+1 for the gate's repo, with a command, while the ticket is in review", async () => {
    unwrap(
      await seedRows(t.db, {
        gates: [
          gateRow("g1", { ticket_id: "ticket-2", state: "failed", attempt: 4 }),
        ],
      }),
    );
    const opened = unwrap(
      await rerunGate(t.db, { gate_id: "g1", by: OPERATOR }),
    );
    expect(opened.gate).toMatchObject({
      kind: "code_review",
      attempt: 5,
      state: "running",
    });
    const commands = unwrap(await listCommands(t.db)).filter(
      (c) => c.id === opened.command_id,
    );
    expect(commands).toHaveLength(1);
    expect(gateEvents(2).at(-1)?.payload).toMatchObject({
      step: "rerun",
      attempt: 5,
    });
  });

  //, 023: a rerun is the same review asked again, so it stays in its round. A new round
  // would strand every other kind of that round one behind, and pass_review would then refuse a
  // ticket whose gates had all been decided.
  test("the rerun stays in the round it reruns", async () => {
    unwrap(
      await seedRows(t.db, {
        gates: [
          gateRow("g1", {
            ticket_id: "ticket-2",
            state: "failed",
            attempt: 4,
            round: 3,
          }),
        ],
      }),
    );
    const opened = unwrap(
      await rerunGate(t.db, { gate_id: "g1", by: OPERATOR }),
    );
    expect(opened.gate).toMatchObject({ attempt: 5, round: 3 });
  });

  test.each<[string, Parameters<typeof gateRow>[1], string]>([
    [
      "the ticket is not in the kind's review status",
      { ticket_id: "ticket-1", state: "failed" },
      "law_refused",
    ],
    [
      "a kind no review round opens",
      { ticket_id: "ticket-2", kind: "qa_harness", state: "failed" },
      "law_refused",
    ],
    [
      "a repo that is no longer the ticket's",
      { ticket_id: "ticket-2", state: "failed", repo_id: "gone" },
      "law_refused",
    ],
  ])("refused: %s", async (_name, o, cls) => {
    unwrap(
      await seedRows(t.db, {
        repos: [{ id: "gone", name: "gone", mirror_path: "/m/g" }],
      }),
    );
    unwrap(await seedRows(t.db, { gates: [gateRow("g1", o)] }));
    expect(
      await rerunGate(t.db, { gate_id: "g1", by: OPERATOR }),
    ).toMatchObject({
      ok: false,
      error: {
        class: cls,
        cause: { rule: "rerun_gate", reason: "illegal_transition" },
      },
    });
    expect(gatesOf(2).filter((g) => g["state"] === "running")).toEqual([]);
  });

  // a review round opens parity_check beside code_review and ce_review, so the same
  // round may reopen it. Before this, `POST /gates/:id/run` refused it with "a parity_check gate is
  // not opened by a review round" — which table.ts's REVIEW_ROUND plainly contradicts — leaving a
  // failed one with no exit but an operator waive or a fresh round that discards the round's
  // passed code_review evidence with it.
  test("a failed parity_check reruns, repo-less, with its workspace subject", async () => {
    unwrap(
      await seedRows(t.db, {
        gates: [
          gateRow("g1", {
            ticket_id: "ticket-2",
            kind: "parity_check",
            state: "failed",
            attempt: 2,
            repo_id: null,
            subject_kind: "workspace",
          }),
        ],
      }),
    );
    const opened = unwrap(
      await rerunGate(t.db, { gate_id: "g1", by: OPERATOR }),
    );
    expect(opened.gate).toMatchObject({
      kind: "parity_check",
      repo_id: null,
      attempt: 3,
      state: "running",
      subject_kind: "workspace",
    });
  });

  // A kind that is not per repo is opened repo-less however many repos the ticket touches (§3.1),
  // so `ticket_repos` says nothing about it. Holding it to that set would refuse every rerun of a
  // parity_check the moment that table gets a writer.
  test("a repo-less parity_check reruns even when ticket_repos names repos", async () => {
    unwrap(
      await seedRows(t.db, {
        repos: [{ id: "r1", name: "r1", mirror_path: "/m/r1" }],
        ticket_repos: [{ ticket_id: "ticket-2", repo_id: "r1" }],
        gates: [
          gateRow("g1", {
            ticket_id: "ticket-2",
            kind: "parity_check",
            state: "failed",
            repo_id: null,
            subject_kind: "workspace",
          }),
        ],
      }),
    );
    expect(
      unwrap(await rerunGate(t.db, { gate_id: "g1", by: OPERATOR })).gate,
    ).toMatchObject({ kind: "parity_check", repo_id: null, attempt: 2 });
  });

  test("a running gate of the kind is a conflict", async () => {
    unwrap(
      await seedRows(t.db, {
        gates: [
          gateRow("g1", { ticket_id: "ticket-2", state: "failed" }),
          gateRow("g2", { ticket_id: "ticket-2", attempt: 2 }),
        ],
      }),
    );
    expect(
      await rerunGate(t.db, { gate_id: "g1", by: OPERATOR }),
    ).toMatchObject({
      ok: false,
      error: { class: "conflict", cause: { state: "running" } },
    });
  });

  test("an unknown gate is not_found", async () => {
    expect(
      await rerunGate(t.db, { gate_id: "nope", by: OPERATOR }),
    ).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
  });
});

describe("waiveGate", () => {
  beforeEach(async () => {
    unwrap(
      await seedRows(t.db, {
        gates: [
          gateRow("g-failed", { ticket_id: "ticket-2", state: "failed" }),
          gateRow("g-passed", {
            ticket_id: "ticket-2",
            kind: "ce_review",
            state: "passed",
          }),
        ],
      }),
    );
  });

  test("failed → waived, with who, why and when", async () => {
    const row = unwrap(
      await waiveGate(t.db, {
        gate_id: "g-failed",
        reason: " a false alarm ",
        by: OPERATOR,
      }),
    );
    expect(row).toMatchObject({
      state: "waived",
      waived_by: "operator",
      waive_reason: "a false alarm",
      decided_at: t.clock.now(),
    });
    expect(gateEvents(2).at(-1)?.payload).toMatchObject({
      step: "waive",
      reason: "a false alarm",
    });
  });

  test("a passed gate is a conflict naming its state; a blank reason is a validation error", async () => {
    expect(
      await waiveGate(t.db, { gate_id: "g-passed", reason: "x", by: OPERATOR }),
    ).toMatchObject({
      ok: false,
      error: { class: "conflict", cause: { state: "passed" } },
    });
    expect(
      await waiveGate(t.db, {
        gate_id: "g-failed",
        reason: "  ",
        by: OPERATOR,
      }),
    ).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    expect(
      await waiveGate(t.db, { gate_id: "nope", reason: "x", by: OPERATOR }),
    ).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
  });

  test("waive then decide, and decide then waive, in sequence: the later one conflicts (gate-race.test.ts interleaves them)", async () => {
    unwrap(
      await seedRows(t.db, {
        gates: [gateRow("g-run", { ticket_id: "ticket-2", attempt: 2 })],
      }),
    );
    unwrap(
      await waiveGate(t.db, {
        gate_id: "g-run",
        reason: "ship it",
        by: OPERATOR,
      }),
    );
    expect(
      await decideGate(t.db, {
        gate_id: "g-run",
        session_id: null,
        evidence: EVIDENCE,
        findings: [],
      }),
    ).toMatchObject({
      ok: false,
      error: { class: "conflict", cause: { state: "waived" } },
    });

    unwrap(
      await seedRows(t.db, {
        gates: [gateRow("g-run2", { ticket_id: "ticket-2", attempt: 3 })],
      }),
    );
    unwrap(
      await decideGate(t.db, {
        gate_id: "g-run2",
        session_id: null,
        evidence: EVIDENCE,
        findings: [],
      }),
    );
    expect(
      await waiveGate(t.db, {
        gate_id: "g-run2",
        reason: "late",
        by: OPERATOR,
      }),
    ).toMatchObject({
      ok: false,
      error: { class: "conflict", cause: { state: "passed" } },
    });
  });
});

describe("a gate that stops running stops its live reviewer", () => {
  /** A session of `gate`, in `state`. */
  const reviewer = async (id: string, gate: string, state: string) => {
    unwrap(await addSession(t.db, id));
    // Test-only literals (exec takes no parameters).
    exec(
      t.db,
      `UPDATE sessions SET gate_id = '${gate}', state = '${state}' WHERE id = '${id}'`,
    );
  };
  const stops = async () =>
    unwrap(await listCommands(t.db))
      .filter((c) => c.type === "session.stop")
      .map((c) => [c.idempotency_key, JSON.parse(c.payload_json) as unknown]);

  test("supersede inserts session.stop {kill} for each live reviewer, none for an ended one", async () => {
    unwrap(
      await seedRows(t.db, {
        gates: [gateRow("g-code", { ticket_id: "ticket-2" })],
      }),
    );
    await reviewer("S-live", "g-code", "running");
    await reviewer("S-done", "g-code", "exited");
    unwrap(await move(2, "code_review", "review_fix", OPERATOR));
    expect(await stops()).toEqual([
      ["session.stop:S-live", { session_id: "S-live", mode: "kill" }],
    ]);
  });

  test("waiving a running gate stops its reviewer; waiving a failed one with none live inserts nothing", async () => {
    unwrap(
      await seedRows(t.db, {
        gates: [
          gateRow("g-run", { ticket_id: "ticket-2" }),
          gateRow("g-failed", {
            ticket_id: "ticket-2",
            kind: "ce_review",
            state: "failed",
          }),
        ],
      }),
    );
    await reviewer("S-run", "g-run", "idle");
    unwrap(
      await waiveGate(t.db, {
        gate_id: "g-failed",
        reason: "ok",
        by: OPERATOR,
      }),
    );
    expect(await stops()).toEqual([]);
    unwrap(
      await waiveGate(t.db, { gate_id: "g-run", reason: "ok", by: OPERATOR }),
    );
    expect(await stops()).toEqual([
      ["session.stop:S-run", { session_id: "S-run", mode: "kill" }],
    ]);
  });

  test("a failing session.stop insert rolls the supersede back", async () => {
    unwrap(
      await seedRows(t.db, {
        gates: [gateRow("g-code", { ticket_id: "ticket-2" })],
      }),
    );
    await reviewer("S-live", "g-code", "running");
    exec(
      t.db,
      "CREATE TEMP TRIGGER no_stop BEFORE INSERT ON commands WHEN NEW.type = 'session.stop' BEGIN SELECT RAISE(ABORT, 'refused by test'); END",
    );
    expect((await move(2, "code_review", "review_fix", OPERATOR)).ok).toBe(
      false,
    );
    expect(gatesOf(2).map((g) => g["state"])).toEqual(["running"]);
  });
});

describe("resolveFinding and waiveFinding", () => {
  beforeEach(async () => {
    unwrap(
      await seedRows(t.db, {
        gates: [
          gateRow("g1", {
            ticket_id: "ticket-2",
            state: "failed",
            findings_total: 2,
            findings_unresolved: 2,
          }),
        ],
        findings: [
          findingRow("f1", "g1"),
          findingRow("f2", "g1", { severity: "minor" }),
        ],
      }),
    );
  });

  test("resolve names the fixing run, the note and the actor, and recounts the gate", async () => {
    const row = unwrap(
      await resolveFinding(t.db, {
        finding_id: "f1",
        run_id: "R-2",
        note: "fixed the null check",
        by: { actor_kind: "session", actor_id: "S-2" },
      }),
    );
    expect(row).toMatchObject({
      status: "resolved",
      resolved_by_run_id: "R-2",
      resolution_note: "fixed the null check",
      resolved_by: "session:S-2",
      resolved_at: t.clock.now(),
    });
    expect(gatesOf(2)[0]).toMatchObject({ findings_unresolved: 1 });
    const events = rows(
      t.db,
      "SELECT payload_json FROM ticket_events WHERE kind = 'finding'",
    ) as { payload_json: string }[];
    expect(events.map((e) => JSON.parse(e.payload_json) as unknown)).toEqual([
      {
        finding_id: "f1",
        gate_id: "g1",
        step: "resolve",
        severity: "major",
        run_id: "R-2",
      },
    ]);
  });

  test("a run on another ticket is refused: cross_ticket_write", async () => {
    expect(
      await resolveFinding(t.db, {
        finding_id: "f1",
        run_id: "R-1",
        note: "mine",
        by: WORKER,
      }),
    ).toMatchObject({
      ok: false,
      error: {
        class: "law_refused",
        cause: { rule: "resolve_finding", reason: "cross_ticket_write" },
      },
    });
    expect(gatesOf(2)[0]).toMatchObject({ findings_unresolved: 2 });
  });

  test("resolving twice conflicts; a blank note and an unknown run or finding are refused", async () => {
    const by = { actor_kind: "session", actor_id: "S-2" };
    unwrap(
      await resolveFinding(t.db, {
        finding_id: "f1",
        run_id: "R-2",
        note: "x",
        by,
      }),
    );
    expect(
      await resolveFinding(t.db, {
        finding_id: "f1",
        run_id: "R-2",
        note: "x",
        by,
      }),
    ).toMatchObject({
      ok: false,
      error: { class: "conflict", cause: { status: "resolved" } },
    });
    expect(
      await resolveFinding(t.db, {
        finding_id: "f2",
        run_id: "R-2",
        note: " ",
        by,
      }),
    ).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    expect(
      await resolveFinding(t.db, {
        finding_id: "f2",
        run_id: "R-9",
        note: "x",
        by,
      }),
    ).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
    expect(
      await resolveFinding(t.db, {
        finding_id: "f9",
        run_id: "R-2",
        note: "x",
        by,
      }),
    ).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
  });

  test("waive records who and why, recounts, and a second waive conflicts", async () => {
    const row = unwrap(
      await waiveFinding(t.db, {
        finding_id: "f2",
        reason: "style only",
        by: OPERATOR,
      }),
    );
    expect(row).toMatchObject({
      status: "waived",
      waived_by: "operator",
      waive_reason: "style only",
    });
    expect(gatesOf(2)[0]).toMatchObject({ findings_unresolved: 1 });
    expect(
      await waiveFinding(t.db, {
        finding_id: "f2",
        reason: "again",
        by: OPERATOR,
      }),
    ).toMatchObject({
      ok: false,
      error: { class: "conflict" },
    });
    expect(
      await waiveFinding(t.db, { finding_id: "f1", reason: "", by: OPERATOR }),
    ).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });
});
