import { readdirSync, readFileSync } from "node:fs";
import { FakeClock } from "@bayon/core";
import { z } from "zod";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { internalsOf, type Db } from "../connection.js";
import {
  SPINE_SEED,
  newRunInput,
  newSessionInput,
  seedRows,
  seedSpine,
  sqlClockFollowsDate,
  tempDb,
  ticketRow,
  unwrap,
} from "../testing.js";
import { listBudgets } from "./budgets.js";
import { listNeedsAttention } from "./work-views.js";

// attentionAt (044): v_needs_attention's arms age on the injected clock and nothing
// else. Until 044 five arms read SQLite's own clock, so tests seeded at a fixed date broke the day
// the real date passed it. Here the system date is faked a year away on both sides, for JavaScript
// (vi.setSystemTime) and for SQLite (sqlClockFollowsDate), and only the FakeClock moves an arm.

const T0 = Date.UTC(2026, 8, 22, 12);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const YEAR = 365 * DAY;
/** Today, read before any test fakes the date. */
const TODAY = Date.now();

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbOn(clock: FakeClock): Promise<Db> {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 44));
  return t.db;
}

const standing = async (db: Db): Promise<string[]> =>
  unwrap(await listNeedsAttention(db)).map((r) => `${r.why}:${r.ref}`);

const sqlNow = (db: Db): number =>
  z
    .number()
    .parse(
      unwrap(internalsOf(db)).raw.prepare("SELECT unixepoch()").pluck().get(),
    );

/** One row per timed arm, each starting its wait at the FakeClock's now, and a budget over its mark. */
async function seedTimedArms(db: Db, clock: FakeClock): Promise<void> {
  const now = clock.now();
  unwrap(
    await seedRows(db, {
      tickets: [
        ticketRow(1, { status: "building" }),
        ticketRow(2, { status: "code_review", updated_at: now }),
      ],
      sessions: [
        {
          ...newSessionInput(),
          id: "S-QUIET",
          state: "running",
          last_event_at: now,
          created_at: now,
        },
      ],
      runs: [
        {
          ...newRunInput(SPINE_SEED.sessionId),
          id: "R-1",
          seq: 1,
          state: "ok" as const,
          started_at: now,
        },
      ],
      gates: [
        {
          id: "G-RUN",
          ticket_id: "ticket-1",
          kind: "code_review",
          state: "running",
          subject_kind: "diff",
          subject_ref: "HEAD",
          started_at: now,
        },
        {
          id: "G-PASS",
          ticket_id: "ticket-2",
          kind: "code_review",
          state: "passed",
          subject_kind: "diff",
          subject_ref: "HEAD",
          decided_at: now,
        },
      ],
      human_requests: [
        {
          id: "H-1",
          ticket_id: "ticket-1",
          kind: "decision",
          question: "Which API?",
          asked_at: now,
        },
      ],
      budgets: [
        {
          id: "B-DAY",
          scope: "fleet",
          period: "day",
          cap_usd: 10,
          warn_pct: 50,
          updated_at: now,
        },
      ],
    }),
  );
  unwrap(
    await seedRows(db, {
      spend: [
        {
          id: "SP-1",
          run_id: "R-1",
          session_id: SPINE_SEED.sessionId,
          phase: "build",
          runner_id: SPINE_SEED.runnerId,
          model: "fixture-model",
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 6,
          cost_source: "reported",
          ts: now,
        },
      ],
    }),
  );
}

describe.each([
  ["a year ahead of today", TODAY + YEAR],
  ["a year behind the test's clock", T0 - YEAR],
])("with the system date %s", (_label, systemNow) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(systemNow);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("each timed arm waits its own time on the FakeClock, and budget_warn keeps its day", async () => {
    const clock = new FakeClock(T0);
    const db = await dbOn(clock);
    unwrap(sqlClockFollowsDate(db));
    // SQL's own clock is at the faked date, a year from the FakeClock: an arm that read it would
    // have listed everything at once (behind) or nothing ever (ahead).
    expect(sqlNow(db)).toBe(Math.floor(systemNow / 1000));
    await seedTimedArms(db, clock);

    await clock.advance(MINUTE);
    expect(await standing(db)).toEqual(["budget_warn:B-DAY"]);

    // Each just short of its wait: advance_pending 5 min, gate_stuck 15 min, stale_session 30 min.
    await clock.advance(4 * MINUTE - 1);
    expect(await standing(db)).toEqual(["budget_warn:B-DAY"]);
    await clock.advance(2);
    expect(await standing(db)).toEqual([
      "advance_pending:ticket-2",
      "budget_warn:B-DAY",
    ]);
    await clock.advance(10 * MINUTE);
    expect(await standing(db)).toContain("gate_stuck:G-RUN");
    expect(await standing(db)).not.toContain("stale_session:S-QUIET");
    await clock.advance(15 * MINUTE);
    expect(await standing(db)).toContain("stale_session:S-QUIET");
    expect(await standing(db)).not.toContain("unanswered_human:H-1");

    // A day after it was asked the question stands; the spend is yesterday's, so the budget does not.
    await clock.advance(T0 + DAY + 1 - clock.now());
    expect(await standing(db)).toEqual([
      "advance_pending:ticket-2",
      "gate_stuck:G-RUN",
      "stale_session:S-QUIET",
      "unanswered_human:H-1",
    ]);
  });
});

test("sqlClockFollowsDate moves SQLite's 'now', and only 'now', with the faked date", async () => {
  const db = await dbOn(new FakeClock(T0));
  const raw = unwrap(internalsOf(db)).raw;
  const one = (sql: string): unknown => raw.prepare(sql).pluck().get();
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.UTC(2031, 0, 15, 10, 30));
    unwrap(sqlClockFollowsDate(db));
    expect(one("SELECT unixepoch()")).toBe(
      Date.UTC(2031, 0, 15, 10, 30) / 1000,
    );
    expect(one("SELECT unixepoch('NOW', 'start of day')")).toBe(
      Date.UTC(2031, 0, 15) / 1000,
    );
    expect(one("SELECT date()")).toBe("2031-01-15");
    expect(one("SELECT datetime('now', '+1 day')")).toBe("2031-01-16 10:30:00");
    expect(one("SELECT strftime('%Y-%m')")).toBe("2031-01");
    expect(
      one("SELECT julianday('now') - julianday('2031-01-15')"),
    ).toBeCloseTo(10.5 / 24, 9);
    // Any other time value is SQLite's to compute, as it always was.
    expect(one("SELECT date('2020-02-29', '+1 year')")).toBe("2021-03-01");
    expect(one("SELECT unixepoch('1970-01-02')")).toBe(86_400);
    vi.setSystemTime(Date.UTC(2032, 5, 1));
    expect(one("SELECT date()")).toBe("2032-06-01");
  } finally {
    vi.useRealTimers();
  }
});

test("budget_warn lists exactly the budgets listBudgets shows at their warn mark, on the same clock", async () => {
  const clock = new FakeClock(Date.UTC(2026, 8, 30, 23, 59));
  const db = await dbOn(clock);
  const now = clock.now();
  const budget = (
    id: string,
    scope: "fleet" | "agent",
    period: "day" | "month",
    caps: { cap_usd?: number; cap_tokens?: number },
  ) => ({
    id,
    scope,
    scope_ref: scope === "agent" ? SPINE_SEED.agentId : null,
    period,
    cap_usd: caps.cap_usd ?? null,
    cap_tokens: caps.cap_tokens ?? null,
    warn_pct: 50,
    updated_at: now,
  });
  const run = (id: string, session: string) => ({
    ...newRunInput(session),
    id,
    seq: 1,
    state: "ok" as const,
    started_at: 0,
  });
  unwrap(
    await seedRows(db, {
      agents: [
        {
          id: "A-2",
          name: "builder-2",
          kind: "builder",
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          created_at: 0,
        },
      ],
      sessions: [
        {
          ...newSessionInput(),
          id: "S-2",
          agent_id: "A-2",
          state: "exited",
          created_at: 0,
        },
      ],
      runs: [run("R-1", SPINE_SEED.sessionId), run("R-2", "S-2")],
      budgets: [
        // The fleet's day: $13 today of $5. The spine agent's: its own $3 of $7, under the mark.
        budget("B-FLEET-DAY", "fleet", "day", { cap_usd: 5 }),
        budget("B-AGENT-DAY", "agent", "day", { cap_usd: 7 }),
        // The month by tokens: 600 of the fleet's 1000. The agent's $7 of $20 and 600 of 2000.
        budget("B-FLEET-MONTH", "fleet", "month", { cap_tokens: 1000 }),
        budget("B-AGENT-MONTH", "agent", "month", {
          cap_usd: 20,
          cap_tokens: 2000,
        }),
      ],
    }),
  );
  const spend = (
    id: string,
    runId: string,
    session: string,
    ts: number,
    cost_usd: number,
    tokens: number,
  ) => ({
    id,
    run_id: runId,
    session_id: session,
    phase: "build",
    runner_id: SPINE_SEED.runnerId,
    model: "fixture-model",
    tokens_in: tokens,
    tokens_out: 0,
    cost_usd,
    cost_source: "reported" as const,
    ts,
  });
  const spine = SPINE_SEED.sessionId;
  unwrap(
    await seedRows(db, {
      spend: [
        spend("SP-TODAY", "R-1", spine, now - 60 * MINUTE, 3, 300),
        spend("SP-YESTERDAY", "R-1", spine, now - DAY, 4, 300),
        spend("SP-OTHER", "R-2", "S-2", now - MINUTE, 10, 0),
        // Last month: in no window.
        spend("SP-AUGUST", "R-1", spine, Date.UTC(2026, 7, 31, 12), 100, 5000),
      ],
    }),
  );
  const atMark = async () =>
    unwrap(await listBudgets(db))
      .filter(
        (b) =>
          (b.cap_usd !== null &&
            b.spent_usd >= (b.cap_usd * b.warn_pct) / 100) ||
          (b.cap_tokens !== null &&
            b.spent_tokens >= (b.cap_tokens * b.warn_pct) / 100),
      )
      .map((b) => b.id)
      .toSorted();
  const arm = async () =>
    unwrap(await listNeedsAttention(db))
      .filter((r) => r.why === "budget_warn")
      .map((r) => r.ref)
      .toSorted();
  expect(await arm()).toEqual(["B-FLEET-DAY", "B-FLEET-MONTH"]);
  expect(await arm()).toEqual(await atMark());

  // Past midnight on the last of the month both windows turn over: nothing is at its mark.
  await clock.advance(2 * MINUTE);
  expect(await arm()).toEqual([]);
  expect(await atMark()).toEqual([]);
});

// The raw view lists timed rows at any age, so every read goes through attentionAt. A reader that
// selects from the view directly is how the real clock's twin — no clock at all — would come back.
const SRC = new URL("../", import.meta.url);
const sources = (dir: URL): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(new URL(`${e.name}/`, dir))
      : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")
        ? [new URL(e.name, dir).pathname.slice(SRC.pathname.length)]
        : [],
  );

test("only attentionAt, and the migration tests' raw helper, select from v_needs_attention", () => {
  const readers = sources(SRC).filter((rel) =>
    /selectFrom\(\s*"v_needs_attention|FROM\s+v_needs_attention/.test(
      readFileSync(new URL(rel, SRC), "utf8"),
    ),
  );
  expect(readers.toSorted()).toEqual(["repos/attention.ts", "testing.ts"]);
});
