import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  ATTENTION_ARMS,
  HUMAN_ONLY_ARMS,
  PULSE_ARMS,
  type AttentionWhy,
} from "../schema-work.js";
import {
  SPINE_SEED,
  newRunInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  updateRowForTest,
} from "../testing.js";
import type { Db } from "../connection.js";
import { hasPulseWork } from "./pulse-reads.js";
import { listNeedsAttention } from "./work-views.js";

// Which needs-attention arms are worth an LLM pulse. The point of the split is money:
// hasPulseWork is §9.7's free no-op check, so an arm the orchestrator cannot act on turns every due
// pulse into a paid session that can only shrug.
const T0 = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const clock = new FakeClock(T0);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function world(): Promise<Db> {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 12));
  return t.db;
}

test("every arm is classified exactly once, so a new one has to pick a side", () => {
  const classified = [...HUMAN_ONLY_ARMS, ...PULSE_ARMS];
  expect([...classified].sort()).toEqual([...ATTENTION_ARMS].sort());
  expect(new Set(classified).size).toBe(classified.length);
});

test("the human-only arms are the ones no orchestrator tool can touch", () => {
  // Spelled out rather than derived: the decision table in schema-work.ts is the argument, and this
  // is the assertion that the code still says what the table claims.
  expect([...HUMAN_ONLY_ARMS].sort()).toEqual([
    "advance_pending",
    "backup_failed",
    "budget_warn",
    "executor_unhealthy",
    "export_failed",
    "gate_stuck",
    "unanswered_human",
    "worktree_dirty",
    "worktree_kept",
  ] satisfies AttentionWhy[]);
});

test("a budget at its warn mark is the operator's call, not a pulse", async () => {
  const db = await world();
  // The budget window is the UTC day holding the Db's clock (044): the spend lands in the
  // FakeClock's day, and the arm is shown to fire, or this test would prove nothing.
  unwrap(
    await seedRows(db, {
      budgets: [
        {
          id: "b-day",
          scope: "fleet",
          scope_ref: null,
          period: "day",
          cap_usd: 10,
          warn_pct: 70,
          updated_at: T0,
        },
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
    }),
  );
  unwrap(
    await seedRows(db, {
      spend: [
        {
          id: "sp-1",
          run_id: "R-1",
          session_id: SPINE_SEED.sessionId,
          phase: "build",
          runner_id: SPINE_SEED.runnerId,
          model: "fixture-model",
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 9,
          cost_source: "reported",
          ts: clock.now(),
        },
      ],
    }),
  );
  expect(
    unwrap(await listNeedsAttention(db)).filter((r) => r.why === "budget_warn"),
  ).toEqual([{ why: "budget_warn", ref: "b-day", ticket_id: null }]);
  expect(unwrap(await hasPulseWork(db, 0))).toBe(false);
});

test("an unhealthy executor, a failed backup and a failed export never wake a pulse", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      backups: [
        {
          id: "bk-1",
          started_at: T0 - 1000,
          ended_at: T0,
          outcome: "failed",
          error: "disk full",
        },
      ],
      tickets: [ticketRow(7)],
    }),
  );
  unwrap(
    await seedRows(db, {
      ticket_exports: [
        { ticket_id: "ticket-7", target: "markdown", state: "failed" },
      ],
    }),
  );
  unwrap(
    await updateRowForTest(db, "executors", SPINE_SEED.executorId, {
      health: "unhealthy",
      enabled: 1,
    }),
  );
  expect(unwrap(await hasPulseWork(db, 0))).toBe(false);
});

test("a question the operator has not answered is the one thing a pulse cannot help with", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      human_requests: [
        {
          id: "hr-1",
          session_id: SPINE_SEED.sessionId,
          ticket_id: null,
          kind: "question",
          question: "which repo?",
          status: "open",
          asked_at: T0 - DAY_MS - 1000,
        },
      ],
    }),
  );
  expect(unwrap(await hasPulseWork(db, 0))).toBe(false);
});

test("one actionable arm alongside them is still worth the pulse", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      backups: [
        {
          id: "bk-1",
          started_at: T0 - 1000,
          ended_at: T0,
          outcome: "failed",
          error: "disk full",
        },
      ],
    }),
  );
  expect(unwrap(await hasPulseWork(db, 0))).toBe(false);
  unwrap(
    await seedRows(db, {
      tickets: [ticketRow(41, { status: "prioritized" })],
    }),
  );
  expect(unwrap(await hasPulseWork(db, 0))).toBe(true);
});
