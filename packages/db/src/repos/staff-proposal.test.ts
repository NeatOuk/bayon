import { FakeClock, ok } from "@bayon/core";
import { afterEach, beforeEach, expect, test } from "vitest";
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
  type SeedRows,
  type TempDb,
} from "../testing.js";
import { answerHumanRequest } from "./inbox.js";
import type { PulseScope } from "./project-scope.js";
import { completionsSince, hasPulseWork } from "./pulse-reads.js";
import { answerStaffProposal } from "./staff-proposal-answer.js";
import { staffTicket } from "./staffing.js";
import { listTicketEvents } from "./ticket-events.js";
import type { TicketActor } from "./ticket-common.js";
import type { Decide } from "./ticket-transition.js";
import { getTicket } from "./tickets.js";
import { qb, read, all } from "../connection.js";

// A project's approval of its orchestrator's staffing, against a real temp SQLite file.
// P-A requires approval, P-B does not. An orchestrator's ticket_staff in P-A files one proposal per
// phase and starts nothing, and the pulse stops waking for the ticket while it is open; the
// operator's answer approves (the proposed agent is staffed, in the answer's transaction) or
// rejects. The operator's own staffing never asks.

const NOW = Date.UTC(2026, 8, 22, 12);
const allow: Decide = () => ok(undefined);
const A: PulseScope = { workspaceId: "P-A", agentName: "O-A" };
const HASH = "0".repeat(64);

let t: TempDb;
let clock: FakeClock;

const agent = (
  id: string,
  kind: "builder" | "orchestrator",
  workspace_id: string | null,
) => ({
  id,
  name: id,
  kind,
  runner_id: SPINE_SEED.runnerId,
  executor_id: SPINE_SEED.executorId,
  workspace_id,
  created_at: 1,
});
const orchestratorSession = (id: string, agent_id: string) => ({
  ...newSessionInput(),
  id,
  agent_id,
  role: "orchestrator",
  state: "running" as const,
  created_at: 0,
});
const handoff = (id: string, ticket_id: string) => ({
  id,
  ticket_id,
  reason: "turn_ceiling",
  facts_json: "{}",
  packet_path: `/tmp/${id}.md`,
  packet_hash: HASH,
  quality: "full",
  created_at: 5,
});
const asSession = (id: string): TicketActor => ({
  actor_kind: "session",
  actor_id: id,
});

beforeEach(async () => {
  clock = new FakeClock(NOW);
  t = unwrap(await tempDb(clock));
  unwrap(await seedSpine(t.db, 4));
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single", staff_approval: 1 },
        { id: "P-B", name: "P-B", kind: "single" },
      ],
      agents: [
        agent("O-A", "orchestrator", "P-A"),
        agent("O-B", "orchestrator", "P-B"),
        agent("O-F", "orchestrator", null),
        agent("A-1", "builder", "P-A"),
        agent("B-1", "builder", "P-B"),
      ],
      tickets: [ticketRow(1, { status: "prioritized", workspace_id: "P-A" })],
      sessions: [
        orchestratorSession("S-OA", "O-A"),
        orchestratorSession("S-OB", "O-B"),
        orchestratorSession("S-OF", "O-F"),
      ],
    }),
  );
});
afterEach(() => t.cleanup());

const seed = async (rows: SeedRows) => unwrap(await seedRows(t.db, rows));

const staff = (
  num: number,
  by: TicketActor,
  o: { readonly key?: string; readonly agent?: string } = {},
) =>
  staffTicket(
    t.db,
    {
      ticket_id: `ticket-${num}`,
      role: "builder",
      by,
      ...(o.key === undefined ? {} : { idempotencyKey: o.key }),
      ...(o.agent === undefined ? {} : { agent: o.agent }),
    },
    allow,
    { actor: "session:x", action: "mcp.ticket_staff" },
  );

const answer = (id: string, decision: "approve" | "reject") =>
  answerStaffProposal(
    t.db,
    { id, decision, answered_by: "operator", by: OPERATOR },
    allow,
    { actor: "operator", action: "rest.inbox_answer" },
  );

const spawns = async () =>
  unwrap(await listCommands(t.db)).filter((c) => c.type === "session.spawn");
const proposals = async () =>
  unwrap(
    await read(t.db, (ix) =>
      all(
        ix,
        qb
          .selectFrom("human_requests")
          .selectAll()
          .where("kind", "=", "staff_approval")
          .orderBy("asked_at"),
      ),
    ),
  );
const eventsOf = async (num: number) =>
  unwrap(
    await listTicketEvents(t.db, {
      ticket_id: `ticket-${num}`,
      since: 0,
      limit: 50,
    }),
  ).rows;
const auditActions = async () =>
  unwrap(await listAudit(t.db)).map((a) => a.action);

/** The orchestrator's first call on ticket 1: the proposal's id. */
async function propose(num = 1, by = asSession("S-OA")): Promise<string> {
  const r = unwrap(await staff(num, by));
  if (r.kind !== "refused" || r.proposal === undefined) {
    throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  }
  return r.proposal.request_id;
}

test("five orchestrator calls file one proposal and start nothing; the pulse stops waking for the ticket", async () => {
  expect(unwrap(await hasPulseWork(t.db, 0, A))).toBe(true);

  const first = unwrap(await staff(1, asSession("S-OA")));
  expect(first).toMatchObject({
    kind: "refused",
    reason: "approval_pending",
    proposal: {
      created: true,
      agent_id: "A-1",
      runner_id: SPINE_SEED.runnerId,
      role: "builder",
      run_class: "spike",
      handoff_id: null,
    },
  });
  const id = first.kind === "refused" ? first.proposal?.request_id : undefined;
  expect(id).toBeDefined();
  // Four more: through the same key, a fresh one, and none; each the same open proposal.
  for (const key of ["mcp-key", "mcp-key", "other-key", undefined]) {
    expect(
      unwrap(
        await staff(1, asSession("S-OA"), key === undefined ? {} : { key }),
      ),
    ).toMatchObject({
      kind: "refused",
      reason: "approval_pending",
      proposal: { request_id: id, created: false, agent_id: "A-1" },
    });
  }

  const rows = await proposals();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id,
    session_id: "S-OA",
    ticket_id: "ticket-1",
    status: "open",
    question: "Staff FRM-1 with A-1 (builder, spike)?",
    options_json: JSON.stringify(["approve", "reject"]),
    dedupe_key: "staff:ticket-1:builder:spike:-",
  });
  expect(JSON.parse(rows[0]?.proposal_json ?? "null")).toEqual({
    agent_id: "A-1",
    runner_id: SPINE_SEED.runnerId,
    role: "builder",
    run_class: "spike",
    handoff_id: null,
  });
  expect(await spawns()).toEqual([]);
  expect(unwrap(await getTicket(t.db, "ticket-1"))).toMatchObject({
    status: "prioritized",
    version: 1,
  });
  expect((await eventsOf(1)).map((e) => [e.kind, e.actor_id])).toEqual([
    ["staff_proposed", "S-OA"],
  ]);
  // The one proposal's call is audited; the four that wrote nothing are not.
  expect(await auditActions()).toEqual(["mcp.ticket_staff"]);

  // Its unstaffed_ready row waits on the operator: no pulse of A's, nor the fleet's, wakes for it.
  expect(unwrap(await hasPulseWork(t.db, 0, A))).toBe(false);
  expect(unwrap(await hasPulseWork(t.db, 0, null))).toBe(false);
  expect(unwrap(await completionsSince(t.db, { at: 0, ref: "" }))).toEqual([]);
});

test("approving staffs the proposed agent in the answer's transaction, and completes once", async () => {
  const id = await propose();
  await clock.advance(1_000);

  const answered = unwrap(await answer(id, "approve"));
  expect(answered).toMatchObject({
    decision: "approve",
    request: { id, status: "answered", answer_json: '"approve"' },
  });
  const [spawn] = await spawns();
  expect(spawn?.id).toBe(answered.command_id);
  expect(spawn?.idempotency_key).toBe(`approval:${id}`);
  expect(JSON.parse(spawn?.payload_json ?? "{}")).toMatchObject({
    agent_id: "A-1",
    role: "builder",
    run_class: "spike",
    ticket_id: "ticket-1",
    workspace_id: "P-A",
  });
  expect(await spawns()).toHaveLength(1);
  expect(unwrap(await getTicket(t.db, "ticket-1"))).toMatchObject({
    status: "staffed",
  });
  expect(
    (await eventsOf(1)).map((e) => [e.kind, e.actor_kind, e.to_status]),
  ).toEqual([
    ["staff_proposed", "session", null],
    ["transition", "operator", "staffed"],
  ]);
  expect(await auditActions()).toEqual([
    "mcp.ticket_staff",
    "rest.inbox_answer",
  ]);

  // One completion wakes the orchestrator; once it is served, nothing is left for it.
  expect(
    unwrap(await completionsSince(t.db, { at: 0, ref: "" })).map((c) => [
      c.kind,
      c.ref,
      c.workspace_id,
    ]),
  ).toEqual([["human_answered", id, "P-A"]]);
  expect(unwrap(await hasPulseWork(t.db, NOW, A))).toBe(true);
  expect(unwrap(await hasPulseWork(t.db, NOW + 1_001, A))).toBe(false);

  // Answered is final, and the orchestrator's next call finds the approved spawn queued.
  const again = await answer(id, "reject");
  expect(!again.ok && again.error.class).toBe("conflict");
  expect(unwrap(await staff(1, asSession("S-OA")))).toMatchObject({
    kind: "refused",
    reason: "not_staffable",
  });
});

test("approving while the proposed agent is busy is a conflict that writes nothing and leaves the request open", async () => {
  const id = await propose();
  // The operator staffs another P-A ticket onto A-1 (their staffing never asks): A-1 is now full.
  await seed({
    tickets: [ticketRow(2, { status: "prioritized", workspace_id: "P-A" })],
  });
  expect(unwrap(await staff(2, OPERATOR))).toMatchObject({
    kind: "staffed",
    payload: { agent_id: "A-1" },
  });
  const before = { spawns: await spawns(), audit: await auditActions() };

  const busy = await answer(id, "approve");
  expect(busy).toMatchObject({
    ok: false,
    error: {
      class: "conflict",
      retryable: true,
      cause: { reason: "no_agent" },
    },
  });
  expect(!busy.ok && busy.error.message).toContain(
    "agent A-1 is at its max_concurrency (1)",
  );
  expect(await proposals()).toMatchObject([
    { id, status: "open", answer_json: null, answered_at: null },
  ]);
  expect(await spawns()).toEqual(before.spawns);
  expect(await auditActions()).toEqual(before.audit);
  expect(unwrap(await getTicket(t.db, "ticket-1"))).toMatchObject({
    status: "prioritized",
    version: 1,
  });
  expect(unwrap(await completionsSince(t.db, { at: 0, ref: "" }))).toEqual([]);
});

test("rejecting records the answer; the same phase is then refused as rejected, and a new phase proposes again", async () => {
  const id = await propose();
  const rejected = unwrap(await answer(id, "reject"));
  expect(rejected).toMatchObject({
    decision: "reject",
    command_id: null,
    request: { status: "answered", answer_json: '"reject"' },
  });
  expect(await spawns()).toEqual([]);
  expect(unwrap(await getTicket(t.db, "ticket-1"))).toMatchObject({
    status: "prioritized",
    version: 1,
  });
  expect(
    unwrap(await completionsSince(t.db, { at: 0, ref: "" })).map((c) => c.ref),
  ).toEqual([id]);

  const refused = unwrap(await staff(1, asSession("S-OA")));
  expect(refused).toMatchObject({ kind: "refused", reason: "not_staffable" });
  expect(refused.kind === "refused" && refused.detail).toContain(
    "rejected by the operator",
  );
  expect(await proposals()).toHaveLength(1);

  // A hand-off arrives: the ticket's next phase is its own proposal.
  await seed({ handoffs: [handoff("H-1", "ticket-1")] });
  expect(unwrap(await staff(1, asSession("S-OA")))).toMatchObject({
    reason: "approval_pending",
    proposal: { created: true, handoff_id: "H-1" },
  });
  expect((await proposals()).map((p) => p.dedupe_key)).toEqual([
    "staff:ticket-1:builder:spike:-",
    "staff:ticket-1:builder:spike:H-1",
  ]);
});

test("an approval whose ticket has moved on since the proposal is a conflict, and the request stays open", async () => {
  const id = await propose();
  await seed({ handoffs: [handoff("H-1", "ticket-1")] });
  const moved = await answer(id, "approve");
  expect(moved).toMatchObject({ ok: false, error: { class: "conflict" } });
  expect(!moved.ok && moved.error.message).toContain("reject it");
  expect(await proposals()).toMatchObject([{ id, status: "open" }]);
  expect(await spawns()).toEqual([]);
});

test("the operator's staffing on an approval project skips approval", async () => {
  expect(unwrap(await staff(1, OPERATOR))).toMatchObject({
    kind: "staffed",
    payload: { agent_id: "A-1" },
  });
  expect(await proposals()).toEqual([]);
});

test("with approval off, an orchestrator's staffing is unchanged", async () => {
  await seed({
    tickets: [ticketRow(2, { status: "prioritized", workspace_id: "P-B" })],
  });
  expect(unwrap(await staff(2, asSession("S-OB")))).toMatchObject({
    kind: "staffed",
    payload: { agent_id: "B-1", workspace_id: "P-B" },
  });
  expect(await proposals()).toEqual([]);
});

test("a ticket with no project staffed onto an approval project's agent is proposed, then pinned by the approval", async () => {
  await seed({ tickets: [ticketRow(2, { status: "prioritized" })] });
  const r = unwrap(await staff(2, asSession("S-OF"), { agent: "A-1" }));
  expect(r).toMatchObject({
    reason: "approval_pending",
    proposal: { agent_id: "A-1" },
  });
  expect(unwrap(await getTicket(t.db, "ticket-2")).workspace_id).toBeNull();
  const id = r.kind === "refused" ? (r.proposal?.request_id ?? "") : "";
  unwrap(await answer(id, "approve"));
  expect(unwrap(await getTicket(t.db, "ticket-2"))).toMatchObject({
    status: "staffed",
    workspace_id: "P-A",
  });
});

test("the generic answer refuses a staffing proposal; only answerStaffProposal answers it", async () => {
  const id = await propose();
  const generic = await answerHumanRequest(
    t.db,
    { id, answer: "approve", answered_by: "operator" },
    { actor: "operator", action: "rest.inbox_answer" },
  );
  expect(!generic.ok && generic.error.class).toBe("validation");
  expect(await proposals()).toMatchObject([{ id, status: "open" }]);
  // And answerStaffProposal answers nothing else.
  unwrap(
    await seedRows(t.db, {
      human_requests: [
        {
          id: "HR-ASK",
          kind: "decision",
          question: "which way?",
          asked_at: NOW,
        },
      ],
    }),
  );
  const other = await answer("HR-ASK", "approve");
  expect(!other.ok && other.error.class).toBe("validation");
  const missing = await answer("HR-NONE", "approve");
  expect(!missing.ok && missing.error.class).toBe("not_found");
});
