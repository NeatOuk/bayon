import { FakeClock, systemClock } from "@bayon/core";
import { afterAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, openDb, type Db } from "../connection.js";
import type { HandoffRow } from "../schema-work.js";
import {
  addSession,
  seedRows,
  seedSpine,
  setBusyTimeoutForTest,
  tempDb,
  ticketRow,
  unwrap,
} from "../testing.js";
import {
  HANDOFF_ACCEPT_COLUMNS,
  HANDOFF_FACT_COLUMNS,
  HANDOFF_JUDGEMENT_COLUMNS,
  finalizeHandoffPacket,
  getHandoff,
  insertHandoffFacts,
  listPendingHandoffs,
  listStrandedHandoffs,
  sealHandoff,
  writeHandoffJudgement,
  type NewHandoffFacts,
} from "./handoffs.js";
import { getSession, updateSessionState } from "./sessions.js";
import { listTicketEvents } from "./ticket-events.js";
import { listNeedsAttention } from "./work-views.js";

// The hand-off writers: the column split, the seal race against the API's
// judgement write, the ticket's hand-off number, and the supervisor's audit rows.
const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

const TICKET = "ticket-1";
const BEGIN = { from: ["running", "idle"], to: "handoff_writing" } as const;
const HAND_OFF = {
  from: ["handoff_writing"],
  to: "handed_off",
  patch: { exit_reason: "ok" },
} as const;
const FAIL = {
  from: ["handoff_writing"],
  to: "exited",
  patch: { exit_reason: "abandoned", error_class: "timeout" },
} as const;
const JUDGEMENT = {
  goal_line: "Make the writer path single.",
  decisions_md: "- Guard in the service.",
  traps_md: null,
  next_steps_md: "1. Catch it.\n2. Fix it.\n3. Test it.",
  open_questions_md: null,
  pointers: ["plan: docs/spikes/x.md"],
};

/** A database at the latest migration, a ticket in building, and running sessions on it. */
async function setup(sessions: readonly string[] = ["S1"]) {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 5));
  unwrap(
    await seedRows(t.db, { tickets: [ticketRow(1, { status: "building" })] }),
  );
  for (const id of sessions) {
    unwrap(await addSession(t.db, id));
    unwrap(
      await updateSessionState(t.db, id, {
        from: ["pending"],
        to: "running",
        patch: { ticket_id: TICKET },
      }),
    );
  }
  return t;
}

const render = (n: number) => ({
  packet_path: `.foreman/handoff-${n}.md`,
  packet_hash: `${n}`.repeat(64).slice(0, 64),
  tokens_est: 10 * n,
});

const facts = (
  sessionId: string,
  o: Partial<NewHandoffFacts> = {},
): NewHandoffFacts => ({
  ticket_id: TICKET,
  from_session_id: sessionId,
  reason: "turn_ceiling",
  phase_from: "build",
  phase_to: "build",
  facts_json: '{"v":1}',
  quality: "writing",
  render,
  begin: BEGIN,
  ...o,
});

const begin = async (db: Db, sessionId = "S1") =>
  unwrap(await insertHandoffFacts(db, facts(sessionId)));

const seal = (db: Db, failed = false) =>
  sealHandoff(db, {
    session_id: "S1",
    handOff: HAND_OFF,
    handoffFail: FAIL,
    failed,
  });

const finalize = (db: Db, id: string, quality: "full" | "degraded") =>
  finalizeHandoffPacket(db, {
    id,
    facts_json: '{"v":1,"final":true}',
    quality,
    render: (row) => ({
      packet_path: row.packet_path,
      packet_hash: "f".repeat(64),
      tokens_est: row.goal_line === null ? 7 : 70,
    }),
  });

const audits = async (db: Db) =>
  unwrap(
    await listTicketEvents(db, { ticket_id: TICKET, since: 0, limit: 100 }),
  )
    .rows.filter((e) => e.kind === "handoff")
    .map((e) => ({
      actor: `${e.actor_kind}:${e.actor_id ?? ""}`,
      step: (JSON.parse(e.payload_json ?? "{}") as { step?: string }).step,
    }));

const pendingIds = async (db: Db) =>
  unwrap(await listPendingHandoffs(db)).map((row) => row.id);
const attentionIds = async (db: Db) =>
  unwrap(await listNeedsAttention(db))
    .filter((row) => row.why === "handoff_pending")
    .map((row) => row.ref);

describe("begin", () => {
  test("inserts a writing row, takes beginHandoff and links it, and audits as the supervisor", async () => {
    const { db } = await setup();
    const { row, created, n } = await begin(db);
    expect({ created, n, quality: row.quality }).toEqual({
      created: true,
      n: 1,
      quality: "writing",
    });
    expect(row.packet_path).toBe(".foreman/handoff-1.md");
    const s = unwrap(await getSession(db, "S1"));
    expect({ state: s.state, out: s.handoff_out_id }).toEqual({
      state: "handoff_writing",
      out: row.id,
    });
    expect(await audits(db)).toEqual([
      { actor: "supervisor:S1", step: "begin" },
    ]);
  });

  test("a writing row is not pending, in the predicate and in v_needs_attention", async () => {
    const { db } = await setup();
    await begin(db);
    expect(await pendingIds(db)).toEqual([]);
    expect(await attentionIds(db)).toEqual([]);
  });

  test("is idempotent per session: a second insert returns the row and writes nothing", async () => {
    const { db } = await setup();
    const first = await begin(db);
    const again = unwrap(await insertHandoffFacts(db, facts("S1")));
    expect(again).toEqual({ ...first, created: false });
    expect(await audits(db)).toHaveLength(1);
  });

  test("a render that throws rolls back the row, the move and the audit", async () => {
    const { db } = await setup();
    const failed = await insertHandoffFacts(
      db,
      facts("S1", {
        render: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(failed.ok).toBe(false);
    expect(unwrap(await getSession(db, "S1")).state).toBe("running");
    expect(await audits(db)).toEqual([]);
  });

  test("two sessions of one ticket on two connections get hand-offs 1 and 2", async () => {
    const t = await setup(["S1", "S2"]);
    const other = unwrap(await openDb({ path: t.path, clock }));
    cleanups.unshift(() => unwrap(internalsOf(other)).raw.close());
    const [a, b] = await Promise.all([
      insertHandoffFacts(t.db, facts("S1")),
      insertHandoffFacts(other, facts("S2")),
    ]);
    const paths = [unwrap(a).row.packet_path, unwrap(b).row.packet_path];
    expect(paths.toSorted()).toEqual([
      ".foreman/handoff-1.md",
      ".foreman/handoff-2.md",
    ]);
  });
});

describe("the seal race", () => {
  test("(a) judgement, then seal: handed off, and finalize makes it full and pending", async () => {
    const { db } = await setup();
    const { row } = await begin(db);
    unwrap(await writeHandoffJudgement(db, "S1", JUDGEMENT));
    const sealed = unwrap(await seal(db));
    expect({ judged: sealed.judged, handedOff: sealed.handedOff }).toEqual({
      judged: true,
      handedOff: true,
    });
    expect(sealed.session.state).toBe("handed_off");
    expect(sealed.handoff.goal_line).toBe(JUDGEMENT.goal_line);
    const final = unwrap(await finalize(db, row.id, "full"));
    expect({ quality: final.quality, tokens: final.tokens_est }).toEqual({
      quality: "full",
      tokens: 70,
    });
    expect(await pendingIds(db)).toEqual([row.id]);
    expect(await attentionIds(db)).toEqual([row.id]);
    expect((await audits(db)).map((a) => a.step)).toEqual([
      "begin",
      "seal",
      "finalize",
    ]);
  });

  test("(c) the API's judgement transaction holds the lock: the seal waits, then sees the judgement", async () => {
    const t = await setup();
    const { row } = await begin(t.db);
    // The supervisor's connection: real time for its busy retries, no busy_timeout of its own,
    // so it cannot block the thread the API's transaction commits on.
    const sealer = unwrap(
      await openDb({ path: t.path, clock: systemClock, random: () => 0.5 }),
    );
    cleanups.unshift(() => unwrap(internalsOf(sealer)).raw.close());
    unwrap(await setBusyTimeoutForTest(sealer, 0));
    const api = unwrap(internalsOf(t.db)).raw;
    api.prepare("BEGIN IMMEDIATE").run();
    // writeHandoffJudgement runs inside that open transaction (a savepoint): not committed yet.
    unwrap(await writeHandoffJudgement(t.db, "S1", JUDGEMENT));
    const sealing = seal(sealer);
    await new Promise((resolve) => setTimeout(resolve, 30));
    api.prepare("COMMIT").run();
    const sealed = unwrap(await sealing);
    expect(unwrap(internalsOf(sealer)).stats.busy).toBeGreaterThan(0);
    expect({
      handedOff: sealed.handedOff,
      goal: sealed.handoff.goal_line,
    }).toEqual({
      handedOff: true,
      goal: JUDGEMENT.goal_line,
    });
    expect(unwrap(await getHandoff(t.db, row.id)).goal_line).toBe(
      JUDGEMENT.goal_line,
    );
  });

  test("(b) seal, then judgement: the late write is refused and the row is unchanged", async () => {
    const { db } = await setup();
    const { row } = await begin(db);
    const sealed = unwrap(await seal(db));
    expect(sealed.handedOff).toBe(false);
    expect(sealed.session).toMatchObject({
      state: "exited",
      exit_reason: "abandoned",
    });
    const late = await writeHandoffJudgement(db, "S1", JUDGEMENT);
    expect(late).toMatchObject({ ok: false, error: { class: "conflict" } });
    expect(late.ok ? "" : late.error.message).toContain("handoff_not_writable");
    expect(unwrap(await getHandoff(db, row.id)).goal_line).toBeNull();
  });

  test("a judged run that failed or hit a cap is sealed abandoned all the same", async () => {
    const { db } = await setup();
    await begin(db);
    unwrap(await writeHandoffJudgement(db, "S1", JUDGEMENT));
    const sealed = unwrap(await seal(db, true));
    expect({ judged: sealed.judged, handedOff: sealed.handedOff }).toEqual({
      judged: true,
      handedOff: false,
    });
  });

  test("(d) handoff_write while the session is still running is refused", async () => {
    const { db } = await setup();
    const early = await writeHandoffJudgement(db, "S1", JUDGEMENT);
    expect(early).toMatchObject({ ok: false, error: { class: "conflict" } });
  });

  test("(f) a death out of handoff_writing is the seal: the write is refused, then finalize", async () => {
    const { db } = await setup();
    const { row } = await begin(db);
    unwrap(
      await updateSessionState(db, "S1", {
        from: ["handoff_writing"],
        to: "exited",
        patch: { exit_reason: "error" },
      }),
    );
    const late = await writeHandoffJudgement(db, "S1", JUDGEMENT);
    expect(late.ok).toBe(false);
    expect(unwrap(await finalize(db, row.id, "degraded")).quality).toBe(
      "degraded",
    );
  });

  test("(g) a crash between seal and finalize leaves a stranded row until it is finalized", async () => {
    const { db } = await setup();
    const { row } = await begin(db);
    unwrap(await writeHandoffJudgement(db, "S1", JUDGEMENT));
    expect(unwrap(await listStrandedHandoffs(db))).toEqual([]);
    unwrap(await seal(db));
    const stranded = unwrap(await listStrandedHandoffs(db));
    expect(stranded.map((s) => [s.id, s.session_state])).toEqual([
      [row.id, "handed_off"],
    ]);
    expect(await pendingIds(db)).toEqual([]);
    unwrap(await finalize(db, row.id, "full"));
    expect(unwrap(await listStrandedHandoffs(db))).toEqual([]);
  });

  test("a finalize after an accept matches no row: accept wins", async () => {
    const { db } = await setup();
    const { row } = await begin(db);
    unwrap(await seal(db));
    unwrap(internalsOf(db))
      .raw.prepare("UPDATE handoffs SET accepted_at = 1 WHERE id = ?")
      .run(row.id);
    const late = await finalize(db, row.id, "degraded");
    expect(late).toMatchObject({ ok: false, error: { class: "conflict" } });
    expect(unwrap(await getHandoff(db, row.id)).quality).toBe("writing");
  });

  test("a bad judgement is a validation error", async () => {
    const { db } = await setup();
    await begin(db);
    const bad = await writeHandoffJudgement(db, "S1", {
      ...JUDGEMENT,
      goal_line: "",
    });
    expect(bad).toMatchObject({ ok: false, error: { class: "validation" } });
  });
});

describe("column ownership (§9.5, M2 rule 2)", () => {
  const Columns = z.array(z.object({ name: z.string() }));

  test("the facts, judgement and accept columns partition the table", async () => {
    const { db } = await setup();
    const columns = Columns.parse(
      unwrap(internalsOf(db)).raw.prepare("PRAGMA table_info(handoffs)").all(),
    ).map((c) => c.name);
    const sets = [
      HANDOFF_FACT_COLUMNS,
      HANDOFF_JUDGEMENT_COLUMNS,
      HANDOFF_ACCEPT_COLUMNS,
    ].flat();
    expect(new Set(sets).size).toBe(sets.length);
    expect(sets.toSorted()).toEqual(columns.toSorted());
  });

  const changed = (before: HandoffRow | null, after: HandoffRow): string[] =>
    Object.keys(after).filter(
      (k) =>
        (before?.[k as keyof HandoffRow] ?? null) !==
        after[k as keyof HandoffRow],
    );

  test("each writer changes only its owner's columns", async () => {
    const { db } = await setup();
    const { row: inserted } = await begin(db);
    expect(
      changed(null, inserted).every((c) =>
        (HANDOFF_FACT_COLUMNS as readonly string[]).includes(c),
      ),
    ).toBe(true);
    const judged = unwrap(await writeHandoffJudgement(db, "S1", JUDGEMENT));
    expect(changed(inserted, judged).toSorted()).toEqual(
      [
        "decisions_md",
        "goal_line",
        "next_steps_md",
        "pointers_json",
      ].toSorted(),
    );
    unwrap(await seal(db));
    const sealed = unwrap(await getHandoff(db, inserted.id));
    expect(changed(judged, sealed)).toEqual([]);
    const final = unwrap(await finalize(db, inserted.id, "full"));
    expect(
      changed(sealed, final).every((c) =>
        (HANDOFF_FACT_COLUMNS as readonly string[]).includes(c),
      ),
    ).toBe(true);
  });
});
