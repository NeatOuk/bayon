import { FakeClock, ok, type Result } from "@bayon/core";
import type { Updateable } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { all, qb, read, write } from "../connection.js";
import type { DB } from "../schema.js";
import {
  OPERATOR,
  SPINE_SEED,
  listAudit,
  listCommands,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  updateRowForTest,
  type SeedRows,
  type TempDb,
} from "../testing.js";
import { getContextPackInputs } from "./context-pack.js";
import { askHumanRequests } from "./coordination.js";
import { acceptHandoff } from "./handoff-accept.js";
import { answerHumanRequest, dismissHumanRequest } from "./inbox.js";
import { listTicketQuestions, openQuestionCounts } from "./open-questions.js";
import type { PulseScope } from "./project-scope.js";
import { completionsSince, hasPulseWork } from "./pulse-reads.js";
import { staffTicket } from "./staffing.js";
import type { TicketActor } from "./ticket-common.js";
import { listTicketEvents } from "./ticket-events.js";
import type { Decide } from "./ticket-transition.js";
import { updateTicketCas } from "./ticket-writes.js";
import { getTicket, listTickets } from "./tickets.js";
import { listNeedsAttention } from "./work-views.js";

// A ticket with an open question to the operator waits, against a real temp SQLite
// file: the pulse neither wakes for its work nor is shown it, a session's staffing is refused
// `awaiting_human` and the operator's is audited, needs_human follows the questions, only the last
// answer wakes, and a question still open is not asked twice. The FRM-82 loop, row by row.

const NOW = Date.UTC(2026, 8, 22, 12);
/**
 * The two live sessions' last event: `NOW`, fresh on the FakeClock for as long as a test runs. The
 * stale_session arm ages on the Db's clock (044); it read the real one before, and this had to be
 * the wall clock's now. The stale_session arm's test still sets its own.
 */
const FRESH = NOW;
const HASH = "0".repeat(64);
const P: PulseScope = { workspaceId: "P-A", agentName: "O-A" };
const allow: Decide = () => ok(undefined);
const ORCH: TicketActor = { actor_kind: "session", actor_id: "S-O" };
const BUILDER = "S-B";

let t: TempDb;
let clock: FakeClock;

const agent = (id: string, kind: "builder" | "orchestrator") => ({
  id,
  name: id,
  kind,
  runner_id: SPINE_SEED.runnerId,
  executor_id: SPINE_SEED.executorId,
  workspace_id: "P-A",
  created_at: 1,
});
const handoff = (id: string, o: { accepted_at?: number } = {}) => ({
  id,
  ticket_id: "ticket-1",
  from_session_id: BUILDER,
  reason: "agent_request",
  facts_json: "{}",
  packet_path: `/tmp/${id}.md`,
  packet_hash: HASH,
  quality: "full",
  created_at: NOW - 10,
  ...o,
});
const gate = (state: "failed" | "passed") => ({
  id: "G-1",
  ticket_id: "ticket-1",
  kind: "code_review" as const,
  state,
  subject_kind: "diff",
  subject_ref: "x",
  started_at: 0,
});

beforeEach(async () => {
  clock = new FakeClock(NOW);
  t = unwrap(await tempDb(clock));
  unwrap(await seedSpine(t.db, 12));
  // The spine's idle session never ages into stale_session: every arm here is one a test put there.
  unwrap(
    await updateRowForTest(t.db, "sessions", SPINE_SEED.sessionId, {
      state: "exited",
      exit_reason: "ok",
    }),
  );
  unwrap(
    await seedRows(t.db, {
      workspaces: [{ id: "P-A", name: "alpha", kind: "single" }],
      agents: [agent("O-A", "orchestrator"), agent("A-1", "builder")],
      tickets: [ticketRow(1, { status: "building", workspace_id: "P-A" })],
      sessions: [
        {
          ...newSessionInput(),
          id: "S-O",
          agent_id: "O-A",
          role: "orchestrator",
          state: "running",
          last_event_at: FRESH,
          created_at: 0,
        },
        {
          ...newSessionInput(),
          id: BUILDER,
          agent_id: "A-1",
          ticket_id: "ticket-1",
          workspace_id: "P-A",
          state: "running",
          last_event_at: FRESH,
          created_at: 0,
        },
      ],
    }),
  );
});
afterEach(() => t.cleanup());

const seed = async (rows: SeedRows) => unwrap(await seedRows(t.db, rows));

/** One row of `table` patched as a test arranges it (tickets and hand-offs are not operator-edited). */
async function patchRow<T extends "tickets" | "handoffs">(
  table: T,
  id: string,
  patch: Updateable<DB[T]>,
): Promise<void> {
  unwrap(
    await write(t.db, (ix): Result<void> => {
      all(
        ix,
        qb
          .updateTable(table as "tickets")
          .set(patch as Updateable<DB["tickets"]>)
          .where("id", "=", id)
          .returning("id"),
      );
      return ok(undefined);
    }),
  );
}

/** The builder's human_ask on ticket 1. */
const ask = async (...questions: string[]) =>
  unwrap(
    await askHumanRequests(
      t.db,
      questions.map((question) => ({
        session_id: BUILDER,
        ticket_id: "ticket-1",
        kind: "decision",
        question,
        options: ["yes", "no"],
      })),
    ),
  );

const answer = (id: string, text: string) =>
  answerHumanRequest(
    t.db,
    { id, answer: text, answered_by: "operator" },
    { actor: "operator", action: "rest.inbox_answer" },
  );

/** The builder hands off: its session ends, and its packet waits for a successor. */
async function handsOff(): Promise<void> {
  unwrap(
    await updateRowForTest(t.db, "sessions", BUILDER, {
      state: "handed_off",
      ended_at: clock.now(),
      exit_reason: "ok",
    }),
  );
  await seed({ handoffs: [handoff("H-1")] });
}

const staff = (by: TicketActor) =>
  staffTicket(t.db, { ticket_id: "ticket-1", role: "builder", by }, allow, {
    actor: "x",
    action: "mcp.ticket_staff",
  });

const ticket = async () => unwrap(await getTicket(t.db, "ticket-1"));
const spawns = async () =>
  unwrap(await listCommands(t.db)).filter((c) => c.type === "session.spawn");
const overrides = async () =>
  unwrap(await listAudit(t.db)).filter(
    (a) => a.action === "ticket.staff_override",
  );
const arms = async () =>
  unwrap(await listNeedsAttention(t.db))
    .filter((r) => r.ticket_id === "ticket-1")
    .map((r) => r.why);
const answeredWakes = async (since: number) =>
  unwrap(
    await completionsSince(t.db, { at: since, ref: "" }, ["human_answered"]),
  );
const flagEvents = async () =>
  unwrap(
    await listTicketEvents(t.db, {
      ticket_id: "ticket-1",
      since: 0,
      limit: 100,
    }),
  ).rows.filter((e) => e.payload_json === '{"fields":["needs_human"]}');

describe("a waiting ticket's work is not pulse work", () => {
  // Each arm that asks the orchestrator to act on the ticket, alone on ticket 1.
  const ARMS: readonly (readonly [string, () => Promise<void>])[] = [
    ["handoff_pending", handsOff],
    [
      "unstaffed_ready",
      () => patchRow("tickets", "ticket-1", { status: "prioritized" }),
    ],
    [
      "findings_open",
      () =>
        seed({
          gates: [gate("passed")],
          findings: [
            {
              id: "F-1",
              gate_id: "G-1",
              severity: "major",
              summary: "s",
              created_at: 0,
            },
          ],
        }),
    ],
    [
      "split_candidate",
      () =>
        seed({
          handoffs: [1, 2, 3, 4].map((n) =>
            handoff(`H-${n}`, { accepted_at: NOW - 5 }),
          ),
        }),
    ],
    [
      "stale_session",
      async () => {
        unwrap(
          await updateRowForTest(t.db, "sessions", BUILDER, {
            last_event_at: 1,
          }),
        );
      },
    ],
    [
      "spawn_failed",
      async () => {
        unwrap(
          await updateRowForTest(t.db, "sessions", BUILDER, {
            state: "exited",
            exit_reason: "ok",
            ended_at: NOW - 20,
          }),
        );
        await seed({
          commands: [
            {
              id: "C-1",
              ts: NOW - 5,
              type: "session.spawn",
              state: "failed",
              payload_json: JSON.stringify({
                ticket_id: "ticket-1",
                session_id: "S-never",
              }),
            },
          ],
        });
      },
    ],
  ];

  test.each(ARMS)(
    "%s on a ticket with an open question: not pulse work, scoped or fleet; the answer makes it work again",
    async (why, arrange) => {
      await arrange();
      expect(await arms()).toContain(why);
      // After the arrangement: no completion counts, so only the arm can make it work.
      const since = clock.now() + 1;
      expect(unwrap(await hasPulseWork(t.db, since, P))).toBe(true);
      const [q] = (await ask("Which store?")).rows;
      expect(unwrap(await hasPulseWork(t.db, since, P))).toBe(false);
      expect(unwrap(await hasPulseWork(t.db, since, null))).toBe(false);
      // The operator's attention view still lists the row: the pulse side only.
      expect(await arms()).toContain(why);
      unwrap(await answer(q?.id ?? "", "sqlite"));
      await clock.advance(10);
      expect(unwrap(await hasPulseWork(t.db, clock.now() + 1, P))).toBe(true);
    },
  );

  test("a staffing proposal is not a question: alone it holds only its own arms", async () => {
    await seed({
      gates: [gate("passed")],
      findings: [
        {
          id: "F-1",
          gate_id: "G-1",
          severity: "major",
          summary: "s",
          created_at: 0,
        },
      ],
      human_requests: [
        {
          id: "R-P",
          ticket_id: "ticket-1",
          kind: "staff_approval",
          question: "Staff it?",
          asked_at: NOW,
        },
      ],
    });
    expect(unwrap(await hasPulseWork(t.db, NOW + 1, P))).toBe(true);
  });

  test("the builder's own end on a waiting ticket is no completion; after the last answer it is", async () => {
    const [q] = (await ask("Which store?")).rows;
    const since = clock.now() - 1;
    await clock.advance(5);
    await handsOff();
    const exits = async () =>
      unwrap(
        await completionsSince(t.db, { at: since, ref: "" }, [
          "session_exited",
        ]),
      ).map((c) => c.ref);
    expect(await exits()).toEqual([]);
    expect(unwrap(await hasPulseWork(t.db, since, P))).toBe(false);
    unwrap(await answer(q?.id ?? "", "sqlite"));
    expect(await exits()).toEqual([BUILDER]);
  });
});

describe("staffing a waiting ticket", () => {
  test("a session is refused awaiting_human and nothing is written", async () => {
    await handsOff();
    const [a, b] = (await ask("Which store?", "Keep v1?")).rows;
    const before = await ticket();
    const refused = unwrap(await staff(ORCH));
    expect(refused).toMatchObject({
      kind: "refused",
      reason: "awaiting_human",
    });
    const detail = refused.kind === "refused" ? refused.detail : "";
    expect(detail).toContain("waits on 2 open questions to the operator");
    for (const id of [a?.id, b?.id]) expect(detail).toContain(id);
    expect(await spawns()).toEqual([]);
    expect(await overrides()).toEqual([]);
    expect((await ticket()).version).toBe(before.version);
    // A named agent or an idempotency key changes nothing.
    const named = unwrap(
      await staffTicket(
        t.db,
        {
          ticket_id: "ticket-1",
          role: "builder",
          by: ORCH,
          agent: "A-1",
          idempotencyKey: "k-1",
        },
        allow,
      ),
    );
    expect(named).toMatchObject({ reason: "awaiting_human" });
    expect(await spawns()).toEqual([]);
  });

  test("the operator overrides, audited once in the staffing's transaction; needs_human stays set", async () => {
    await handsOff();
    const [a] = (await ask("Which store?")).rows;
    const staffed = unwrap(await staff(OPERATOR));
    expect(staffed).toMatchObject({ kind: "staffed", created: true });
    const commandId = staffed.kind === "staffed" ? staffed.command_id : "";
    expect(await spawns()).toHaveLength(1);
    expect(await overrides()).toEqual([
      expect.objectContaining({
        actor: "operator",
        target_kind: "ticket",
        target_id: "ticket-1",
        payload_json: JSON.stringify({
          reason: "awaiting_human",
          request_ids: [a?.id],
          role: "builder",
          command_id: commandId,
        }),
      }),
    ]);
    expect((await ticket()).needs_human).toBe(1);
  });

  test("an operator override that is refused anyway writes no override row", async () => {
    await ask("Which store?"); // the builder S-B still holds the ticket
    expect(unwrap(await staff(OPERATOR))).toMatchObject({
      reason: "not_staffable",
    });
    expect(await overrides()).toEqual([]);
  });
});

describe("needs_human follows the questions", () => {
  test("asking raises it once: a version bump and one updated event, the asker as actor", async () => {
    const v = (await ticket()).version;
    await ask("Which store?");
    expect(await ticket()).toMatchObject({ needs_human: 1, version: v + 1 });
    await ask("Keep v1?");
    expect((await ticket()).version).toBe(v + 1);
    expect(await flagEvents()).toMatchObject([
      { actor_kind: "session", actor_id: BUILDER, reason: "human_ask" },
    ]);
  });

  test("a hand-off accepted with questions open leaves it set", async () => {
    await ask("Which store?");
    await handsOff();
    await seed({
      sessions: [
        {
          ...newSessionInput(),
          id: "S-B2",
          agent_id: "A-1",
          ticket_id: "ticket-1",
          handoff_in_id: "H-1",
          state: "running",
          created_at: 0,
        },
      ],
    });
    const accepted = unwrap(await acceptHandoff(t.db, { session_id: "S-B2" }));
    expect(accepted).toMatchObject({ kind: "accepted" });
    expect((await ticket()).needs_human).toBe(1);
  });

  test("answering one of two leaves it set and wakes nobody; the last clears it and wakes once", async () => {
    const since = clock.now() - 1;
    const [a, b] = (await ask("Which store?", "Keep v1?")).rows;
    await clock.advance(5);
    unwrap(await answer(a?.id ?? "", "sqlite"));
    expect((await ticket()).needs_human).toBe(1);
    expect(await answeredWakes(since)).toEqual([]);
    await clock.advance(5);
    unwrap(await answer(b?.id ?? "", "yes"));
    expect((await ticket()).needs_human).toBe(0);
    expect((await answeredWakes(since)).map((c) => c.ref)).toEqual([b?.id]);
    expect((await answeredWakes(since))[0]?.workspace_id).toBe("P-A");
    expect((await flagEvents()).at(-1)).toMatchObject({
      actor_kind: "operator",
      actor_id: "operator",
      reason: "last open question answered",
    });
  });

  test("a PATCH may not clear it while a question is open, not even the operator's", async () => {
    await ask("Which store?");
    const { version } = await ticket();
    const clear = () =>
      updateTicketCas(t.db, {
        id: "ticket-1",
        version,
        patch: { needs_human: 0 },
        by: OPERATOR,
      });
    expect(await clear()).toMatchObject({
      ok: false,
      error: {
        class: "law_refused",
        cause: { rule: "patch", reason: "questions_open" },
      },
    });
    expect(await ticket()).toMatchObject({ needs_human: 1, version });
  });

  test("with no question open, the flag is the operator's to set and clear", async () => {
    const flag = async (to: 0 | 1) =>
      unwrap(
        await updateTicketCas(t.db, {
          id: "ticket-1",
          version: (await ticket()).version,
          patch: { needs_human: to },
          by: OPERATOR,
        }),
      );
    expect((await flag(1)).needs_human).toBe(1);
    expect((await flag(0)).needs_human).toBe(0);
  });
});

describe("a question still open is not asked twice", () => {
  test("the same question, however spaced or cased, returns the open request", async () => {
    const [first] = (await ask("Which store?")).rows;
    const again = await ask("  which   STORE ", "Keep v1?");
    expect(again.rows.map((r) => r.id)).toEqual([
      first?.id,
      expect.any(String),
    ]);
    expect(again.reused).toEqual([first?.id]);
    expect(again.rows[1]?.id).not.toBe(first?.id);
    // One batch asking it twice asks it once.
    const twice = await ask("Ship it?", "ship it");
    expect(twice.rows[0]?.id).toBe(twice.rows[1]?.id);
  });

  test("once answered, the key stops naming it open, and the same question may be asked anew", async () => {
    const [first] = (await ask("Which store?")).rows;
    expect(first?.dedupe_key).toMatch(/^ask:ticket-1:[0-9a-f]{16}:open$/);
    const answered = unwrap(await answer(first?.id ?? "", "sqlite"));
    expect(answered.dedupe_key).toBe(
      `${first?.dedupe_key?.slice(0, -":open".length)}:answered:${first?.id}`,
    );
    const again = await ask("Which store?");
    expect(again.reused).toEqual([]);
    expect(again.rows[0]?.id).not.toBe(first?.id);
    expect(again.rows[0]?.status).toBe("open");
  });

  test("a request with no ticket is never deduped", async () => {
    const lone = (q: string) =>
      askHumanRequests(t.db, [
        { session_id: BUILDER, kind: "decision", question: q },
      ]);
    const a = unwrap(await lone("Why?"));
    const b = unwrap(await lone("Why?"));
    expect(a.rows[0]?.id).not.toBe(b.rows[0]?.id);
    expect(a.rows[0]?.dedupe_key).toBeNull();
  });
});

test("listTicketQuestions: every question and answer, oldest first, proposals left out", async () => {
  const [a] = (await ask("Keep it blocked?")).rows;
  await clock.advance(1_000);
  const [b] = (await ask("Proceed now?")).rows;
  await seed({
    human_requests: [
      {
        id: "R-P",
        ticket_id: "ticket-1",
        kind: "staff_approval",
        question: "Staff it?",
        asked_at: NOW + 5,
      },
    ],
  });
  await clock.advance(1_000);
  unwrap(await answer(b?.id ?? "", "proceed"));
  await clock.advance(1_000);
  unwrap(await answer(a?.id ?? "", "keep it blocked"));
  const questions = unwrap(await listTicketQuestions(t.db, "ticket-1"));
  expect(questions).toEqual([
    {
      id: a?.id,
      kind: "decision",
      question: "Keep it blocked?",
      status: "answered",
      answer: "keep it blocked",
      asked_at: NOW,
      answered_at: NOW + 3_000,
    },
    {
      id: b?.id,
      kind: "decision",
      question: "Proceed now?",
      status: "answered",
      answer: "proceed",
      asked_at: NOW + 1_000,
      answered_at: NOW + 2_000,
    },
  ]);
  expect(unwrap(await listTicketQuestions(t.db, "ticket-1", 1))).toMatchObject([
    { id: b?.id },
  ]);
  expect(
    unwrap(
      await read(t.db, (ix) =>
        all(ix, qb.selectFrom("human_requests").select("id")),
      ),
    ),
  ).toHaveLength(3);
});

test("the pack drops a waiting ticket's hand-off, counts its questions, and lists them as open requests", async () => {
  await seed({
    pulses: [
      {
        id: "PA",
        agent_id: "O-A",
        trigger: "completion",
        scheduled_at: NOW,
        state: "running",
        lease_token: "lease-PA",
        lease_expires_at: NOW + 60_000,
      },
    ],
  });
  await handsOff();
  const pack = async () =>
    unwrap(await getContextPackInputs(t.db, { agentId: "O-A", pulseId: "PA" }));
  const before = await pack();
  expect(before.handoffs.rows.map((h) => h.id)).toEqual(["H-1"]);
  const [a, b] = (await ask("Which store?", "Keep v1?")).rows;
  const during = await pack();
  expect(during.handoffs).toEqual({ total: 0, rows: [] });
  expect(during.attention.map((g) => g.why)).not.toContain("handoff_pending");
  expect(during.tickets.rows).toMatchObject([
    { num: 1, handoff_pending: false, open_questions: 2 },
  ]);
  expect(during.human_requests.rows.map((h) => h.id).toSorted()).toEqual(
    [a?.id, b?.id].toSorted(),
  );
  unwrap(await answer(a?.id ?? "", "sqlite"));
  unwrap(await answer(b?.id ?? "", "yes"));
  const after = await pack();
  expect(after.handoffs.rows.map((h) => h.id)).toEqual(["H-1"]);
  expect(after.tickets.rows).toMatchObject([
    { num: 1, handoff_pending: true, open_questions: 0 },
  ]);
});

const dismiss = (id: string, by: TicketActor = OPERATOR) =>
  dismissHumanRequest(
    t.db,
    { id, dismissed_by: "operator", by },
    { actor: "operator", action: "rest.inbox_dismiss" },
  );

describe("dismissing a question that no longer matters", () => {
  test("dismissing one of two holds the ticket and wakes nobody; the last clears it and wakes once", async () => {
    const since = clock.now() - 1;
    const [a, b] = (await ask("Which store?", "Keep v1?")).rows;
    await clock.advance(5);
    const first = unwrap(await dismiss(a?.id ?? ""));
    expect(first).toMatchObject({
      status: "dismissed",
      answer_json: null,
      answered_by: "operator",
      answered_at: clock.now(),
    });
    expect(first.dedupe_key).toMatch(
      new RegExp(`^ask:ticket-1:[0-9a-f]{16}:dismissed:${a?.id}$`),
    );
    expect((await ticket()).needs_human).toBe(1);
    expect(await answeredWakes(since)).toEqual([]);
    await clock.advance(5);
    unwrap(await dismiss(b?.id ?? ""));
    expect((await ticket()).needs_human).toBe(0);
    expect((await answeredWakes(since)).map((c) => c.ref)).toEqual([b?.id]);
    expect((await flagEvents()).at(-1)).toMatchObject({
      actor_kind: "operator",
      reason: "last open question dismissed",
    });
    expect(
      unwrap(await listAudit(t.db)).filter(
        (r) => r.action === "rest.inbox_dismiss",
      ),
    ).toHaveLength(2);
  });

  test("one answered, then the other dismissed: the dismissal is the one wake", async () => {
    const since = clock.now() - 1;
    const [a, b] = (await ask("Which store?", "Keep v1?")).rows;
    await clock.advance(5);
    unwrap(await answer(a?.id ?? "", "sqlite"));
    await clock.advance(5);
    unwrap(await dismiss(b?.id ?? ""));
    expect((await answeredWakes(since)).map((c) => c.ref)).toEqual([b?.id]);
  });

  test("a dismissed question stops holding its ticket, and may be asked anew", async () => {
    await handsOff();
    const [q] = (await ask("Which store?")).rows;
    expect(unwrap(await staff(ORCH))).toMatchObject({
      reason: "awaiting_human",
    });
    unwrap(await dismiss(q?.id ?? ""));
    expect(unwrap(await staff(ORCH))).toMatchObject({ kind: "staffed" });
    const again = await ask("Which store?");
    expect(again.reused).toEqual([]);
    expect(again.rows[0]?.id).not.toBe(q?.id);
  });

  test("only the operator dismisses, never a staffing proposal, and only an open request", async () => {
    const [q] = (await ask("Which store?")).rows;
    const id = q?.id ?? "";
    expect(await dismiss(id, ORCH)).toMatchObject({
      ok: false,
      error: {
        class: "validation",
        message: "only the operator dismisses a question",
      },
    });
    await seed({
      human_requests: [
        {
          id: "R-P",
          ticket_id: "ticket-1",
          kind: "staff_approval",
          question: "Staff it?",
          asked_at: NOW,
        },
      ],
    });
    expect(await dismiss("R-P")).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    expect(await dismiss("no-such-request")).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
    unwrap(await dismiss(id));
    expect(await dismiss(id)).toMatchObject({
      ok: false,
      error: { class: "conflict" },
    });
    expect(await answer(id, "too late")).toMatchObject({
      ok: false,
      error: { class: "conflict" },
    });
    expect(
      unwrap(await listAudit(t.db)).filter(
        (r) => r.action === "rest.inbox_dismiss",
      ),
    ).toHaveLength(1);
  });

  test("a session's context leaves a dismissed question out: nothing tells it to act on one", async () => {
    const [kept, gone] = (await ask("Which store?", "Retire the v1 API first?"))
      .rows;
    unwrap(await dismiss(gone?.id ?? ""));
    const told = unwrap(await listTicketQuestions(t.db, "ticket-1"));
    expect(told.map((q) => q.id)).toEqual([kept?.id]);
  });
});

describe("needs human is the flag or a live question", () => {
  test("a supervisor's request writes no flag, yet counts, and the board's filter finds its ticket", async () => {
    await seed({
      tickets: [ticketRow(2, { status: "building", workspace_id: "P-A" })],
      human_requests: [
        {
          id: "R-S",
          ticket_id: "ticket-1",
          kind: "split",
          question: "Split it?",
          asked_at: NOW,
          dedupe_key: "split:ticket-1:4",
        },
      ],
    });
    expect((await ticket()).needs_human).toBe(0);
    expect(
      unwrap(await openQuestionCounts(t.db, ["ticket-1", "ticket-2"])),
    ).toEqual(new Map([["ticket-1", 1]]));
    const nums = async (needs_human: boolean) =>
      unwrap(await listTickets(t.db, { needs_human, limit: 10 })).rows.map(
        (r) => r.num,
      );
    expect(await nums(true)).toEqual([1]);
    expect(await nums(false)).toEqual([2]);
    // Its dismissal leaves the system key as it was, and the ticket needs nobody.
    expect(unwrap(await dismiss("R-S")).dedupe_key).toBe("split:ticket-1:4");
    expect(await nums(true)).toEqual([]);
  });
});
