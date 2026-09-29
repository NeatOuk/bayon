// One pulse's life: the spawn with no ticket and no worktree, the report
// and the settle (H1), the deadline and the lease's expiry (C1), the sweep (H4) and a restart (M2).
import { FakeClock, TEMPLATES, ok, templateId } from "@bayon/core";
import {
  getDailyBudget,
  getPulse,
  getRunSpend,
  getSession,
  listLivePulses,
  listRuns,
  listSessionWorktrees,
  type PulseRow,
} from "@bayon/db";
import { insertCommand, seedRows, tempDb, unwrap } from "@bayon/db/testing";
import type { FixtureScriptInput } from "@bayon/runners/fixture";
import { afterEach, expect, test, vi } from "vitest";
import { CMD, spawnPayload, tempHome } from "../lifecycle/testing/fixtures.js";
import type { ProbeRunner } from "./ports.js";
import { pulseReportHandler, pulseRunHandler } from "./pulse-commands.js";
import {
  HANG,
  MIN,
  ORCH,
  T0,
  WAIT,
  pulseRows,
  startRig,
  type Rig,
} from "./testing/rig.js";

// Real async I/O under a FakeClock: a pulse's whole life can take longer than the 5 s default.
vi.setConfig({ testTimeout: 30_000 });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(
  o: {
    script?: FixtureScriptInput;
    settings?: Record<string, number>;
    slots?: number;
    probes?: ProbeRunner;
    start?: boolean;
    pulses?: PulseRow[];
  } = {},
) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome();
  unwrap(
    await seedRows(t.db, {
      ...pulseRows({
        agent: { pulse_mode: "manual" },
        ...(o.script === undefined ? {} : { script: o.script }),
        ...(o.settings === undefined ? {} : { settings: o.settings }),
        // Admission re-reads capacity from the row: the row and the counter agree.
        ...(o.slots === undefined ? {} : { slots: o.slots }),
      }),
      ...(o.pulses === undefined ? {} : { pulses: o.pulses }),
    }),
  );
  const rigOptions = {
    db: t.db,
    clock,
    home: home.path,
    ...(o.slots === undefined ? {} : { slots: o.slots }),
    ...(o.probes === undefined ? {} : { probes: o.probes }),
    ...(o.start === undefined ? {} : { start: o.start }),
  };
  const rigs: Rig[] = [await startRig(rigOptions)];
  cleanups.push(async () => {
    for (const r of rigs.toReversed()) await r.stop();
    t.cleanup();
    home.cleanup();
  });
  const rig = rigs[0] as Rig;
  /** Stops this "supervisor" (killing nothing) and boots another on the same database. */
  const restart = async () => {
    await rig.stop();
    const next = await startRig(rigOptions);
    rigs.push(next);
    return next;
  };
  return { clock, db: t.db, ...rig, restart };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const runNow = async (s: Setup) =>
  unwrap(
    await pulseRunHandler(s.scheduler).handle({ agent_id: ORCH }, CMD),
  ) as {
    pulse_id: string;
    outcome: string;
  };

async function pulseWhen(
  s: Pick<Setup, "db" | "settle">,
  id: string,
  check: (p: PulseRow) => void,
): Promise<PulseRow> {
  let row: PulseRow | undefined;
  await vi.waitFor(async () => {
    await s.settle();
    row = unwrap(await getPulse(s.db, id));
    check(row);
  }, WAIT);
  return row as PulseRow;
}

/** Waits for the pulse's session to have run 1 in flight; returns the session id. */
async function running(s: Setup, pulseId: string): Promise<string> {
  const pulse = await pulseWhen(s, pulseId, (p) =>
    expect(p.session_id).not.toBeNull(),
  );
  const sessionId = pulse.session_id ?? "";
  await vi.waitFor(async () => {
    await s.settle();
    expect(unwrap(await listRuns(s.db, sessionId))[0]?.state).toBe("running");
  }, WAIT);
  return sessionId;
}

test("a full pulse: an orchestrator session with no ticket and no worktree, reported, done at its spend's cost", async () => {
  const s = await setup({ script: HANG });
  const { pulse_id } = await runNow(s);
  const sessionId = await running(s, pulse_id);
  const reported = unwrap(
    await pulseReportHandler(s.db).handle(
      {
        pulse_id,
        session_id: sessionId,
        summary_md: "staffed #1",
        actions: ["staffed #1 as builder"],
      },
      CMD,
    ),
  );
  expect(reported).toEqual({ pulse_id, applied: true });
  unwrap(
    await s.lifecycle.handlers.interrupt.handle({ session_id: sessionId }, CMD),
  );
  const done = await pulseWhen(s, pulse_id, (p) =>
    expect(p.state).toBe("done"),
  );
  const runs = unwrap(await listRuns(s.db, sessionId));
  expect(runs).toHaveLength(1);
  const [run] = runs;
  expect(run).toMatchObject({
    trigger: "pulse",
    template_id: templateId(TEMPLATES.pulse),
  });
  // An interrupted run may report $0; whatever it spent, the pulse's cost is its spend rows'.
  const spent = unwrap(await getDailyBudget(s.db)).today_usd;
  expect(done).toMatchObject({
    summary_md: "staffed #1",
    actions_json: JSON.stringify(["staffed #1 as builder"]),
    run_id: run?.id,
    context_pack_path: run?.prompt_path,
    context_tokens: run?.prompt_tokens_est,
    cost_usd: spent,
  });
  const session = unwrap(await getSession(s.db, sessionId));
  expect(session).toMatchObject({
    ticket_id: null,
    run_class: "pulse",
    role: "orchestrator",
    workspace_id: null,
  });
  expect(session.state === "exited" || session.state === "resumable").toBe(
    true,
  );
  expect(unwrap(await listSessionWorktrees(s.db, sessionId))).toEqual([]);
  const checks = unwrap(
    await (await import("@bayon/db")).listPulseChecks(s.db, pulse_id),
  );
  expect(checks.map((c) => c.name)).toEqual(["stale_sessions"]);
});

test("no report → failed(unreported), a normal outcome", async () => {
  const s = await setup();
  const { pulse_id } = await runNow(s);
  const failed = await pulseWhen(s, pulse_id, (p) =>
    expect(p.state).toBe("failed"),
  );
  expect(failed.skip_reason).toBe("unreported");
  expect(failed.cost_usd).toBeGreaterThan(0);
  // spend.pulse_id (§8.9): the run's spend row names the pulse, and is its whole cost.
  const spend = unwrap(await getRunSpend(s.db, failed.run_id ?? ""));
  expect(spend?.pulse_id).toBe(pulse_id);
  expect(spend?.cost_usd).toBe(failed.cost_usd);
});

test("H1: a report still pending on the claimer at the terminal is applied by the settle", async () => {
  const s = await setup({ script: HANG });
  const { pulse_id } = await runNow(s);
  const sessionId = await running(s, pulse_id);
  const payload = {
    pulse_id,
    session_id: sessionId,
    summary_md: "nothing needed",
    actions: [],
  };
  unwrap(await insertCommand(s.db, { type: "pulse.report", payload }));
  unwrap(
    await s.lifecycle.handlers.interrupt.handle({ session_id: sessionId }, CMD),
  );
  const done = await pulseWhen(s, pulse_id, (p) =>
    expect(p.state).toBe("done"),
  );
  expect(done.summary_md).toBe("nothing needed");
  // The claimer gets to the command later: success, not a conflict.
  expect(unwrap(await pulseReportHandler(s.db).handle(payload, CMD))).toEqual({
    pulse_id,
    applied: false,
  });
});

test("C1: a spawn still waiting for a slot at the deadline is aborted; the pulse fails timeout", async () => {
  const s = await setup({
    slots: 1,
    settings: { "pulse.lease_ttl_ms": 5 * MIN, "pulse.lease_grace_ms": MIN },
  });
  const held = s.slots.tryAcquire();
  if (held === null) throw new Error("the test's one slot is taken already");
  const { pulse_id } = await runNow(s);
  const waiting = await pulseWhen(
    { db: s.db, settle: () => s.scheduler.settled() },
    pulse_id,
    (p) => expect(p.session_id).not.toBeNull(),
  );
  // Queued visibly behind the held slot, off the session queues.
  await vi.waitFor(async () => {
    expect(
      unwrap(await getSession(s.db, waiting.session_id ?? "")),
    ).toMatchObject({ state: "pending", queued_reason: "slot" });
  }, WAIT);
  await s.clock.advance(4 * MIN);
  const failed = await pulseWhen(s, pulse_id, (p) =>
    expect(p.state).toBe("failed"),
  );
  expect(failed.skip_reason).toBe("timeout");
  expect(
    unwrap(await getSession(s.db, waiting.session_id ?? "")),
  ).toMatchObject({
    state: "exited",
    error_class: "timeout",
    // The deadline names the gate that held it.
    error_message: expect.stringContaining("(queued: slot)"),
  });
  expect(unwrap(await listLivePulses(s.db))).toEqual([]);
  held.release();
});

test("C1: run 1 is stopped at the deadline, before the lease ends, whatever the run class allows", async () => {
  // The pulse run class allows 15 min; the lease 5 min, so the deadline is 4 min.
  const s = await setup({
    script: HANG,
    settings: { "pulse.lease_ttl_ms": 5 * MIN, "pulse.lease_grace_ms": MIN },
  });
  const { pulse_id } = await runNow(s);
  const sessionId = await running(s, pulse_id);
  await s.clock.advance(4 * MIN);
  const failed = await pulseWhen(s, pulse_id, (p) =>
    expect(p.state).toBe("failed"),
  );
  expect(failed.skip_reason).toBe("unreported");
  expect(failed.ended_at).toBeLessThan(T0 + 5 * MIN);
  expect(unwrap(await listRuns(s.db, sessionId))[0]?.state).toBe("timeout");
});

test("C1: the reconciler expires a lease past its TTL and stops its session; a new lease succeeds", async () => {
  const s = await setup({ script: HANG, start: false });
  unwrap(
    await s.lifecycle.handlers.spawn.handle(
      spawnPayload("s-stuck", { prompt: "go" }),
      CMD,
    ),
  );
  await vi.waitFor(async () => {
    await s.settle();
    expect(unwrap(await listRuns(s.db, "s-stuck"))[0]?.state).toBe("running");
  }, WAIT);
  unwrap(
    await seedRows(s.db, {
      pulses: [
        {
          id: "p-stuck",
          agent_id: ORCH,
          trigger: "cron",
          scheduled_at: T0,
          lease_token: "token",
          lease_expires_at: T0 + 1_000,
          state: "running",
          session_id: "s-stuck",
          started_at: T0,
        },
      ],
    }),
  );
  await s.clock.advance(2_000);
  await s.lifecycle.reconcile();
  await s.settle();
  expect(unwrap(await getPulse(s.db, "p-stuck")).state).toBe("expired");
  await vi.waitFor(async () => {
    await s.settle();
    expect(unwrap(await getSession(s.db, "s-stuck")).state).toBe("exited");
  }, WAIT);
  expect((await runNow(s)).outcome).toBe("running");
});

test("H4: at boot every live pulse with no session fails interrupted; one in flight is left alone", async () => {
  const stale: PulseRow = {
    id: "p-stale",
    agent_id: ORCH,
    trigger: "cron",
    scheduled_at: T0 - MIN,
    lease_token: "token",
    lease_expires_at: T0 + 16 * MIN,
    state: "leased",
    skip_reason: null,
    session_id: null,
    run_id: null,
    context_pack_path: null,
    context_tokens: null,
    summary_md: null,
    actions_json: null,
    cost_usd: null,
    started_at: null,
    ended_at: null,
  };
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probes: ProbeRunner = {
    run: async () => {
      await blocked;
      return ok([]);
    },
  };
  const s = await setup({ pulses: [stale], probes });
  expect(unwrap(await getPulse(s.db, "p-stale"))).toMatchObject({
    state: "failed",
    skip_reason: "interrupted",
  });
  const { pulse_id } = await runNow(s);
  await s.scheduler.tick();
  expect(unwrap(await getPulse(s.db, pulse_id)).state).toBe("running");
  release();
  await pulseWhen(s, pulse_id, (p) => expect(p.state).toBe("failed"));
});

test("M2: a pulse session is never adopted after a restart; the sweep settles its pulse", async () => {
  const s = await setup({ script: HANG });
  const { pulse_id } = await runNow(s);
  const sessionId = await running(s, pulse_id);
  const next = await s.restart();
  const settled = await pulseWhen(
    { db: s.db, settle: next.settle },
    pulse_id,
    (p) => expect(p.state).toBe("failed"),
  );
  expect(settled.skip_reason).toBe("unreported");
  expect(unwrap(await getSession(s.db, sessionId))).toMatchObject({
    state: "exited",
    error_class: "supervisor_restart",
    error_message: "a pulse session is never adopted",
  });
  expect(unwrap(await listRuns(s.db, sessionId))).toHaveLength(1);
  expect(unwrap(await listLivePulses(s.db))).toEqual([]);
});
