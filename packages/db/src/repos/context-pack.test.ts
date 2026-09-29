import { FakeClock } from "@bayon/core";
import type { Insertable } from "kysely";
import { afterEach, expect, test } from "vitest";
import { ftsAnyQuery } from "../fts.js";
import type { PulsesTable } from "../schema-pulse.js";
import {
  SPINE_SEED,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type SeedRows,
} from "../testing.js";
import { CONTEXT_PACK_LIMITS, getContextPackInputs } from "./context-pack.js";

// The context pack's reads (§10.1), against a real temp database migrated to the latest schema.

const T0 = Date.UTC(2026, 8, 13, 12);
const H = 3_600_000;
const clock = new FakeClock(T0);
const AGENT = SPINE_SEED.agentId;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const pulse = (
  id: string,
  o: Partial<Insertable<PulsesTable>> = {},
): Insertable<PulsesTable> => ({
  id,
  agent_id: AGENT,
  trigger: "cron",
  scheduled_at: T0,
  state: "running",
  lease_token: "lease",
  lease_expires_at: T0 + H,
  ...o,
});

/** The spine, pulse P9 running at T0, and `rows`. */
async function seeded(rows: SeedRows = {}) {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 4));
  unwrap(
    await seedRows(t.db, {
      ...rows,
      pulses: [pulse("P9"), ...(rows.pulses ?? [])],
    }),
  );
  return t.db;
}

const inputs = async (rows: SeedRows = {}) =>
  unwrap(
    await getContextPackInputs(await seeded(rows), {
      agentId: AGENT,
      pulseId: "P9",
    }),
  );

test("an empty fleet: the pulse, the live spine session, the seeded probes, nothing else", async () => {
  const p = await inputs();
  expect(p).toMatchObject({
    agent: { id: AGENT, name: SPINE_SEED.agentName },
    mission: null,
    pulse: { id: "P9", trigger: "cron", scheduled_at: T0, summary_md: null },
    seq: 1,
    previous: null,
    budget: { today_usd: 0, daily_cap_usd: null },
    sessions: [{ key: "idle", n: 1 }],
    ticket_statuses: [],
    attention: [],
    tickets: { total: 0, rows: [] },
    handoffs: { total: 0, rows: [] },
    messages: { total: 0, rows: [] },
    human_requests: { total: 0, rows: [] },
    knowledge: [],
  });
  expect(p.probes).toContainEqual({ name: "log_scan", untrusted_output: 1 });
  expect(p.probes).toContainEqual({ name: "budget", untrusted_output: 0 });
});

test("the pulse number and the previous pulse that ran: skipped ones never count, a tie goes by id", async () => {
  const p = await inputs({
    settings: [
      { key: "budget.daily_cap_usd", value_json: "12.5", updated_at: 0 },
    ],
    pulses: [
      pulse("P1", { state: "done", scheduled_at: T0 - 3 * H, summary_md: "1" }),
      pulse("P2", { state: "failed", scheduled_at: T0 - 2 * H }),
      pulse("P3", {
        state: "skipped",
        skip_reason: "nothing_to_do",
        scheduled_at: T0 - H,
      }),
      pulse("P8", { state: "done", scheduled_at: T0, summary_md: "tie" }),
      pulse("PA", { state: "done", scheduled_at: T0 + H }),
    ],
  });
  expect(p.seq).toBe(4);
  expect(p.previous).toEqual({
    id: "P8",
    trigger: "cron",
    state: "done",
    scheduled_at: T0,
    summary_md: "tie",
    actions_json: null,
  });
  expect(p.budget.daily_cap_usd).toBe(12.5);
});

test("the mission is the one agents.mission_id names; an agent without one has none", async () => {
  const db = await seeded({
    missions: [
      {
        id: "M1",
        agent_name: "orch",
        version: 1,
        who_md: "w",
        what_md: "w",
        how_md: "h",
        laws_md: "l",
        rendered_md: "Mission one.",
        hash: "0".repeat(64),
        created_at: 0,
        created_by: "operator",
      },
    ],
    agents: [
      {
        id: "agent-orch",
        name: "orch",
        kind: "orchestrator",
        runner_id: SPINE_SEED.runnerId,
        mission_id: "M1",
        created_at: 0,
      },
    ],
    pulses: [pulse("PO", { agent_id: "agent-orch" })],
  });
  const missionOf = async (agentId: string, pulseId: string) =>
    unwrap(await getContextPackInputs(db, { agentId, pulseId })).mission;
  expect(await missionOf("agent-orch", "PO")).toEqual({
    version: 1,
    rendered_md: "Mission one.",
  });
  expect(await missionOf(AGENT, "P9")).toBeNull();
});

test("attention: the newest 20 per group, with the group's size", async () => {
  const tickets = Array.from({ length: 25 }, (_, i) =>
    ticketRow(i + 1, {
      id: `T${String(i + 1).padStart(2, "0")}`,
      status: "prioritized",
    }),
  );
  const p = await inputs({ tickets });
  expect(p.attention).toHaveLength(1);
  const [group] = p.attention;
  expect(group?.why).toBe("unstaffed_ready");
  expect(group?.total).toBe(25);
  expect(group?.items).toHaveLength(CONTEXT_PACK_LIMITS.attentionPerGroup);
  expect(group?.items[0]).toEqual({
    ref: "T25",
    ticket_id: "T25",
    ticket_num: 25,
    ticket_title: "ticket 25",
  });
  expect(group?.items.at(-1)?.ref).toBe("T06");
});

test("tickets in flight: most urgent first, the owner named; unstaffed and closed ones left out", async () => {
  const p = await inputs({
    tickets: [
      ticketRow(1, { status: "building", priority: 2, updated_at: 10 }),
      ticketRow(2, {
        status: "blocked",
        priority: 1,
        blocked_reason: "waiting on #9",
      }),
      ticketRow(3, { status: "done" }),
      ticketRow(4, { status: "backlog" }),
      ticketRow(5, { status: "prioritized" }),
      ticketRow(6, {
        status: "building",
        priority: 2,
        updated_at: 20,
        owner_session_id: SPINE_SEED.sessionId,
      }),
    ],
  });
  expect(p.tickets.total).toBe(3);
  expect(p.tickets.rows.map((t) => t.num)).toEqual([2, 6, 1]);
  expect(p.tickets.rows[0]?.blocked_reason).toBe("waiting on #9");
  expect(p.tickets.rows[1]).toMatchObject({
    owner_agent: SPINE_SEED.agentName,
    owner_role: "builder",
    handoff_pending: false,
  });
  expect(p.ticket_statuses).toEqual([
    { key: "backlog", n: 1 },
    { key: "blocked", n: 1 },
    { key: "building", n: 2 },
    { key: "done", n: 1 },
    { key: "prioritized", n: 1 },
  ]);
});

const handoff = (
  id: string,
  o: { accepted_at?: number; quality?: string } = {},
) => ({
  id,
  ticket_id: "ticket-1",
  reason: "turn_ceiling",
  facts_json: "{}",
  goal_line: `goal of ${id}`,
  next_steps_md: "1. a\n2. b",
  packet_path: ".foreman/handoff-1.md",
  packet_hash: "0".repeat(64),
  created_at: T0 - H,
  ...o,
});

test("pending hand-offs come from the view's arm (005): accepted or still being written is not pending", async () => {
  const p = await inputs({
    tickets: [ticketRow(1, { status: "handoff_pending" })],
    handoffs: [
      handoff("H1", { accepted_at: T0 - 1 }),
      { ...handoff("H2"), from_session_id: SPINE_SEED.sessionId },
      handoff("H3", { quality: "writing" }),
    ],
  });
  expect(p.handoffs).toEqual({
    total: 1,
    rows: [
      {
        id: "H2",
        ticket_num: 1,
        ticket_title: "ticket 1",
        quality: "full",
        goal_line: "goal of H2",
        next_steps_md: "1. a\n2. b",
        created_at: T0 - H,
        // Its predecessor's role: what staffing the successor uses.
        from_role: "builder",
      },
    ],
  });
  expect(p.tickets.rows).toMatchObject([{ num: 1, handoff_pending: true }]);
});

test("unread messages to this agent only, newest first; open human requests only", async () => {
  const to = (
    id: string,
    o: {
      to_id?: string;
      read_at?: number;
      ts?: number;
      ticket_id?: string;
    } = {},
  ) => ({
    id,
    ts: T0 - H,
    from_kind: "session",
    from_id: "S1",
    to_kind: "agent",
    to_id: SPINE_SEED.agentName,
    kind: "note",
    subject: `subject ${id}`,
    body_md: "body",
    ...o,
  });
  const ask = (id: string, status: string) => ({
    id,
    kind: "question",
    question: `question ${id}`,
    asked_at: T0 - H,
    status,
  });
  const p = await inputs({
    tickets: [ticketRow(1)],
    messages: [
      to("M1"),
      to("M2", { read_at: T0 - 1 }),
      to("M3", { to_id: "someone-else" }),
      to("M4", { ts: T0 - 1, ticket_id: "ticket-1" }),
    ],
    human_requests: [ask("R1", "open"), ask("R2", "answered")],
  });
  expect(p.messages.total).toBe(2);
  expect(p.messages.rows.map((m) => [m.id, m.ticket_num])).toEqual([
    ["M4", 1],
    ["M1", null],
  ]);
  expect(p.human_requests).toEqual({
    total: 1,
    rows: [
      {
        id: "R1",
        asked_at: T0 - H,
        kind: "question",
        question: "question R1",
        ticket_num: null,
      },
    ],
  });
});

test("knowledge: the best 10 by FTS against open ticket titles; a closed ticket's words are not searched", async () => {
  const entry = (id: string, title: string) => ({
    id,
    scope: "fleet",
    kind: "lesson",
    title,
    body_md: `about ${title}`,
    created_at: 0,
  });
  const p = await inputs({
    tickets: [
      ticketRow(1, { status: "building", title: "Database migration fails" }),
      ticketRow(2, { status: "done", title: "gardening" }),
    ],
    knowledge: [
      ...Array.from({ length: 12 }, (_, i) =>
        entry(`K${String(i).padStart(2, "0")}`, `migration note ${i}`),
      ),
      entry("KG", "gardening"),
    ],
  });
  expect(p.knowledge).toHaveLength(CONTEXT_PACK_LIMITS.knowledge);
  expect(p.knowledge.map((k) => k.id)).not.toContain("KG");
  expect(
    (await inputs({ knowledge: [entry("K1", "anything")] })).knowledge,
  ).toEqual([]);
});

test("an unknown pulse is not_found; another agent's pulse or a blank id is validation", async () => {
  const db = await seeded();
  const refused = async (agentId: string, pulseId: string) => {
    const r = await getContextPackInputs(db, { agentId, pulseId });
    return r.ok ? null : r.error.class;
  };
  expect(await refused(AGENT, "nope")).toBe("not_found");
  expect(await refused("agent-other", "P9")).toBe("validation");
  expect(await refused(AGENT, "")).toBe("validation");
});

test("ftsAnyQuery: distinct words of 3+ characters, in the order met, OR'd, capped", () => {
  expect(ftsAnyQuery(["Fix the DB migration", "migration: 2 of 3!"], 64)).toBe(
    '"fix" OR "the" OR "migration"',
  );
  expect(ftsAnyQuery(["Fix the DB migration"], 2)).toBe('"fix" OR "the"');
  expect(ftsAnyQuery(["a b", ""], 64)).toBeNull();
  expect(ftsAnyQuery(['say "hi" OR NEAR(x)'], 64)).toBe('"say" OR "near"');
});
