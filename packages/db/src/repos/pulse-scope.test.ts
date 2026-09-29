import { FakeClock } from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import {
  SPINE_SEED,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type SeedRows,
} from "../testing.js";
import { getContextPackInputs } from "./context-pack.js";
import { pulseScopeOf, type PulseScope } from "./project-scope.js";
import { completionsSince, hasPulseWork } from "./pulse-reads.js";

// What a project's orchestrator reads, against a real temp SQLite file: its no-op
// check, its completions and its context pack hold its project's rows and its own mail, never
// another project's; an orchestrator with no project reads the fleet exactly as before.

const T0 = Date.UTC(2026, 8, 21, 12);
const H = 3_600_000;
const clock = new FakeClock(T0);
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const A: PulseScope = { workspaceId: "P-A", agentName: "O-A" };

const orchestrator = (id: string, workspace_id: string | null) => ({
  id,
  name: id,
  kind: "orchestrator" as const,
  runner_id: SPINE_SEED.runnerId,
  executor_id: SPINE_SEED.executorId,
  workspace_id,
  created_at: 1,
});
const pulse = (id: string, agent_id: string) => ({
  id,
  agent_id,
  trigger: "cron" as const,
  scheduled_at: T0,
  state: "running" as const,
  lease_token: `lease-${id}`,
  lease_expires_at: T0 + H,
});

/** Two projects, A's and a fleet orchestrator each with a running pulse, and `rows`. */
async function seeded(rows: SeedRows = {}) {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 4));
  unwrap(
    await seedRows(t.db, {
      ...rows,
      workspaces: [
        { id: "P-A", name: "alpha", kind: "single" },
        { id: "P-B", name: "beta", kind: "single" },
      ],
      agents: [orchestrator("O-A", "P-A"), orchestrator("O-F", null)],
      pulses: [pulse("PA", "O-A"), pulse("PF", "O-F")],
    }),
  );
  return t.db;
}

test("pulseScopeOf: an agent with a project is scoped to it by name; one without is the fleet", () => {
  expect(pulseScopeOf({ name: "O-A", workspace_id: "P-A" })).toEqual(A);
  expect(pulseScopeOf({ name: "O-F", workspace_id: null })).toBeNull();
});

test("hasPulseWork: only B has work → false for A's orchestrator, true for the fleet's", async () => {
  const db = await seeded({
    tickets: [
      ticketRow(1, { status: "prioritized", workspace_id: "P-B" }),
      // No project: the fleet's, never A's.
      ticketRow(2, { status: "prioritized" }),
    ],
  });
  expect(unwrap(await hasPulseWork(db, 0, A))).toBe(false);
  expect(unwrap(await hasPulseWork(db, 0, null))).toBe(true);
  expect(unwrap(await hasPulseWork(db, 0))).toBe(true);
});

test("hasPulseWork: A's own ticket, or unread mail to A's orchestrator, is A's work", async () => {
  const mail = (id: string, to_id: string, ticket_id: string | null) => ({
    id,
    ts: T0,
    from_kind: "operator",
    from_id: "operator",
    to_kind: "agent",
    to_id,
    kind: "note",
    subject: "s",
    body_md: "b",
    ticket_id,
  });
  const other = await seeded({
    tickets: [ticketRow(1, { workspace_id: "P-B" })],
    // Mail to someone else, even about nothing, is not A's.
    messages: [mail("M1", "O-F", null), mail("M2", "B-1", "ticket-1")],
  });
  expect(unwrap(await hasPulseWork(other, 0, A))).toBe(false);
  expect(unwrap(await hasPulseWork(other, 0, null))).toBe(true);

  const own = await seeded({ messages: [mail("M3", "O-A", null)] });
  expect(unwrap(await hasPulseWork(own, 0, A))).toBe(true);

  const ticket = await seeded({
    tickets: [ticketRow(1, { status: "prioritized", workspace_id: "P-A" })],
  });
  expect(unwrap(await hasPulseWork(ticket, 0, A))).toBe(true);
});

test("completions carry their ticket's project; a scoped no-op check counts only its project's", async () => {
  const ended = (id: string, ticket_id: string | null, at: number) => ({
    ...newSessionInput(),
    id,
    ticket_id,
    state: "exited" as const,
    created_at: 0,
    ended_at: at,
  });
  const db = await seeded({
    tickets: [
      ticketRow(1, { workspace_id: "P-B", status: "done" }),
      ticketRow(2, { status: "done" }),
      ticketRow(3, { workspace_id: "P-A", status: "done" }),
    ],
    sessions: [
      ended("s-b", "ticket-1", T0 + 1),
      ended("s-u", "ticket-2", T0 + 2),
    ],
    human_requests: [
      {
        id: "h-b",
        ticket_id: "ticket-1",
        kind: "question",
        question: "which?",
        status: "answered",
        asked_at: T0,
        answered_at: T0 + 3,
      },
    ],
  });
  expect(
    unwrap(await completionsSince(db, { at: T0, ref: "" })).map((c) => [
      c.ref,
      c.workspace_id,
    ]),
  ).toEqual([
    ["s-b", "P-B"],
    ["s-u", null],
    ["h-b", "P-B"],
  ]);
  expect(unwrap(await hasPulseWork(db, T0, A))).toBe(false);
  expect(unwrap(await hasPulseWork(db, T0, null))).toBe(true);
  unwrap(await seedRows(db, { sessions: [ended("s-a", "ticket-3", T0 + 4)] }));
  expect(unwrap(await hasPulseWork(db, T0, A))).toBe(true);
  // Since after it (a completion at the very millisecond still counts: conservative).
  expect(unwrap(await hasPulseWork(db, T0 + 5, A))).toBe(false);
});

test("the context pack of A's orchestrator holds none of B's tickets; the fleet's holds both", async () => {
  const db = await seeded({
    tickets: [
      ticketRow(1, {
        status: "building",
        workspace_id: "P-A",
        title: "alpha migration",
      }),
      ticketRow(2, { status: "prioritized", workspace_id: "P-A" }),
      ticketRow(3, {
        status: "building",
        workspace_id: "P-B",
        title: "beta zebra",
      }),
      ticketRow(4, { status: "prioritized", workspace_id: "P-B" }),
      ticketRow(5, { status: "prioritized" }),
    ],
    handoffs: [
      {
        id: "H-A",
        ticket_id: "ticket-1",
        reason: "turn_ceiling",
        facts_json: "{}",
        packet_path: "/tmp/h-a.md",
        packet_hash: "0".repeat(64),
        quality: "full",
        created_at: T0 - 2,
      },
      {
        id: "H-B",
        ticket_id: "ticket-3",
        reason: "turn_ceiling",
        facts_json: "{}",
        packet_path: "/tmp/h-b.md",
        packet_hash: "0".repeat(64),
        quality: "full",
        created_at: T0 - 1,
      },
    ],
    // On the prioritized tickets, not the ones with hand-offs: an open question holds its ticket, and
    // would drop that ticket's pending hand-off from the pack.
    human_requests: [
      {
        id: "R-A",
        ticket_id: "ticket-2",
        kind: "question",
        question: "a?",
        asked_at: T0,
      },
      {
        id: "R-B",
        ticket_id: "ticket-4",
        kind: "question",
        question: "b?",
        asked_at: T0,
      },
      { id: "R-U", kind: "question", question: "u?", asked_at: T0 },
    ],
    knowledge: [
      {
        id: "K-A",
        scope: "fleet",
        kind: "fact",
        title: "migration",
        body_md: "a",
        created_at: 0,
      },
      {
        id: "K-B",
        scope: "fleet",
        kind: "fact",
        title: "zebra",
        body_md: "b",
        created_at: 0,
      },
    ],
  });
  const a = unwrap(
    await getContextPackInputs(db, { agentId: "O-A", pulseId: "PA" }),
  );
  expect(a.project).toEqual({ id: "P-A", name: "alpha" });
  expect(a.tickets.rows.map((t) => t.num)).toEqual([1]);
  expect(a.ticket_statuses).toEqual([
    { key: "building", n: 1 },
    { key: "prioritized", n: 1 },
  ]);
  expect(a.handoffs.rows.map((h) => h.id)).toEqual(["H-A"]);
  expect(a.human_requests.rows.map((h) => h.id)).toEqual(["R-A"]);
  expect(a.knowledge.map((k) => k.id)).toEqual(["K-A"]);
  // Every attention item is A's ticket's: none of B's (3, 4), none with no project (5). Ticket 2
  // waits on R-A, so its unstaffed row is not listed; `unanswered_human` (a human-only arm, which the
  // pack still lists) turns on a day after asking, by the database's own clock, so it is left out.
  const work = (p: typeof a) =>
    p.attention
      .filter((g) => g.why !== "unanswered_human")
      .flatMap((g) => g.items.map((i) => i.ticket_num));
  const nums = a.attention.flatMap((g) => g.items.map((i) => i.ticket_num));
  expect(nums.length).toBeGreaterThan(0);
  expect(nums.every((n) => n === 1 || n === 2)).toBe(true);
  expect(new Set(work(a))).toEqual(new Set([1]));
  // Nothing in the pack names B's tickets.
  const text = JSON.stringify(a);
  for (const leak of [
    "ticket-3",
    "ticket-4",
    "ticket-5",
    "beta zebra",
    "H-B",
    "R-B",
  ]) {
    expect(text).not.toContain(leak);
  }

  const fleet = unwrap(
    await getContextPackInputs(db, { agentId: "O-F", pulseId: "PF" }),
  );
  expect(fleet.project).toBeNull();
  expect(fleet.tickets.rows.map((t) => t.num).toSorted()).toEqual([1, 3]);
  expect(fleet.handoffs.rows.map((h) => h.id)).toEqual(["H-B", "H-A"]);
  expect(fleet.human_requests.total).toBe(3);
  expect(fleet.knowledge.map((k) => k.id).toSorted()).toEqual(["K-A", "K-B"]);
  expect(new Set(work(fleet))).toEqual(new Set([1, 3, 5]));
});
