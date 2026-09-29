import { FakeClock } from "@bayon/core";
import type { Insertable } from "kysely";
import { afterAll, expect, test } from "vitest";
import type { Db } from "../connection.js";
import type {
  FindingsTable,
  GatesTable,
  HandoffsTable,
} from "../schema-work.js";
import {
  OPERATOR,
  SPINE_SEED,
  newRunInput,
  newSessionInput,
  newTicketInput,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import { insertHumanRequest, sendMessage } from "./coordination.js";
import { createSession, updateSessionState } from "./sessions.js";
import { upsertTicketExport } from "./ticket-exports.js";
import { createTicket } from "./ticket-writes.js";
import { getTicket } from "./tickets.js";
import {
  getTicketEconomics,
  listNeedsAttention,
  listTicketFindings,
  listTicketGates,
  listTicketHandoffs,
  listTicketReviewRounds,
} from "./work-views.js";

const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function seeded(): Promise<Db> {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 3));
  return t.db;
}

// v_needs_attention's ages run on the Db's clock (044); the rows sit far on either side of it.
const LONG_AGO = 1;
const FAR_FUTURE = 32_503_680_000_000; // 3000-01-01

const gate = (
  id: string,
  ticket_id: string,
  o: Partial<Insertable<GatesTable>> = {},
): Insertable<GatesTable> => ({
  id,
  ticket_id,
  kind: "code_review",
  state: "passed",
  subject_kind: "diff",
  subject_ref: "HEAD",
  ...o,
});
const finding = (
  id: string,
  gate_id: string,
  severity: FindingsTable["severity"],
  o: Partial<Insertable<FindingsTable>> = {},
): Insertable<FindingsTable> => ({
  id,
  gate_id,
  severity,
  summary: id,
  created_at: 0,
  ...o,
});
const handoff = (
  id: string,
  ticket_id: string,
  o: Partial<Insertable<HandoffsTable>> = {},
): Insertable<HandoffsTable> => ({
  id,
  ticket_id,
  reason: "context_ceiling",
  facts_json: "{}",
  packet_path: `/p/${id}.md`,
  packet_hash: "h",
  created_at: 0,
  ...o,
});

test("both views run on an empty database", async () => {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  expect(unwrap(await listNeedsAttention(t.db))).toEqual([]);
  expect(await getTicketEconomics(t.db, "none")).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
});

test("v_ticket_economics derives cost, waste, review rounds and hand-offs from their sources (amendment 9)", async () => {
  const db = await seeded();
  const ticket = unwrap(
    await createTicket(db, newTicketInput({ title: "econ" }), OPERATOR),
  );
  const idle = unwrap(
    await createTicket(db, newTicketInput({ title: "idle" }), OPERATOR),
  );
  const session = unwrap(
    await createSession(db, {
      ...newSessionInput(),
      id: "econ-session",
      ticket_id: ticket.id,
    }),
  );
  const run = (id: string, seq: number) => ({
    ...newRunInput(session.id),
    id,
    seq,
    state: "ok" as const,
    started_at: 0,
  });
  const spend = (id: string, run_id: string) => ({
    id,
    run_id,
    session_id: session.id,
    ticket_id: ticket.id,
    phase: "build",
    runner_id: SPINE_SEED.runnerId,
    model: "m",
    cost_source: "reported",
    ts: 0,
  });
  unwrap(
    await seedRows(db, {
      runs: [run("r-1", 1), run("r-2", 2)],
      spend: [
        {
          ...spend("sp-1", "r-1"),
          cost_usd: 0.5,
          tokens_in: 100,
          tokens_out: 50,
          cache_hit_ratio: 0.5,
        },
        {
          ...spend("sp-2", "r-2"),
          cost_usd: 0.25,
          tokens_in: 10,
          tokens_out: 5,
          cache_hit_ratio: 1,
          wasted: 1,
        },
      ],
      gates: [
        gate("cr-1", ticket.id),
        gate("cr-2", ticket.id, { attempt: 2 }),
        gate("pr-1", ticket.id, { kind: "plan_review" }),
      ],
      // Two hand-offs, one of them a phase boundary: 022 splits the sizing signal (§7.5)
      // from the progress, so the view must answer 2 and 1, never 3 and 0.
      handoffs: [
        handoff("h-1", ticket.id),
        handoff("h-2", ticket.id),
        handoff("h-3", ticket.id, { reason: "phase_change" }),
      ],
    }),
  );
  expect(unwrap(await getTicketEconomics(db, ticket.id))).toEqual({
    id: ticket.id,
    num: ticket.num,
    title: "econ",
    status: "backlog",
    complexity_tier: "standard",
    cost_usd: 0.75,
    cost_wasted_usd: 0.25,
    review_rounds: 2,
    handoff_count: 2,
    phase_handoff_count: 1,
    sessions: 1,
    tokens: 165,
    cache_ratio: 0.75,
  });
  expect(unwrap(await getTicketEconomics(db, idle.id))).toEqual({
    id: idle.id,
    num: idle.num,
    title: "idle",
    status: "backlog",
    complexity_tier: "standard",
    cost_usd: 0,
    cost_wasted_usd: 0,
    review_rounds: 0,
    handoff_count: 0,
    phase_handoff_count: 0,
    sessions: 0,
    tokens: 0,
    cache_ratio: null,
  });
  // A board page reads the same rounds, by ticket id.
  expect(
    unwrap(await listTicketReviewRounds(db, [ticket.id, idle.id, "none"])),
  ).toEqual(
    new Map([
      [ticket.id, 2],
      [idle.id, 0],
    ]),
  );
  expect(unwrap(await listTicketReviewRounds(db, []))).toEqual(new Map());
  // Nothing writes the tickets columns any more (amendment 9).
  expect(unwrap(await getTicket(db, ticket.id))).toMatchObject({
    cost_usd: 0,
    cost_wasted_usd: 0,
    review_rounds: 0,
    handoff_count: 0,
  });
});

// split_candidate (004) and handoff_pending's age-free rule have their own tests in
// migrate-004.test.ts.
test("v_needs_attention lists each M1 arm once and nothing that is fine (amendment 4)", async () => {
  const db = await seeded();
  const ready = unwrap(
    await createTicket(
      db,
      newTicketInput({ title: "ready", status: "prioritized" }),
      OPERATOR,
    ),
  );
  const work = unwrap(
    await createTicket(
      db,
      newTicketInput({ title: "work", status: "building" }),
      OPERATOR,
    ),
  );
  // 035: a failed gate is listed while its ticket still waits behind it — in review, nothing running.
  const stuck = unwrap(
    await createTicket(
      db,
      newTicketInput({ title: "stuck", status: "code_review" }),
      OPERATOR,
    ),
  );
  for (const [id, last] of [
    ["stale", LONG_AGO],
    ["fresh", FAR_FUTURE],
  ] as const) {
    unwrap(await createSession(db, { ...newSessionInput(), id }));
    unwrap(
      await updateSessionState(db, id, {
        from: ["pending"],
        to: "running",
        patch: { last_event_at: last },
      }),
    );
  }
  unwrap(
    await seedRows(db, {
      gates: [
        gate("failed", stuck.id, { state: "failed" }),
        // Beside running gates, on a ticket that is not in review: not stuck.
        gate("history", work.id, { kind: "code_review", state: "failed" }),
        gate("hung", work.id, {
          kind: "ce_review",
          state: "running",
          started_at: LONG_AGO,
        }),
        gate("busy", work.id, {
          kind: "plan_review",
          state: "running",
          started_at: FAR_FUTURE,
        }),
        gate("ok", work.id, { kind: "qa_harness" }),
      ],
      findings: [
        finding("f-1", "ok", "blocker"),
        finding("f-2", "ok", "major"),
        finding("f-3", "failed", "nit"),
        finding("f-4", "busy", "blocker", { status: "resolved" }),
      ],
      handoffs: [
        handoff("waiting", work.id),
        // accepted, so no longer pending (004: accepted_at decides, M2 amendment c)
        handoff("taken", work.id, { to_session_id: "fresh", accepted_at: 1 }),
      ],
      human_requests: [
        { id: "hr-fresh", kind: "q", question: "?", asked_at: FAR_FUTURE },
        {
          id: "hr-answered",
          kind: "q",
          question: "?",
          asked_at: LONG_AGO,
          status: "answered",
        },
      ],
    }),
  );
  // asked at the fake clock's now: unanswered once that clock has run a day past it (below)
  const asked = unwrap(
    await insertHumanRequest(db, {
      ticket_id: work.id,
      kind: "decision",
      question: "Which API?",
    }),
  );
  const unread = unwrap(
    await sendMessage(db, {
      from_kind: "agent",
      from_id: "orchestrator",
      to_kind: "agent",
      to_id: "builder-1",
      kind: "note",
      subject: "s",
      body_md: "b",
    }),
  );
  unwrap(
    await sendMessage(db, {
      from_kind: "agent",
      from_id: "builder-1",
      to_kind: "operator",
      to_id: "operator",
      kind: "note",
      subject: "s",
      body_md: "b",
    }),
  );
  unwrap(
    await upsertTicketExport(db, {
      ticket_id: work.id,
      target: "markdown",
      state: "failed",
      error: "boom",
    }),
  );
  unwrap(
    await upsertTicketExport(db, {
      ticket_id: ready.id,
      target: "markdown",
      state: "synced",
    }),
  );

  // Not yet a day: every arm but the question's.
  expect(unwrap(await listNeedsAttention(db)).map((r) => r.why)).not.toContain(
    "unanswered_human",
  );
  await clock.advance(86_400_001);
  expect(unwrap(await listNeedsAttention(db))).toEqual([
    { why: "export_failed", ref: "markdown", ticket_id: work.id },
    { why: "findings_open", ref: "ok", ticket_id: work.id },
    { why: "gate_stuck", ref: "failed", ticket_id: stuck.id },
    { why: "gate_stuck", ref: "hung", ticket_id: work.id },
    { why: "handoff_pending", ref: "waiting", ticket_id: work.id },
    { why: "stale_session", ref: "stale", ticket_id: null },
    { why: "unanswered_human", ref: asked.id, ticket_id: work.id },
    { why: "unread_message", ref: unread.id, ticket_id: null },
    { why: "unstaffed_ready", ref: ready.id, ticket_id: ready.id },
  ]);
});

test("ticket detail reads return one ticket's gates, findings and hand-offs", async () => {
  const db = await seeded();
  const mine = unwrap(await createTicket(db, newTicketInput(), OPERATOR));
  const other = unwrap(await createTicket(db, newTicketInput(), OPERATOR));
  unwrap(
    await seedRows(db, {
      gates: [
        gate("cr-2", mine.id, { attempt: 2 }),
        gate("cr-1", mine.id),
        gate("pr-1", mine.id, { kind: "plan_review" }),
        gate("theirs", other.id),
      ],
      findings: [
        finding("f-2", "cr-2", "minor", { created_at: 2 }),
        finding("f-1", "cr-1", "major", { created_at: 1 }),
        finding("f-x", "theirs", "blocker"),
      ],
      handoffs: [
        handoff("h-2", mine.id, { created_at: 2 }),
        handoff("h-1", mine.id, { created_at: 1 }),
        handoff("h-x", other.id),
      ],
    }),
  );
  expect(unwrap(await listTicketGates(db, mine.id)).map((g) => g.id)).toEqual([
    "cr-1",
    "cr-2",
    "pr-1",
  ]);
  expect(
    unwrap(await listTicketFindings(db, mine.id)).map((f) => f.id),
  ).toEqual(["f-1", "f-2"]);
  expect(
    unwrap(await listTicketHandoffs(db, mine.id)).map((h) => h.id),
  ).toEqual(["h-1", "h-2"]);
});
