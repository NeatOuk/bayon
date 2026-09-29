import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf, type Db } from "../connection.js";
import { migrateUp } from "../migrate.js";
import {
  listAudit,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "../testing.js";
import { appendAudit, type AuditEntry } from "./audit.js";
import { auditWorkspace } from "./audit-scope.js";

// The project an audit row is about: insertAudit stamps it on every new row, and 031's
// backfill gives the rows already there the same answer. One table of cases drives both: every
// target kind, a missing target, the session-actor fallback, and what stays NULL.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

/** A database at schema `to` (the latest when absent) with every target kind's rows. */
async function dbAt(to?: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, to === undefined ? {} : { to }));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, to ?? 1));
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        { id: "P", name: "P", kind: "single" },
        { id: "Q", name: "Q", kind: "single" },
      ],
      agents: [
        {
          id: "p-builder",
          name: "p-builder",
          kind: "builder",
          runner_id: "fixture",
          workspace_id: "P",
          created_at: 0,
        },
      ],
      tickets: [
        ticketRow(1, { workspace_id: "P" }),
        ticketRow(2, { workspace_id: null }),
      ],
      sessions: [
        // Its own workspace wins over its (unscoped) agent's.
        {
          ...newSessionInput(),
          id: "s-own",
          workspace_id: "Q",
          state: "idle",
          created_at: 0,
        },
        // No workspace of its own: its agent's.
        {
          ...newSessionInput(),
          id: "s-agent",
          agent_id: "p-builder",
          state: "idle",
          created_at: 0,
        },
        // Neither.
        { ...newSessionInput(), id: "s-none", state: "idle", created_at: 0 },
      ],
      human_requests: [
        {
          id: "r-ticket",
          ticket_id: "ticket-1",
          session_id: "s-own",
          kind: "decision",
          question: "?",
          asked_at: 0,
        },
        {
          id: "r-session",
          session_id: "s-own",
          kind: "decision",
          question: "?",
          asked_at: 0,
        },
        {
          id: "r-unscoped-ticket",
          ticket_id: "ticket-2",
          session_id: "s-agent",
          kind: "decision",
          question: "?",
          asked_at: 0,
        },
        { id: "r-none", kind: "circuit_breaker", question: "?", asked_at: 0 },
      ],
      pulses: [
        {
          id: "pulse-p",
          agent_id: "p-builder",
          trigger: "cron",
          scheduled_at: 0,
          state: "done",
        },
        {
          id: "pulse-free",
          agent_id: "agent-fixture",
          trigger: "cron",
          scheduled_at: 0,
          state: "done",
        },
      ],
      gates: [
        {
          id: "g-1",
          ticket_id: "ticket-1",
          kind: "code_review",
          state: "running",
          subject_kind: "diff",
          subject_ref: "x",
          started_at: 0,
        },
        {
          id: "g-2",
          ticket_id: "ticket-2",
          kind: "code_review",
          state: "running",
          subject_kind: "diff",
          subject_ref: "x",
          started_at: 0,
        },
      ],
      findings: [
        {
          id: "f-1",
          gate_id: "g-1",
          severity: "minor",
          summary: "s",
          created_at: 0,
        },
        {
          id: "f-2",
          gate_id: "g-2",
          severity: "minor",
          summary: "s",
          created_at: 0,
        },
      ],
    }),
  );
  return t.db;
}

type Case = readonly [
  actor: string,
  target_kind: string | null,
  target_id: string | null,
  expected: string | null,
];

const CASES: readonly Case[] = [
  ["operator", "ticket", "ticket-1", "P"],
  ["session:s-own", "ticket", "ticket-2", "Q"], // an unscoped ticket: the actor's project
  ["operator", "ticket", "ticket-99", null],
  ["operator", "project", "P", "P"],
  ["operator", "project", "nope", null], // a refused attempt on no project
  ["operator", "agent", "p-builder", "P"],
  ["operator", "agent", "agent-fixture", null],
  ["operator", "session", "s-own", "Q"],
  ["operator", "session", "s-agent", "P"],
  ["session:s-agent", "session", "s-none", "P"],
  ["operator", "human_request", "r-ticket", "P"],
  ["operator", "human_request", "r-session", "Q"],
  ["operator", "human_request", "r-unscoped-ticket", "P"],
  ["operator", "human_request", "r-none", null],
  ["supervisor", "pulse", "pulse-p", "P"],
  ["supervisor", "pulse", "pulse-free", null],
  ["supervisor", "finding", "f-1", "P"],
  ["supervisor", "finding", "f-2", null],
  ["session:s-own", "setting", "x", "Q"],
  ["operator", "setting", "x", null],
  ["session:s-agent", null, null, "P"],
  ["supervisor", "ticket", null, null],
  ["operator", "constructor", "x", null], // caller text never reaches Object.prototype
  ["session:ghost", null, null, null],
  ["Session:s-own", null, null, null], // the prefix is byte-exact, as instr() is
];

const entryOf = (
  [actor, target_kind, target_id]: Case,
  i: number,
): AuditEntry => ({
  actor,
  action: `case.${i}`,
  target_kind,
  target_id,
});

test("insertAudit stamps each new row with its project: every target kind, then the actor", async () => {
  const db = await dbAt();
  for (const [i, c] of CASES.entries())
    unwrap(await appendAudit(db, entryOf(c, i)));
  const rows = unwrap(await listAudit(db));
  expect(rows.map((r) => [r.action, r.workspace_id])).toEqual(
    CASES.map((c, i) => [`case.${i}`, c[3]]),
  );
});

test("031's backfill and the TypeScript resolver agree on every row already there", async () => {
  const db = await dbAt(30);
  unwrap(
    await seedRows(db, {
      audit_log: CASES.map(([actor, target_kind, target_id], i) => ({
        ts: i,
        actor,
        action: `case.${i}`,
        target_kind,
        target_id,
      })),
    }),
  );
  unwrap(await migrateUp(db, { to: 31 }));
  const rows = unwrap(await listAudit(db));
  const ix = unwrap(internalsOf(db));
  const sql = rows.map((r) => r.workspace_id);
  const ts = rows.map((r) => auditWorkspace(ix, r));
  expect(sql).toEqual(CASES.map((c) => c[3]));
  expect(ts).toEqual(sql);
});
