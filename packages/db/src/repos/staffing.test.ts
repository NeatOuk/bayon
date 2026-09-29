import { FakeClock, err, ok } from "@bayon/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  OPERATOR,
  SPINE_SEED,
  listAudit,
  listCommands,
  newRunInput,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "../testing.js";
import { internalsOf } from "../connection.js";
import { setBudgetCap } from "./budget.js";
import { claimCommand, completeCommand } from "./commands.js";
import { listPendingHandoffs } from "./handoffs.js";
import { appendRun } from "./runs.js";
import { listLiveSessions, updateSessionState } from "./sessions.js";
import { insertSpend } from "./spend.js";
import { staffTicket, type StaffTicketRequest } from "./staffing.js";
import { listTicketEvents } from "./ticket-events.js";
import type { Decide } from "./ticket-transition.js";
import { getTicket } from "./tickets.js";

// ticket_staff's writer (M2 amendments f, h) against a real temp SQLite file. seedSpine's builder
// (agent-fixture) holds a live session, so it is never free here: B1 is the oldest free builder.

const NOW = Date.UTC(2026, 8, 13, 12);
const DAY = 24 * 3_600_000;
const allow: Decide = () => ok(undefined);
const AUDIT = { actor: "session:S-O", action: "mcp.ticket_staff" };

let t: TempDb;

const runner = (id: string) => ({
  id,
  kind: "script",
  adapter: "fixture",
  caps_json: "{}",
});
const builder = (id: string, created_at: number, o: object = {}) => ({
  id,
  name: id,
  kind: "builder" as const,
  runner_id: SPINE_SEED.runnerId,
  executor_id: SPINE_SEED.executorId,
  created_at,
  ...o,
});

beforeEach(async () => {
  t = unwrap(await tempDb(new FakeClock(NOW)));
  unwrap(await seedSpine(t.db, 4));
  unwrap(
    await seedRows(t.db, {
      runners: [runner("r2"), runner("r3")],
      agents: [builder("B1", 1), builder("B2", 2, { runner_id: "r2" })],
      tickets: [
        ticketRow(1, { status: "prioritized" }),
        ticketRow(2, { status: "building", complexity_tier: "complex" }),
        ticketRow(3, { status: "planned", complexity_tier: "standard" }),
        ticketRow(4, { status: "review_fix" }),
        ticketRow(5, { status: "staffed" }),
        ticketRow(6),
      ],
    }),
  );
});
afterEach(() => t.cleanup());

const staff = (
  num: number,
  o: Partial<StaffTicketRequest> = {},
  decide: Decide = allow,
) =>
  staffTicket(
    t.db,
    { ticket_id: `ticket-${num}`, role: "builder", by: OPERATOR, ...o },
    decide,
    AUDIT,
  );

async function staffed(num: number, o: Partial<StaffTicketRequest> = {}) {
  const r = unwrap(await staff(num, o));
  if (r.kind !== "staffed") throw new Error(`${r.reason}: ${r.detail}`);
  return r;
}

async function refused(num: number, o: Partial<StaffTicketRequest> = {}) {
  const r = unwrap(await staff(num, o));
  if (r.kind !== "refused") throw new Error("expected a refusal");
  return r;
}

const spawns = async () =>
  unwrap(await listCommands(t.db)).filter((c) => c.type === "session.spawn");
const moves = async (num: number) =>
  unwrap(
    await listTicketEvents(t.db, {
      ticket_id: `ticket-${num}`,
      since: 0,
      limit: 50,
    }),
  ).rows.filter((e) => e.kind === "transition");
const statusOf = async (num: number) =>
  unwrap(await getTicket(t.db, `ticket-${num}`)).status;

async function spend(costUsd: number, ts: number): Promise<void> {
  const run = unwrap(await appendRun(t.db, newRunInput(SPINE_SEED.sessionId)));
  unwrap(
    await insertSpend(t.db, {
      run_id: run.id,
      session_id: SPINE_SEED.sessionId,
      phase: SPINE_SEED.runClass,
      runner_id: SPINE_SEED.runnerId,
      model: "model-a",
      cost_usd: costUsd,
      cost_source: "reported",
      ts,
    }),
  );
}

describe("the staff move and its spawn commit together", () => {
  test("a prioritized ticket moves to staffed and one spawn is queued for the oldest free builder, in one transaction", async () => {
    const txns = t.db.stats.txns;
    const r = await staffed(1);
    expect(t.db.stats.txns - txns).toBe(1);
    expect(r).toMatchObject({
      created: true,
      ticket_status: "staffed",
      payload: {
        agent_id: "B1",
        role: "builder",
        run_class: "spike",
        ticket_id: "ticket-1",
      },
    });
    expect(r.payload).not.toHaveProperty("handoff_id");
    const [spawn, ...more] = await spawns();
    expect(more).toEqual([]);
    expect(spawn?.id).toBe(r.command_id);
    expect(JSON.parse(spawn?.payload_json ?? "")).toEqual(r.payload);
    expect(unwrap(await getTicket(t.db, "ticket-1"))).toMatchObject({
      status: "staffed",
      version: 2,
    });
    expect(await moves(1)).toEqual([
      expect.objectContaining({
        from_status: "prioritized",
        to_status: "staffed",
        actor_kind: "operator",
      }),
    ]);
    expect(unwrap(await listAudit(t.db)).at(-1)).toMatchObject(AUDIT);
  });

  test("the same idempotency key again returns the first command and moves nothing", async () => {
    const first = await staffed(1, { idempotencyKey: "k" });
    const again = await staffed(1, { idempotencyKey: "k" });
    expect(again).toEqual({ ...first, created: false });
    expect(await spawns()).toHaveLength(1);
    expect(await moves(1)).toHaveLength(1);
    expect(unwrap(await getTicket(t.db, "ticket-1")).version).toBe(2);
  });

  test("a key used for another ticket or role is a conflict", async () => {
    await staffed(1, { idempotencyKey: "k" });
    for (const o of [
      { ticket_id: "ticket-3" },
      { role: "reviewer" as const },
    ]) {
      expect(
        await staffTicket(
          t.db,
          {
            ticket_id: "ticket-1",
            role: "builder",
            by: OPERATOR,
            idempotencyKey: "k",
            ...o,
          },
          allow,
        ),
      ).toMatchObject({ ok: false, error: { class: "conflict" } });
    }
  });

  test("a law that refuses rolls everything back: no move, no spawn, no audit row", async () => {
    const audits = unwrap(await listAudit(t.db)).length;
    const refuse: Decide = () =>
      err({ class: "law_refused", message: "no", retryable: false });
    expect(await staff(1, {}, refuse)).toMatchObject({
      ok: false,
      error: { class: "law_refused" },
    });
    expect(await statusOf(1)).toBe("prioritized");
    expect(await spawns()).toEqual([]);
    expect(unwrap(await listAudit(t.db))).toHaveLength(audits);
  });

  test("an unknown ticket is not_found", async () => {
    expect(await staff(99)).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
  });
});

describe("the run class comes from the status (no move outside prioritized)", () => {
  test.each([
    [2, "build_complex", "building"],
    [3, "build", "planned"],
    [4, "fix", "review_fix"],
    [5, "spike", "staffed"],
  ])("ticket %i → %s", async (num, runClass, status) => {
    const r = await staffed(num);
    expect(r).toMatchObject({
      ticket_status: status,
      payload: { run_class: runClass },
    });
    expect(await moves(num)).toEqual([]);
  });
});

describe("refusals write nothing", () => {
  test("a status staffing does not take is not_staffable", async () => {
    const audits = unwrap(await listAudit(t.db)).length;
    const r = await refused(6);
    expect(r).toMatchObject({ reason: "not_staffable" });
    expect(r.detail).toContain("backlog");
    expect(await spawns()).toEqual([]);
    expect(unwrap(await listAudit(t.db))).toHaveLength(audits);
  });

  test("a ticket a live session works, or whose spawn is queued, is not_staffable; an ended session does not hold it", async () => {
    unwrap(
      await seedRows(t.db, {
        sessions: [
          {
            ...newSessionInput(),
            id: "S-LIVE",
            ticket_id: "ticket-5",
            state: "running",
            created_at: 0,
          },
          {
            ...newSessionInput(),
            id: "S-DONE",
            ticket_id: "ticket-3",
            state: "exited",
            created_at: 0,
          },
        ],
      }),
    );
    // The holder's session id is deliberately not in the message: a GUI reader acts on
    // the ticket number and the holder's state, not a ULID.
    const heldDetail = (await refused(5)).detail;
    expect(heldDetail).toContain("ticket #5");
    expect(heldDetail).toContain("running");
    expect(heldDetail).not.toContain("S-LIVE");
    await staffed(3);
    await staffed(1);
    const queuedDetail = (await refused(1)).detail;
    expect(queuedDetail).toContain("ticket #1");
    expect(queuedDetail).toContain("already queued");
  });

  test("today's spend at the cap is over_budget; yesterday's does not count; a null cap never refuses", async () => {
    unwrap(await setBudgetCap(t.db, 1, "operator"));
    await spend(5, NOW - DAY);
    await staffed(3);
    await spend(1, NOW - 1);
    expect(await refused(1)).toEqual({
      kind: "refused",
      reason: "over_budget",
      detail: "today's spend $1.00 has reached the daily cap $1.00",
    });
    unwrap(await setBudgetCap(t.db, null, "operator"));
    await staffed(1);
  });

  test("no enabled agent below max_concurrency is no_agent: a disabled one is skipped, a queued spawn holds a slot", async () => {
    unwrap(
      await seedRows(t.db, { agents: [builder("B0", 0, { enabled: 0 })] }),
    );
    expect((await staffed(1)).payload).toMatchObject({ agent_id: "B1" });
    expect((await staffed(3)).payload).toMatchObject({ agent_id: "B2" });
    expect(await refused(2)).toMatchObject({ reason: "no_agent" });
    expect(await refused(4, { role: "investigator" })).toMatchObject({
      reason: "no_agent",
    });
  });

  test("max_concurrency counts: an agent with two slots takes two tickets", async () => {
    unwrap(
      await seedRows(t.db, {
        agents: [builder("B0", 0, { max_concurrency: 2 })],
      }),
    );
    expect((await staffed(1)).payload).toMatchObject({ agent_id: "B0" });
    expect((await staffed(3)).payload).toMatchObject({ agent_id: "B0" });
    expect((await staffed(4)).payload).toMatchObject({ agent_id: "B1" });
  });

  test("a queued spawn stops holding its slot once the supervisor made its session and it ended", async () => {
    const first = await staffed(1);
    const sessionId = (first.payload as { session_id: string }).session_id;
    unwrap(
      await seedRows(t.db, {
        sessions: [
          {
            ...newSessionInput(),
            id: sessionId,
            agent_id: "B1",
            ticket_id: "ticket-1",
            state: "exited",
            created_at: 0,
          },
        ],
      }),
    );
    expect((await staffed(3)).payload).toMatchObject({ agent_id: "B1" });
  });
});

describe("role_bindings[role] (§9.8)", () => {
  const bind = (runner_id: string, o: object = {}) =>
    seedRows(t.db, {
      role_bindings: [{ role: "builder", runner_id, updated_at: 0, ...o }],
    });

  test("the bound runner's agent over an older one elsewhere, with the binding's executor", async () => {
    unwrap(await bind("r2", { executor_id: SPINE_SEED.executorId }));
    expect((await staffed(1)).payload).toMatchObject({
      agent_id: "B2",
      executor_id: SPINE_SEED.executorId,
    });
    const none = await refused(3);
    expect(none.reason).toBe("no_agent");
    expect(none.detail).toContain("runner r2");
  });

  test("the fallback runner when the bound one has no free agent", async () => {
    unwrap(await bind("r3", { fallback_runner_id: "r2" }));
    expect((await staffed(1)).payload).toMatchObject({ agent_id: "B2" });
  });
});

test("a pending hand-off passes through as handoff_id: the newest that is neither accepted nor being written", async () => {
  const handoff = (id: string, created_at: number, o: object = {}) => ({
    id,
    ticket_id: "ticket-2",
    reason: "turn_ceiling",
    facts_json: "{}",
    packet_path: `/tmp/${id}.md`,
    packet_hash: "0".repeat(64),
    created_at,
    ...o,
  });
  unwrap(
    await seedRows(t.db, {
      handoffs: [
        handoff("H1", 1, { quality: "full" }),
        handoff("H2", 2, { quality: "degraded" }),
        handoff("H3", 3, { quality: "writing" }),
        handoff("H4", 4, { quality: "full", accepted_at: 5 }),
      ],
    }),
  );
  expect((await staffed(2)).payload).toMatchObject({ handoff_id: "H2" });
});

describe("a pending hand-off makes its ticket staffable whatever the legacy status (plan rule 3)", () => {
  const predecessor = (id: string, num: number) => ({
    ...newSessionInput(),
    id,
    ticket_id: `ticket-${num}`,
    run_class: SPINE_SEED.runClass,
    state: "handed_off" as const,
    created_at: 0,
  });
  const pending = (id: string, num: number, from: string) => ({
    id,
    ticket_id: `ticket-${num}`,
    from_session_id: from,
    reason: "turn_ceiling",
    facts_json: "{}",
    quality: "full",
    packet_path: `/tmp/${id}.md`,
    packet_hash: "0".repeat(64),
    created_at: 1,
  });

  beforeEach(async () => {
    unwrap(
      await seedRows(t.db, {
        tickets: [
          ticketRow(7, { status: "handoff_pending" }),
          ticketRow(8, { status: "blocked" }),
          ticketRow(9, { status: "handoff_pending" }),
        ],
        sessions: [predecessor("S-P7", 7), predecessor("S-P8", 8)],
        handoffs: [pending("H7", 7, "S-P7"), pending("H8", 8, "S-P8")],
      }),
    );
  });

  test("released to handoff_pending: staffed with its hand-off and its predecessor's run class, no move", async () => {
    const r = await staffed(7);
    expect(r).toMatchObject({
      ticket_status: "handoff_pending",
      payload: { handoff_id: "H7", run_class: SPINE_SEED.runClass },
    });
    expect(await moves(7)).toEqual([]);
  });

  test("a held ticket stays unstaffable; so does handoff_pending with no pending hand-off", async () => {
    expect(await refused(8)).toMatchObject({ reason: "not_staffable" });
    expect(await refused(9)).toMatchObject({ reason: "not_staffable" });
    expect(await spawns()).toEqual([]);
  });
});

// the `stale_session` arm's remedy, taken. Its session is live by the arm's own
// definition, so the holder check used to refuse the one lever the orchestrator has. It now asks
// the holder to hand off — the same `session.handoff` a phase boundary inserts — and
// says come back, which is a different answer from no.
describe("a holder past watchdog.silent_ms is released, not merely refused", () => {
  const SILENT_MS = 1_800_000;
  const holder = (o: { lastEventAt: number | null; state?: string }) => ({
    ...newSessionInput(),
    id: "S-HUNG",
    ticket_id: "ticket-5",
    run_class: SPINE_SEED.runClass,
    state: (o.state ?? "running") as "running",
    last_event_at: o.lastEventAt,
    created_at: 0,
  });

  const seedHolder = async (o: {
    lastEventAt: number | null;
    state?: string;
  }) => {
    unwrap(await seedRows(t.db, { sessions: [holder(o)] }));
  };

  const releases = async () =>
    unwrap(await listCommands(t.db)).filter(
      (c) => c.type === "session.handoff",
    );

  /** §13.1: a ticket has exactly one of a live owner, a pending hand-off, or a terminal status. */
  const owners = async (num: number) => {
    const live = unwrap(await listLiveSessions(t.db)).filter(
      (s) => s.ticket_id === `ticket-${num}`,
    );
    const pending = unwrap(await listPendingHandoffs(t.db, `ticket-${num}`));
    return { live: live.map((s) => s.id), pending: pending.map((h) => h.id) };
  };

  test("the release is queued, the refusal names it, and §13.1 holds throughout", async () => {
    await seedHolder({ lastEventAt: NOW - SILENT_MS });
    expect(await owners(5)).toEqual({ live: ["S-HUNG"], pending: [] });
    const audits = unwrap(await listAudit(t.db)).length;

    const r = await refused(5);
    expect(r.reason).toBe("holder_releasing");
    expect(r.detail).toContain("ticket #5");
    expect(r.detail).toContain("silent for 30m");
    expect(r.detail).toContain("watchdog.silent_ms (30m)");

    const [release, ...more] = await releases();
    expect(more).toEqual([]);
    expect(release?.id).toBe(r.release_command_id);
    expect(JSON.parse(release?.payload_json ?? "")).toEqual({
      reason: "stale_session",
      session_id: "S-HUNG",
    });
    // Nothing was staffed: the ticket is still held as this call returns, so §13.1 is unchanged
    // and no second session is ever queued against the holder.
    expect(await spawns()).toEqual([]);
    expect(await statusOf(5)).toBe("staffed");
    expect(await owners(5)).toEqual({ live: ["S-HUNG"], pending: [] });
    // The one refusal that writes is the one refusal that is audited (§9.5: every write is
    // attributable).
    expect(unwrap(await listAudit(t.db))).toHaveLength(audits + 1);
  });

  test("a holder that spoke a minute ago keeps its ticket and nothing is written", async () => {
    await seedHolder({ lastEventAt: NOW - SILENT_MS + 1 });
    const r = await refused(5);
    expect(r).toMatchObject({ reason: "not_staffable" });
    expect(r.detail).toContain("stop it or wait for it to finish");
    expect(r.release_command_id).toBeUndefined();
    expect(await releases()).toEqual([]);
  });

  test("a holder that has never spoken is not stale: its spawn is still landing", async () => {
    await seedHolder({ lastEventAt: null });
    expect(await refused(5)).toMatchObject({ reason: "not_staffable" });
    expect(await releases()).toEqual([]);
  });

  test("no watchdog.silent_ms row: the old refusal stands, and no ticket is taken away", async () => {
    await seedHolder({ lastEventAt: 0 });
    unwrap(internalsOf(t.db))
      .raw.prepare("DELETE FROM settings WHERE key = 'watchdog.silent_ms'")
      .run();
    expect(await refused(5)).toMatchObject({ reason: "not_staffable" });
    expect(await releases()).toEqual([]);
  });

  test("the operator's own window decides: raise it and the same holder is working", async () => {
    await seedHolder({ lastEventAt: NOW - SILENT_MS });
    unwrap(
      await seedRows(t.db, {
        settings: [
          { key: "watchdog.silent_ms", value_json: "3600000", updated_at: 1 },
        ],
      }),
    );
    expect(await refused(5)).toMatchObject({ reason: "not_staffable" });
    expect(await releases()).toEqual([]);
  });

  test("one ask while one is outstanding, and a spent ask never wedges the ticket", async () => {
    await seedHolder({ lastEventAt: 0 });
    const first = await refused(5);
    const again = await refused(5);
    expect(again.release_command_id).toBe(first.release_command_id);
    expect(await releases()).toHaveLength(1);

    // The command settles without releasing (the session was human_attached when it was claimed,
    // say). Keying the ask would replay that row for ever and the release would never be asked
    // again — the dead end in miniature. It is asked again instead.
    const claimed = unwrap(
      await claimCommand(t.db, { types: ["session.handoff"] }),
    );
    expect(claimed?.id).toBe(first.release_command_id);
    unwrap(
      await completeCommand(t.db, String(first.release_command_id), {
        state: "failed",
        error: { class: "conflict", message: "not now", retryable: false },
      }),
    );
    const third = await refused(5);
    expect(third.reason).toBe("holder_releasing");
    expect(third.release_command_id).not.toBe(first.release_command_id);
    expect(await releases()).toHaveLength(2);
  });

  test("the release lands and the ticket is re-staffed, with no operator write", async () => {
    await seedHolder({ lastEventAt: 0 });
    expect(await refused(5)).toMatchObject({ reason: "holder_releasing" });

    // What the supervisor's claim writes (Invariant 5): the session ends, its packet is pending.
    unwrap(
      await seedRows(t.db, {
        handoffs: [
          {
            id: "H-STALE",
            ticket_id: "ticket-5",
            from_session_id: "S-HUNG",
            reason: "stale_session",
            facts_json: "{}",
            quality: "degraded",
            packet_path: "/tmp/H-STALE.md",
            packet_hash: "0".repeat(64),
            created_at: NOW,
          },
        ],
      }),
    );
    unwrap(
      await updateSessionState(t.db, "S-HUNG", {
        from: ["running"],
        to: "handed_off",
      }),
    );
    expect(await owners(5)).toEqual({ live: [], pending: ["H-STALE"] });

    const staffedNow = await staffed(5);
    expect(staffedNow.payload).toMatchObject({
      ticket_id: "ticket-5",
      handoff_id: "H-STALE",
    });
    // One spawn, on the ticket that could not be staffed at all a moment ago.
    expect((await spawns()).map((c) => c.id)).toEqual([staffedNow.command_id]);
  });
});
