// The pulse scheduler's wakes (–§4, the ticket's fake-clock list, review H2 and
// M6): a real temp SQLite file, the fixture as the orchestrator on FakeExecutor, a FakeClock.
import { FakeClock, err } from "@bayon/core";
import { getSession, listPulses, type PulseRow } from "@bayon/db";
import { seedRows, tempDb, ticketRow, unwrap } from "@bayon/db/testing";
import { afterEach, expect, test, vi } from "vitest";
import {
  AGENT_ID,
  CMD,
  spawnPayload,
  tempHome,
} from "../lifecycle/testing/fixtures.js";
import type { ContextPackBuilder, PulseGate } from "./ports.js";
import { pulseRunHandler } from "./pulse-commands.js";
import type { FixtureScriptInput } from "@bayon/runners/fixture";
import {
  HANG,
  MIN,
  ORCH,
  T0,
  WAIT,
  pulseRows,
  startRig,
  type AgentOverrides,
  type BudgetSeed,
  type Rig,
} from "./testing/rig.js";

// Hours of fake time, each tick and reconciler pass real database work: over the 5 s default.
vi.setConfig({ testTimeout: 30_000 });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A prioritized, unstaffed ticket: v_needs_attention is not empty, so a pulse has work. */
const WORK = { tickets: [ticketRow(1, { status: "prioritized" })] };

async function setup(
  o: {
    agent?: AgentOverrides;
    work?: boolean;
    settings?: Record<string, number>;
    pack?: ContextPackBuilder;
    gate?: PulseGate;
    pulses?: PulseRow[];
    script?: FixtureScriptInput;
    /** §13.4 budgets the gate reads (M4-c). */
    budgets?: readonly BudgetSeed[];
    /** The builder's max_concurrency; default the column's 1 (admission's real default). */
    builderConcurrency?: number;
  } = {},
) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome();
  const rows = pulseRows({
    ...(o.agent === undefined ? {} : { agent: o.agent }),
    ...(o.settings === undefined ? {} : { settings: o.settings }),
    ...(o.script === undefined ? {} : { script: o.script }),
    ...(o.budgets === undefined ? {} : { budgets: o.budgets }),
  });
  const builders = o.builderConcurrency;
  unwrap(
    await seedRows(t.db, {
      ...rows,
      agents:
        builders === undefined
          ? rows.agents
          : rows.agents.map((a) =>
              a.id === AGENT_ID ? { ...a, max_concurrency: builders } : a,
            ),
      ...(o.work === true ? WORK : {}),
      ...(o.pulses === undefined ? {} : { pulses: o.pulses }),
    }),
  );
  const rig = await startRig({
    db: t.db,
    clock,
    home: home.path,
    ...(o.pack === undefined ? {} : { pack: o.pack }),
    ...(o.gate === undefined ? {} : { gate: o.gate }),
  });
  cleanups.push(async () => {
    await rig.stop();
    t.cleanup();
    home.cleanup();
  });
  return { clock, db: t.db, ...rig };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const LIVE = ["leased", "running"];
/** ORCH's pulses, oldest first. */
const pulsesOf = async (s: Setup) =>
  unwrap(await listPulses(s.db, { agent_id: ORCH, limit: 100 })).toReversed();

/** Waits until `n` of ORCH's pulses have ended; returns them all, oldest first. */
async function ended(s: Setup, n: number): Promise<PulseRow[]> {
  let rows: PulseRow[] = [];
  await vi.waitFor(async () => {
    await s.settle();
    rows = await pulsesOf(s);
    expect(rows.filter((p) => !LIVE.includes(p.state))).toHaveLength(n);
  }, WAIT);
  await s.settle();
  return rows;
}

/** A pack that fails at once: the pulse ran (it counts) but spawns nothing. */
const FAILING_PACK: ContextPackBuilder = {
  build: async () =>
    err({ class: "validation", message: "no pack", retryable: false }),
};

test("90 min default: one catchup at boot, the next pulse 90 min ± 5 % later, none before", async () => {
  const s = await setup({ work: true });
  await s.clock.advance(1_000);
  const [catchup] = await ended(s, 1);
  expect(catchup).toMatchObject({
    trigger: "catchup",
    scheduled_at: T0,
    state: "failed",
    skip_reason: "unreported",
  });
  const wake = s.scheduler.wakes().get(ORCH);
  expect(wake?.trigger).toBe("cron");
  const at = wake?.at ?? 0;
  expect(at).toBeGreaterThanOrEqual(T0 + 85.5 * MIN);
  expect(at).toBeLessThanOrEqual(T0 + 94.5 * MIN);
  await s.clock.advance(85 * MIN - 1_000);
  await s.settle();
  expect(await pulsesOf(s)).toHaveLength(1);
  await s.clock.advance(10 * MIN);
  const rows = await ended(s, 2);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ trigger: "cron", scheduled_at: at });
});

test("3 exits → 1 pulse: three ticket sessions ending within 40 s make one completion pulse", async () => {
  // Three live sessions of one builder at once: this test is about completions, not concurrency.
  const s = await setup({ work: true, builderConcurrency: 3 });
  await s.clock.advance(1_000);
  await ended(s, 1);
  for (const id of ["b1", "b2", "b3"]) {
    unwrap(
      await s.lifecycle.handlers.spawn.handle(
        spawnPayload(id, { ticket_id: "ticket-1", prompt: "go" }),
        CMD,
      ),
    );
  }
  await vi.waitFor(async () => {
    await s.settle();
    for (const id of ["b1", "b2", "b3"]) {
      expect(unwrap(await getSession(s.db, id)).state).toBe("idle");
    }
  }, WAIT);
  await s.clock.advance(10 * MIN);
  await s.settle();
  const first = s.clock.now();
  for (const id of ["b1", "b2", "b3"]) {
    await s.lifecycle.stop(id, "graceful");
    await s.settle();
    await s.clock.advance(20_000);
  }
  await s.clock.advance(60_000);
  const rows = await ended(s, 2);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({
    trigger: "completion",
    scheduled_at: first + 40_000 + 60_000,
  });
});

test("min gap holds: a completion 1 min after a pulse waits for the 5 min floor", async () => {
  const s = await setup({ work: true });
  await s.clock.advance(1_000);
  await ended(s, 1);
  await s.clock.advance(59_000);
  s.scheduler.fanOutCompletion(s.clock.now(), null);
  await s.settle();
  expect(s.scheduler.wakes().get(ORCH)).toEqual({
    at: T0 + 5 * MIN,
    trigger: "completion",
  });
  await s.clock.advance(4 * MIN - 1);
  await s.settle();
  expect(await pulsesOf(s)).toHaveLength(1);
  await s.clock.advance(1);
  const rows = await ended(s, 2);
  expect(rows[1]).toMatchObject({
    trigger: "completion",
    scheduled_at: T0 + 5 * MIN,
  });
});

test("a hand-off is one completion: the end that left it pending arms no second wake", async () => {
  const s = await setup({ work: true });
  await s.clock.advance(1_000);
  await ended(s, 1);
  await s.clock.advance(10 * MIN);
  await s.settle();
  const cron = s.scheduler.wakes().get(ORCH);
  expect(cron?.trigger).toBe("cron");
  // Its hand-off was announced on its own (onHandoffPending): this end changes nothing.
  s.scheduler.sessionEnded({
    sessionId: "handed",
    ticketId: "ticket-1",
    workspaceId: null,
    at: s.clock.now(),
    handoffPending: true,
  });
  await s.settle();
  expect(s.scheduler.wakes().get(ORCH)).toEqual(cron);
  // A plain ticket session's end is a completion.
  s.scheduler.sessionEnded({
    sessionId: "plain",
    ticketId: "ticket-1",
    workspaceId: null,
    at: s.clock.now(),
    handoffPending: false,
  });
  await s.settle();
  expect(s.scheduler.wakes().get(ORCH)?.trigger).toBe("completion");
});

/** The live pulse's session id, once its session exists. */
async function liveSession(s: Setup): Promise<string> {
  let id = "";
  await vi.waitFor(async () => {
    await s.settle();
    const live = (await pulsesOf(s)).find((p) => LIVE.includes(p.state));
    expect(live?.session_id).toBeTruthy();
    id = live?.session_id ?? "";
  }, WAIT);
  return id;
}

test("the real run: a hand-off finalizes while P1 holds the lease past its cron → one follow-up completion pulse", async () => {
  const s = await setup({
    work: true,
    script: HANG,
    // The smoke's orchestrator: hybrid, 20 s interval, 1 s debounce, 2 s gap.
    agent: {
      pulse_interval_ms: 20_000,
      pulse_debounce_ms: 1_000,
      pulse_min_gap_ms: 2_000,
      pulse_max_per_hour: 60,
    },
  });
  await s.clock.advance(1_000);
  const p1 = await liveSession(s);
  // P1 runs on (its real run ended on the hard cap) past its cron wake at ~T0 + 20 s.
  await s.clock.advance(34_200);
  await s.settle();
  expect(await pulsesOf(s)).toHaveLength(1);
  const pendingAt = s.clock.now();
  s.scheduler.fanOutCompletion(pendingAt, null); // onHandoffPending
  await s.settle();
  await s.clock.advance(800);
  await s.lifecycle.stop(p1, "graceful");
  await ended(s, 1);
  await s.clock.advance(1_000);
  const p2 = await liveSession(s);
  const [first, second] = await pulsesOf(s);
  expect(first).toMatchObject({ trigger: "catchup", state: "failed" });
  expect(second).toMatchObject({
    trigger: "completion",
    scheduled_at: pendingAt + 1_000,
  });
  // Exactly one: once it settles, the next wake is the interval's again.
  await s.lifecycle.stop(p2, "graceful");
  const rows = await ended(s, 2);
  expect(rows.filter((p) => p.trigger === "completion")).toHaveLength(1);
  expect(s.scheduler.wakes().get(ORCH)?.trigger).toBe("cron");
});

test("a completion during a pulse's decision is kept: a skipped pulse serves only what came before it", async () => {
  const hook: { fan?: (at: number) => void } = {};
  let calls = 0;
  const gate: PulseGate = async (i) => {
    calls += 1;
    if (calls === 1) hook.fan?.(i.now); // lands between the burst's snapshot and the skip
    return { allow: true };
  };
  const s = await setup({ gate }); // no work: every pulse is skipped(nothing_to_do)
  hook.fan = (at) => s.scheduler.fanOutCompletion(at, null);
  await s.clock.advance(1_000);
  await ended(s, 1);
  await s.clock.advance(MIN + 1_000);
  const rows = await ended(s, 2);
  expect(rows.map((p) => [p.trigger, p.skip_reason])).toEqual([
    ["catchup", "nothing_to_do"],
    ["completion", "nothing_to_do"],
  ]);
  await s.clock.advance(5 * MIN);
  await s.settle();
  expect(await pulsesOf(s)).toHaveLength(2);
});

test("9th pulse/hour falls back: one skipped(rate_capped), one warning, then interval only", async () => {
  const s = await setup({
    work: true,
    agent: { pulse_min_gap_ms: MIN },
    pack: FAILING_PACK,
  });
  await s.clock.advance(1_000);
  await ended(s, 1);
  for (let i = 0; i < 12; i += 1) {
    await s.clock.advance(70_000);
    s.scheduler.fanOutCompletion(s.clock.now(), null);
    await s.settle();
  }
  await s.clock.advance(70_000);
  await s.settle();
  // A capped wake that reused the window's row parked the agent: the next tick re-plans it.
  await s.clock.advance(2 * MIN);
  await s.settle();
  const rows = await pulsesOf(s);
  const ran = rows.filter((p) => p.state !== "skipped");
  const capped = rows.filter((p) => p.skip_reason === "rate_capped");
  expect(ran).toHaveLength(8);
  expect(capped).toHaveLength(1);
  expect(
    s.logs.filter((l) => l.msg.startsWith("pulse rate cap reached")),
  ).toHaveLength(1);
  expect(s.scheduler.wakes().get(ORCH)?.trigger).toBe("cron");
  // Manual is not exempt from the cap (review answer 1): its own skipped row, and its id.
  const manual = unwrap(
    await pulseRunHandler(s.scheduler).handle({ agent_id: ORCH }, CMD),
  );
  expect(manual).toMatchObject({ outcome: "capped" });
  const after = await pulsesOf(s);
  expect(after.filter((p) => p.skip_reason === "rate_capped")).toHaveLength(2);
  expect(after.at(-1)).toMatchObject({ trigger: "manual", state: "skipped" });
});

test("single catchup: after 10 h down, one catchup pulse, never a backlog replay", async () => {
  const old: PulseRow = {
    id: "p-old",
    agent_id: ORCH,
    trigger: "cron",
    scheduled_at: T0 - 600 * MIN,
    lease_token: null,
    lease_expires_at: null,
    state: "done",
    skip_reason: null,
    session_id: null,
    run_id: null,
    context_pack_path: null,
    context_tokens: null,
    summary_md: "old",
    actions_json: "[]",
    cost_usd: 0,
    started_at: T0 - 600 * MIN,
    ended_at: T0 - 599 * MIN,
  };
  const s = await setup({
    agent: { created_at: T0 - 700 * MIN },
    pulses: [old],
  });
  await s.clock.advance(1_000);
  const rows = await ended(s, 2);
  expect(rows.map((p) => p.trigger)).toEqual(["cron", "catchup"]);
  await s.clock.advance(5 * MIN);
  await s.settle();
  expect(await pulsesOf(s)).toHaveLength(2);
});

test("concurrent run-now → 1 pulse; manual bypasses the no-op check", async () => {
  const s = await setup({ agent: { pulse_mode: "manual" } });
  const handler = pulseRunHandler(s.scheduler);
  const [a, b] = await Promise.all([
    handler.handle({ agent_id: ORCH }, CMD),
    handler.handle({ agent_id: ORCH }, CMD),
  ]);
  const first = unwrap(a) as { pulse_id: string; outcome: string };
  const second = unwrap(b) as { pulse_id: string; outcome: string };
  expect([first.outcome, second.outcome]).toEqual(["running", "coalesced"]);
  expect(second.pulse_id).toBe(first.pulse_id);
  const rows = await ended(s, 1);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ trigger: "manual", state: "failed" });
  const refused = await handler.handle({ agent_id: "agent-1" }, CMD);
  expect(!refused.ok && refused.error.class).toBe("validation");
});

test("skipped costs $0: nothing to do means no session, no run, no spend", async () => {
  const s = await setup();
  await s.clock.advance(1_000);
  const [skipped] = await ended(s, 1);
  expect(skipped).toMatchObject({
    trigger: "catchup",
    state: "skipped",
    skip_reason: "nothing_to_do",
    cost_usd: 0,
    session_id: null,
  });
  const today = unwrap(
    await (await import("@bayon/db")).getDailyBudget(s.db),
  ).today_usd;
  expect(today).toBe(0);
});

test("H2: an outcome that writes no row waits for the tick; wakes never loop", async () => {
  let calls = 0;
  const deny: PulseGate = async () => {
    calls += 1;
    return { allow: false };
  };
  const s = await setup({ work: true, gate: deny });
  await s.clock.advance(1_000);
  await s.settle();
  expect(calls).toBe(1);
  s.scheduler.fanOutCompletion(s.clock.now(), null);
  await s.settle();
  expect(s.scheduler.wakes().has(ORCH)).toBe(false);
  await s.clock.advance(50_000);
  await s.settle();
  expect(calls).toBe(1);
  for (let i = 0; i < 5; i += 1) {
    await s.clock.advance(60_000);
    await s.settle();
  }
  // One attempt per tick at most, never a hot loop, and never a row.
  expect(calls).toBeGreaterThan(1);
  expect(calls).toBeLessThanOrEqual(7);
  expect(await pulsesOf(s)).toEqual([]);
});

test("M6: the daily budget spent → one skipped(over_budget) a day, then no row", async () => {
  // M4-c: the gate reads `budgets`, not settings' budget.daily_cap_usd. A zero fleet/day cap is
  // spent the moment it exists, which is what this test has always meant by "spent".
  const s = await setup({
    work: true,
    agent: { pulse_mode: "manual" },
    budgets: [
      {
        id: "01J0BUDGET000000000000000",
        scope: "fleet",
        scope_ref: null,
        period: "day",
        cap_usd: 0,
        updated_at: T0,
      },
    ],
  });
  const handler = pulseRunHandler(s.scheduler);
  expect(unwrap(await handler.handle({ agent_id: ORCH }, CMD))).toMatchObject({
    outcome: "skipped",
  });
  expect(unwrap(await handler.handle({ agent_id: ORCH }, CMD))).toEqual({
    pulse_id: null,
    outcome: "denied",
  });
  const rows = await pulsesOf(s);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    state: "skipped",
    skip_reason: "over_budget",
    cost_usd: 0,
  });
});

test("the scheduler ignores agents that do not pulse, and a rig without start arms nothing", async () => {
  const s: Rig & { clock: FakeClock } = await setup({
    agent: { pulse_mode: "manual" },
  });
  await s.clock.advance(2 * MIN);
  await s.settle();
  expect(s.scheduler.wakes().size).toBe(0);
});
