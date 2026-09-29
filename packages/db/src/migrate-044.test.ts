import { FakeClock } from "@bayon/core";
import type { Insertable } from "kysely";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { listNeedsAttention } from "./repos/work-views.js";
import type { SessionsTable, WorktreesTable } from "./schema.js";
import { ATTENTION_ARMS, type GatesTable } from "./schema-work.js";
import {
  SPINE_SEED,
  dumpAllRows,
  newRunInput,
  newSessionInput,
  rawAttentionForTest,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  updateRowForTest,
} from "./testing.js";

// 044_attention_clock: v_needs_attention stops reading SQLite's own clock. Its timed
// arms carry `since` and `after_ms` and the reader cuts them at the injected now; budget_warn moves
// to the reader. On an empty database and on one holding a row for every arm (and a near miss for
// every timed one): at a `now` equal to real time, the reader lists exactly what 043's view did.
// Down is 043's view again, byte for byte.
const THIS = 44;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number, clock: FakeClock): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;
const version = async (db: Db): Promise<number> =>
  unwrap(await migrationStatus(db)).applied.at(-1)?.version ?? 0;
const viewText = (db: Db): string =>
  z
    .string()
    .parse(
      rawOf(db)
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'v_needs_attention'",
        )
        .pluck()
        .get(),
    );
const viewColumns = (db: Db): string[] =>
  z
    .array(z.string())
    .parse(
      rawOf(db)
        .prepare("SELECT name FROM pragma_table_info('v_needs_attention')")
        .pluck()
        .all(),
    );

test("044 on an empty database: the view gains since and after_ms and no clock; down is 043's text; up again", async () => {
  const db = await dbAt(THIS - 1, new FakeClock(Date.UTC(2026, 8, 24)));
  const before = viewText(db);
  expect(before).toContain("unixepoch()*1000 - 86400000");
  expect(viewColumns(db)).toEqual(["why", "ref", "ticket_id"]);

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
  expect(viewColumns(db)).toEqual([
    "why",
    "ref",
    "ticket_id",
    "since",
    "after_ms",
  ]);
  expect(viewText(db)).not.toMatch(/unixepoch|'now'|julianday|strftime/);
  expect(viewText(db)).not.toContain("'budget_warn'");
  expect(unwrap(await listNeedsAttention(db))).toEqual([]);

  unwrap(await migrateDown(db));
  expect(await version(db)).toBe(THIS - 1);
  expect(viewText(db)).toBe(before);
  expect(viewColumns(db)).toEqual(["why", "ref", "ticket_id"]);

  unwrap(await migrateUp(db, { to: THIS }));
  expect(await version(db)).toBe(THIS);
});

/**
 * A row for every arm, and beside each timed one a row just inside its wait (by minutes, far from
 * the second 043's `unixepoch()` truncates to), all relative to `now`: real time.
 */
async function seedEveryArm(db: Db, now: number): Promise<void> {
  const gate = (
    id: string,
    ticket: number,
    o: {
      kind?: Insertable<GatesTable>["kind"];
      state: Insertable<GatesTable>["state"];
      subject_kind?: string;
      started_at?: number;
      decided_at?: number;
    },
  ): Insertable<GatesTable> => ({
    id,
    ticket_id: `ticket-${ticket}`,
    kind: o.kind ?? "code_review",
    state: o.state,
    attempt: 1,
    round: 1,
    subject_kind: o.subject_kind ?? "diff",
    subject_ref: "HEAD",
    started_at: o.started_at ?? null,
    decided_at: o.decided_at ?? null,
  });
  const session = (
    id: string,
    state: Insertable<SessionsTable>["state"],
    last_event_at: number | null,
  ): Insertable<SessionsTable> => ({
    ...newSessionInput(),
    id,
    state,
    last_event_at,
    created_at: 0,
  });
  const handoff = (id: string, accepted_at: number | null) => ({
    id,
    ticket_id: "ticket-7",
    reason: "turn_ceiling",
    facts_json: "{}",
    packet_path: `.foreman/${id}.md`,
    packet_hash: "0".repeat(64),
    accepted_at,
    created_at: now - HOUR,
  });
  const question = (id: string, asked_at: number, status = "open") => ({
    id,
    ticket_id: "ticket-1",
    kind: "decision",
    question: `${id}?`,
    asked_at,
    status,
  });
  const worktree = (
    id: string,
    state: Insertable<WorktreesTable>["state"],
    kept_reason: Insertable<WorktreesTable>["kept_reason"],
  ): Insertable<WorktreesTable> => ({
    id,
    session_root: `/w/${id}`,
    workspace_id: "W",
    repo_id: "R",
    path: `/w/${id}/repo`,
    branch: `frm/${id}`,
    base_sha: "abc",
    state,
    kept_reason,
    created_at: 0,
  });
  unwrap(
    await seedRows(db, {
      repos: [{ id: "R", name: "R", mirror_path: "/m/r.git" }],
      workspaces: [{ id: "W", name: "W", kind: "single" }],
      // stale_session on the operator's own threshold, not the 30-minute default.
      settings: [
        { key: "watchdog.silent_ms", value_json: "600000", updated_at: 0 },
      ],
      tickets: [
        ticketRow(1, { status: "building" }),
        // advance_pending: a passed round resting 6 minutes; 3 and 4 moved within the 5.
        ticketRow(2, { status: "code_review", updated_at: now - 6 * MINUTE }),
        ticketRow(3, { status: "code_review", updated_at: now - 4 * MINUTE }),
        ticketRow(4, { status: "qa_harness", updated_at: now - 10 * MINUTE }),
        ticketRow(5, { status: "prioritized" }),
        ticketRow(6, { status: "code_review" }),
        ticketRow(7, { status: "building" }),
        ticketRow(8, { status: "staffed" }),
      ],
      sessions: [
        session("S-STALE", "running", now - 11 * MINUTE),
        session("S-FRESH", "idle", now - 9 * MINUTE),
        session("S-SILENT", "running", null),
        session("S-ENDED", "exited", now - 2 * HOUR),
      ],
      runs: [
        {
          ...newRunInput(SPINE_SEED.sessionId),
          id: "R-1",
          seq: 1,
          state: "ok" as const,
          started_at: 0,
        },
      ],
      spend: [
        {
          id: "SP-1",
          run_id: "R-1",
          session_id: SPINE_SEED.sessionId,
          phase: "build",
          runner_id: SPINE_SEED.runnerId,
          model: "fixture-model",
          tokens_in: 500,
          tokens_out: 0,
          cost_usd: 6,
          cost_source: "reported",
          ts: now,
        },
      ],
      worktrees: [
        worktree("WT-DIRTY", "dirty", null),
        worktree("WT-KEPT", "idle", "locked"),
        worktree("WT-GONE", "removed", "dirty"),
      ],
      commands: [
        {
          id: "C-SPAWN",
          ts: now - HOUR,
          type: "session.spawn",
          payload_json: JSON.stringify({
            ticket_id: "ticket-8",
            session_id: "S-NEVER",
          }),
          state: "failed",
        },
      ],
      ticket_exports: [
        { ticket_id: "ticket-1", target: "markdown", state: "failed" },
      ],
      gates: [
        // gate_stuck, running: 16 minutes past its start is stuck, 14 is not, a CI gate never is.
        gate("G-HUNG", 1, { state: "running", started_at: now - 16 * MINUTE }),
        gate("G-BUSY", 1, {
          kind: "ce_review",
          state: "running",
          started_at: now - 14 * MINUTE,
        }),
        gate("G-CI", 1, {
          kind: "qa_harness",
          state: "running",
          subject_kind: "pull_request",
          started_at: now - 2 * HOUR,
        }),
        gate("G-2", 2, { state: "passed", decided_at: now - 6 * MINUTE }),
        gate("G-3", 3, { state: "passed", decided_at: now - 10 * MINUTE }),
        gate("G-4", 4, {
          kind: "qa_harness",
          state: "passed",
          decided_at: now - 4 * MINUTE,
        }),
        // gate_stuck, failed: the latest attempt, its ticket still in review.
        gate("G-6", 6, { state: "failed", decided_at: now - HOUR }),
      ],
      findings: [
        {
          id: "F-1",
          gate_id: "G-6",
          severity: "blocker",
          summary: "F-1",
          created_at: 0,
        },
        {
          id: "F-2",
          gate_id: "G-HUNG",
          severity: "nit",
          summary: "F-2",
          created_at: 0,
        },
      ],
      // split_candidate at the seeded threshold of 4, and one of them handoff_pending.
      handoffs: [
        handoff("HO-1", now - HOUR),
        handoff("HO-2", now - HOUR),
        handoff("HO-3", now - HOUR),
        handoff("HO-4", null),
      ],
      messages: [
        {
          id: "M-UNREAD",
          ts: 0,
          from_kind: "human",
          from_id: "operator",
          to_kind: "agent",
          to_id: SPINE_SEED.agentName,
          kind: "note",
          subject: "s",
          body_md: "b",
        },
        {
          id: "M-READ",
          ts: 0,
          from_kind: "human",
          from_id: "operator",
          to_kind: "agent",
          to_id: SPINE_SEED.agentName,
          kind: "note",
          subject: "s",
          body_md: "b",
          read_at: 1,
        },
      ],
      // unanswered_human: 25 hours open is a day unanswered, 23 is not, an answer ends it.
      human_requests: [
        question("H-OLD", now - 25 * HOUR),
        question("H-NEW", now - 23 * HOUR),
        question("H-ANSWERED", now - 72 * HOUR, "answered"),
      ],
      // budget_warn: today's $6 of a $10 day at 50 %; 500 tokens of an agent's 1000 at 70 % is not.
      budgets: [
        {
          id: "B-DAY",
          scope: "fleet",
          period: "day",
          cap_usd: 10,
          warn_pct: 50,
          updated_at: 0,
        },
        {
          id: "B-AGENT",
          scope: "agent",
          scope_ref: SPINE_SEED.agentId,
          period: "month",
          cap_tokens: 1000,
          warn_pct: 70,
          updated_at: 0,
        },
      ],
      backups: [
        {
          id: "K-1",
          started_at: now - 2 * MINUTE,
          ended_at: now - MINUTE,
          outcome: "failed",
          error: "disk",
        },
      ],
    }),
  );
  unwrap(
    await updateRowForTest(db, "executors", SPINE_SEED.executorId, {
      enabled: 1,
      health: "unhealthy",
    }),
  );
}

test("044 on a seeded database: at real time the reader lists exactly what 043's view did, every arm", async () => {
  const now = Date.now();
  // The Db's clock is real time, frozen: the reader's now, a few milliseconds before 043's read.
  const db = await dbAt(THIS - 1, new FakeClock(now));
  unwrap(await seedSpine(db, THIS - 1));
  await seedEveryArm(db, now);
  const before = unwrap(await rawAttentionForTest(db));
  // The seed reaches every arm, so the comparison below covers each.
  expect([...new Set(before.map((r) => r.why))].toSorted()).toEqual(
    [...ATTENTION_ARMS].toSorted(),
  );
  expect(before.map((r) => `${r.why}:${r.ref}`)).toEqual([
    "advance_pending:ticket-2",
    "backup_failed:K-1",
    "budget_warn:B-DAY",
    "executor_unhealthy:" + SPINE_SEED.executorId,
    "export_failed:markdown",
    "findings_open:G-6",
    "gate_stuck:G-6",
    "gate_stuck:G-HUNG",
    "handoff_pending:HO-4",
    "spawn_failed:C-SPAWN",
    "split_candidate:ticket-7",
    "stale_session:S-STALE",
    "unanswered_human:H-OLD",
    "unread_message:M-UNREAD",
    "unstaffed_ready:ticket-5",
    "worktree_dirty:WT-DIRTY",
    "worktree_kept:WT-KEPT",
  ]);
  /** Every table's rows but the migration ledger's, which 044 itself writes to. */
  const tableRows = async () =>
    Object.entries(unwrap(await dumpAllRows(db))).filter(
      ([table]) => table !== "_migrations",
    );
  const rows = await tableRows();

  unwrap(await migrateUp(db, { to: THIS }));
  expect(unwrap(await listNeedsAttention(db))).toEqual(before);
  // A view's change: every table row is as it was.
  expect(await tableRows()).toEqual(rows);

  unwrap(await migrateDown(db));
  expect(unwrap(await rawAttentionForTest(db))).toEqual(before);
});
