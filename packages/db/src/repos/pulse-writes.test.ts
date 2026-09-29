// The pulse writers and the scheduler's reads on a real temp SQLite file.
import { FakeClock } from "@bayon/core";
import { afterAll, describe, expect, test } from "vitest";
import { openDb, type Db } from "../connection.js";
import {
  SPINE_SEED,
  insertCommand,
  newRunInput,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "../testing.js";
import {
  completionsSince,
  getDailyBudget,
  hasPulseWork,
  listLivePulses,
  listPulseAgents,
  pulseHistory,
  pulseIdForSession,
} from "./pulse-reads.js";
import {
  applyPulseReport,
  leasePulse,
  releaseExpiredPulseLeases,
  resumPulseCosts,
  settlePulse,
  updatePulse,
  type NewLease,
} from "./pulse-writes.js";
import { getPulse } from "./pulses.js";
import { appendRun } from "./runs.js";

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const TTL = 17 * MIN;
const AGENT = "orch-1";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

async function setup() {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 4));
  unwrap(
    await seedRows(t.db, {
      agents: [
        {
          id: AGENT,
          name: AGENT,
          kind: "orchestrator",
          runner_id: SPINE_SEED.runnerId,
          created_at: T0,
        },
      ],
    }),
  );
  const lease = (o: Partial<NewLease> = {}) =>
    leasePulse(t.db, {
      agent_id: AGENT,
      trigger: "cron",
      scheduled_at: clock.now(),
      lease_ttl_ms: TTL,
      max_per_hour: 8,
      ...o,
    });
  return { clock, db: t.db, path: t.path, lease };
}

/** A session of the pulse run class, running: what a pulse links to. */
async function pulseSession(db: Db, id: string, runClass = "pulse") {
  unwrap(
    await seedRows(db, {
      sessions: [
        {
          ...newSessionInput(),
          id,
          agent_id: AGENT,
          role: "orchestrator",
          run_class: runClass,
          state: "running",
          created_at: T0,
        },
      ],
    }),
  );
}

/** A spend row of `usd` for the session's run, charged to `pulseId`. */
async function spend(
  db: Db,
  o: {
    id: string;
    runId: string;
    sessionId: string;
    pulseId: string;
    usd: number;
  },
) {
  unwrap(
    await seedRows(db, {
      spend: [
        {
          id: o.id,
          run_id: o.runId,
          session_id: o.sessionId,
          pulse_id: o.pulseId,
          phase: "pulse",
          runner_id: SPINE_SEED.runnerId,
          model: "fixture-model",
          cost_usd: o.usd,
          cost_source: "reported",
          ts: T0,
        },
      ],
    }),
  );
}

describe("leasePulse", () => {
  test("one live pulse per agent: a second lease coalesces, an ended one frees it", async () => {
    const { lease, db } = await setup();
    const first = unwrap(await lease());
    expect(first.kind).toBe("leased");
    expect(first.pulse.state).toBe("leased");
    expect(first.pulse.lease_expires_at).toBe(T0 + TTL);
    const again = unwrap(await lease({ trigger: "manual" }));
    expect(again).toMatchObject({ kind: "coalesced" });
    expect(again.pulse.id).toBe(first.pulse.id);
    unwrap(
      await updatePulse(
        db,
        { id: first.pulse.id, from: ["leased"] },
        { state: "skipped", skip_reason: "nothing_to_do", ended_at: T0 },
      ),
    );
    expect(unwrap(await lease()).kind).toBe("leased");
  });

  test("two connections leasing at once make one pulse", async () => {
    const { lease, path, clock } = await setup();
    const other = unwrap(await openDb({ path, clock }));
    const second = leasePulse(other, {
      agent_id: AGENT,
      trigger: "manual",
      scheduled_at: T0,
      lease_ttl_ms: TTL,
      max_per_hour: 8,
    });
    const outcomes = await Promise.all([lease({ trigger: "manual" }), second]);
    unwrap(await other.close());
    expect(outcomes.map((o) => unwrap(o).kind).toSorted()).toEqual([
      "coalesced",
      "leased",
    ]);
    const [a, b] = outcomes.map((o) => unwrap(o).pulse.id);
    expect(a).toBe(b);
  });

  test("the cap is in the lease: 8 ran in the hour → one skipped(rate_capped), manual included (H2)", async () => {
    const { lease, db, clock } = await setup();
    for (let i = 0; i < 8; i += 1) {
      const l = unwrap(await lease());
      unwrap(
        await updatePulse(
          db,
          { id: l.pulse.id, from: ["leased"] },
          { state: "failed", skip_reason: "unreported", ended_at: clock.now() },
        ),
      );
      await clock.advance(MIN);
    }
    const capped = unwrap(await lease());
    expect(capped).toMatchObject({
      kind: "capped",
      created: true,
      firstInWindow: true,
    });
    expect(capped.pulse).toMatchObject({
      state: "skipped",
      skip_reason: "rate_capped",
      cost_usd: 0,
    });
    // An automatic wake while capped reuses the window's row: one row, one warning.
    const cron = unwrap(await lease({ trigger: "completion" }));
    expect(cron).toMatchObject({ kind: "capped", created: false });
    expect(cron.pulse.id).toBe(capped.pulse.id);
    // Manual is not exempt (review answer 1): it gets its own row and id.
    const manual = unwrap(await lease({ trigger: "manual" }));
    expect(manual).toMatchObject({
      kind: "capped",
      created: true,
      firstInWindow: false,
    });
    expect(manual.pulse.trigger).toBe("manual");
    expect(unwrap(await listLivePulses(db))).toEqual([]);
    // The window slides: once the first pulse is over an hour old there is room.
    await clock.advance(53 * MIN);
    expect(unwrap(await lease()).kind).toBe("leased");
  });

  test("a bad lease is a validation error", async () => {
    const { lease } = await setup();
    const bad = await lease({ max_per_hour: 0 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.class).toBe("validation");
  });
});

describe("updatePulse", () => {
  test("a compare-and-set on state and session", async () => {
    const { lease, db } = await setup();
    const { pulse } = unwrap(await lease());
    const wrongState = await updatePulse(
      db,
      { id: pulse.id, from: ["running"] },
      { started_at: T0 },
    );
    expect(!wrongState.ok && wrongState.error.class).toBe("conflict");
    const missing = await updatePulse(
      db,
      { id: "nope", from: ["leased"] },
      { started_at: T0 },
    );
    expect(!missing.ok && missing.error.class).toBe("not_found");
    const empty = await updatePulse(db, { id: pulse.id, from: ["leased"] }, {});
    expect(!empty.ok && empty.error.class).toBe("validation");
    await pulseSession(db, "s-pulse");
    unwrap(
      await updatePulse(
        db,
        { id: pulse.id, from: ["leased"] },
        { state: "running", session_id: "s-pulse" },
      ),
    );
    const otherSession = await updatePulse(
      db,
      { id: pulse.id, from: ["running"], session_id: "s-other" },
      { summary_md: "x" },
    );
    expect(!otherSession.ok && otherSession.error.class).toBe("conflict");
  });
});

describe("report and settle (H1)", () => {
  async function running() {
    const s = await setup();
    const { pulse } = unwrap(await s.lease());
    await pulseSession(s.db, "s-pulse");
    unwrap(
      await updatePulse(
        s.db,
        { id: pulse.id, from: ["leased"] },
        { state: "running", started_at: T0, session_id: "s-pulse" },
      ),
    );
    const run = unwrap(await appendRun(s.db, newRunInput("s-pulse")));
    return { ...s, pulse, run };
  }

  test("a report lands while running; after the settle it is not an error", async () => {
    const { db, pulse, run } = await running();
    const applied = unwrap(
      await applyPulseReport(db, {
        pulse_id: pulse.id,
        session_id: "s-pulse",
        summary_md: "staffed #1",
        actions: ["staffed #1 as builder"],
      }),
    );
    expect(applied.applied).toBe(true);
    const done = unwrap(
      await settlePulse(db, {
        id: pulse.id,
        run: {
          run_id: run.id,
          context_pack_path: run.prompt_path,
          context_tokens: 900,
        },
        fail_reason: "unreported",
      }),
    );
    expect(done).toMatchObject({
      state: "done",
      skip_reason: null,
      summary_md: "staffed #1",
      actions_json: JSON.stringify(["staffed #1 as builder"]),
      run_id: run.id,
      context_tokens: 900,
    });
    const late = unwrap(
      await applyPulseReport(db, {
        pulse_id: pulse.id,
        session_id: "s-pulse",
        summary_md: "late",
        actions: [],
      }),
    );
    expect(late.applied).toBe(false);
    expect(late.pulse.summary_md).toBe("staffed #1");
    const stranger = await applyPulseReport(db, {
      pulse_id: pulse.id,
      session_id: "s-other",
      summary_md: "x",
      actions: [],
    });
    expect(!stranger.ok && stranger.error.class).toBe("conflict");
    const unknown = await applyPulseReport(db, {
      pulse_id: "nope",
      session_id: "s-pulse",
      summary_md: "x",
      actions: [],
    });
    expect(!unknown.ok && unknown.error.class).toBe("not_found");
  });

  test("settle applies a report still pending on the claimer; the newest wins", async () => {
    const { db, pulse, run, clock } = await running();
    for (const summary of ["first", "second"]) {
      await clock.advance(1);
      unwrap(
        await insertCommand(db, {
          type: "pulse.report",
          payload: {
            pulse_id: pulse.id,
            session_id: "s-pulse",
            summary_md: summary,
            actions: [summary],
          },
        }),
      );
    }
    const done = unwrap(
      await settlePulse(db, {
        id: pulse.id,
        run: {
          run_id: run.id,
          context_pack_path: run.prompt_path,
          context_tokens: null,
        },
        fail_reason: "unreported",
      }),
    );
    expect(done).toMatchObject({ state: "done", summary_md: "second" });
  });

  test("no report → failed(fail_reason); its cost is its spend rows'; a second settle conflicts", async () => {
    const { db, pulse, run } = await running();
    await spend(db, {
      id: "sp-1",
      runId: run.id,
      sessionId: "s-pulse",
      pulseId: pulse.id,
      usd: 0.25,
    });
    await spend(db, {
      id: "sp-2",
      runId: run.id,
      sessionId: "s-pulse",
      pulseId: pulse.id,
      usd: 0.125,
    });
    const failed = unwrap(
      await settlePulse(db, {
        id: pulse.id,
        run: null,
        fail_reason: "unreported",
      }),
    );
    expect(failed).toMatchObject({
      state: "failed",
      skip_reason: "unreported",
      cost_usd: 0.375,
      summary_md: null,
    });
    const again = await settlePulse(db, {
      id: pulse.id,
      run: null,
      fail_reason: "unreported",
    });
    expect(!again.ok && again.error.class).toBe("conflict");
  });
});

describe("expiry", () => {
  test("a lease past its TTL expires, with its session and its cost; resum completes the cost", async () => {
    const { lease, db, clock } = await setup();
    const { pulse } = unwrap(await lease());
    await pulseSession(db, "s-pulse");
    unwrap(
      await updatePulse(
        db,
        { id: pulse.id, from: ["leased"] },
        { state: "running", session_id: "s-pulse" },
      ),
    );
    const run = unwrap(await appendRun(db, newRunInput("s-pulse")));
    await clock.advance(TTL - 1);
    expect(unwrap(await releaseExpiredPulseLeases(db))).toEqual([]);
    await clock.advance(2);
    expect(unwrap(await releaseExpiredPulseLeases(db))).toEqual([
      { id: pulse.id, agent_id: AGENT, session_id: "s-pulse" },
    ]);
    expect(unwrap(await getPulse(db, pulse.id))).toMatchObject({
      state: "expired",
      cost_usd: 0,
    });
    await spend(db, {
      id: "sp-late",
      runId: run.id,
      sessionId: "s-pulse",
      pulseId: pulse.id,
      usd: 0.5,
    });
    expect(unwrap(await resumPulseCosts(db, clock.now() - TTL))).toBe(1);
    expect(unwrap(await getPulse(db, pulse.id)).cost_usd).toBe(0.5);
    expect(unwrap(await lease()).kind).toBe("leased");
  });
});

describe("the scheduler's reads", () => {
  test("pulseHistory: skipped pulses neither ran nor count; rate_capped is not the cron base", async () => {
    const { lease, db, clock } = await setup();
    const ran = unwrap(await lease());
    unwrap(
      await updatePulse(
        db,
        { id: ran.pulse.id, from: ["leased"] },
        { state: "done", ended_at: T0 },
      ),
    );
    await clock.advance(10 * MIN);
    const skipped = unwrap(await lease());
    unwrap(
      await updatePulse(
        db,
        { id: skipped.pulse.id, from: ["leased"] },
        {
          state: "skipped",
          skip_reason: "nothing_to_do",
          ended_at: clock.now(),
        },
      ),
    );
    await clock.advance(10 * MIN);
    const capped = unwrap(await lease({ max_per_hour: 1 }));
    expect(capped.kind).toBe("capped");
    expect(unwrap(await pulseHistory(db, AGENT, clock.now()))).toEqual({
      lastAt: T0 + 10 * MIN,
      lastSeed: skipped.pulse.id,
      lastRanAt: T0,
      ranAts: [T0],
      lastDoneAt: T0,
    });
    expect(unwrap(await pulseHistory(db, "no-agent", clock.now()))).toEqual({
      lastAt: null,
      lastSeed: null,
      lastRanAt: null,
      ranAts: [],
      lastDoneAt: null,
    });
  });

  test("completionsSince: ticket sessions, answers and gate decisions, with a tie cursor", async () => {
    const { db } = await setup();
    const ended = (id: string, at: number, ticket: string | null) => ({
      ...newSessionInput(),
      id,
      state: "exited" as const,
      created_at: 0,
      ended_at: at,
      ticket_id: ticket,
    });
    unwrap(
      await seedRows(db, {
        tickets: [ticketRow(1)],
        sessions: [
          ended("s-a", T0 + 5, "ticket-1"),
          ended("s-b", T0 + 5, "ticket-1"),
          ended("s-no-ticket", T0 + 6, null),
        ],
        gates: [
          {
            id: "g-1",
            ticket_id: "ticket-1",
            kind: "code_review",
            state: "passed",
            subject_kind: "diff",
            subject_ref: "abc",
            decided_at: T0 + 20,
          },
        ],
        human_requests: [
          {
            id: "h-1",
            kind: "question",
            question: "which?",
            status: "answered",
            asked_at: T0,
            answered_at: T0 + 10,
          },
        ],
      }),
    );
    const all = unwrap(await completionsSince(db, { at: T0, ref: "" }));
    expect(all.map((c) => [c.kind, c.ref, c.at])).toEqual([
      ["session_exited", "s-a", T0 + 5],
      ["session_exited", "s-b", T0 + 5],
      ["human_answered", "h-1", T0 + 10],
      ["gate_decided", "g-1", T0 + 20],
    ]);
    const after = unwrap(
      await completionsSince(db, { at: T0 + 5, ref: "s-a" }),
    );
    expect(after.map((c) => c.ref)).toEqual(["s-b", "h-1", "g-1"]);
    const polled = unwrap(
      await completionsSince(db, { at: T0, ref: "" }, [
        "human_answered",
        "gate_decided",
      ]),
    );
    expect(polled.map((c) => c.ref)).toEqual(["h-1", "g-1"]);
    // A completion at the very millisecond of the last done pulse still counts: conservative.
    expect(unwrap(await hasPulseWork(db, T0 + 21))).toBe(false);
    expect(unwrap(await hasPulseWork(db, T0 + 20))).toBe(true);
  });

  test("hasPulseWork: v_needs_attention counts", async () => {
    const { db } = await setup();
    expect(unwrap(await hasPulseWork(db, 0))).toBe(false);
    unwrap(
      await seedRows(db, {
        tickets: [ticketRow(2, { status: "prioritized" })],
      }),
    );
    expect(unwrap(await hasPulseWork(db, 0))).toBe(true);
  });

  test("listPulseAgents, listLivePulses and pulseIdForSession", async () => {
    const { lease, db } = await setup();
    expect(unwrap(await listPulseAgents(db)).map((a) => a.id)).toEqual([AGENT]);
    const { pulse } = unwrap(await lease());
    expect(unwrap(await listLivePulses(db)).map((p) => p.id)).toEqual([
      pulse.id,
    ]);
    await pulseSession(db, "s-pulse");
    await pulseSession(db, "s-build", "build");
    unwrap(
      await updatePulse(
        db,
        { id: pulse.id, from: ["leased"] },
        { session_id: "s-pulse" },
      ),
    );
    expect(unwrap(await pulseIdForSession(db, "s-pulse"))).toBe(pulse.id);
    expect(unwrap(await pulseIdForSession(db, "s-build"))).toBeNull();
  });

  test("getDailyBudget: today's spend against the cap", async () => {
    const { db } = await setup();
    expect(unwrap(await getDailyBudget(db))).toEqual({
      today_usd: 0,
      daily_cap_usd: null,
    });
    unwrap(
      await seedRows(db, {
        settings: [
          { key: "budget.daily_cap_usd", value_json: "2", updated_at: 0 },
        ],
      }),
    );
    expect(unwrap(await getDailyBudget(db)).daily_cap_usd).toBe(2);
  });
});
