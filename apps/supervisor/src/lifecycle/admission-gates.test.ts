// Admission's gates end to end, on 012's real defaults: a queued spawn holds
// visibly and starts by itself when its gate clears; a refusal fails with its gate and no row; a
// late refusal keeps its reason; capacity follows executors.slots at runtime.
import { FakeClock, PULSE_ROLE } from "@bayon/core";
import { getSession } from "@bayon/db";
import {
  putRoleBinding,
  seedRows,
  tempDb,
  ticketRow,
  unwrap,
  updateRowForTest,
  type EditableTable,
  type RowPatch,
  type SeedRows,
} from "@bayon/db/testing";
import type { SpawnSpec } from "@bayon/runners";
import { FIXTURE_RUNNER_ID, FIXTURE_VERSION } from "@bayon/runners/fixture";
import { afterAll, expect, test, vi } from "vitest";
import {
  admissionRows,
  startAdmission,
  T0,
  WAIT,
  type WorldOptions,
} from "./testing/admission-world.js";
import { certifyPair } from "./testing/certify.js";
import { AGENT_ID, EXECUTOR_ID, PROFILE_ID } from "./testing/fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** A seeded temp database and its lifecycle, plus the operator's edits a test makes mid-run. */
async function world(o: WorldOptions & { readonly extra?: SeedRows } = {}) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  unwrap(await seedRows(t.db, { ...admissionRows(o), ...o.extra }));
  const w = await startAdmission(t.db, clock, o);
  cleanups.push(async () => {
    await w.shutdown();
    t.cleanup();
  });
  return {
    ...w,
    setting: (key: string, value: number) =>
      seedRows(t.db, {
        settings: [{ key, value_json: JSON.stringify(value), updated_at: T0 }],
      }),
    edit: <T extends EditableTable>(table: T, id: string, patch: RowPatch<T>) =>
      updateRowForTest(t.db, table, id, patch),
  };
}

test("a spawn queued fleet_paused starts by itself once the fleet resumes, on the recheck", async () => {
  const w = await world();
  unwrap(await w.setting("fleet.paused", 1));
  unwrap(await w.spawn("P"));
  await w.until("P", { state: "pending", queued_reason: "fleet_paused" });
  unwrap(await w.setting("fleet.paused", 0));
  await w.recheck();
  await w.until("P", { state: "idle", queued_reason: null });
});

test("an uncertified runner is refused before any row, with its gate; certified, it spawns", async () => {
  const w = await world({ certified: false });
  expect(await w.spawn("U")).toMatchObject({
    ok: false,
    error: {
      class: "admission_refused",
      retryable: false,
      cause: { gate: "uncertified" },
    },
  });
  expect((await getSession(w.db, "U")).ok).toBe(false);
  await certifyPair(w.db, {
    runnerId: w.adapter.id,
    runnerVersion: FIXTURE_VERSION,
    caps: w.adapter.caps(),
    executorId: EXECUTOR_ID,
    at: T0,
  });
  unwrap(await w.spawn("C"));
  await w.until("C", { state: "idle" });
});

test("per model: a certificate for another model of the runner does not admit; the session's own does", async () => {
  const w = await world({ certified: false });
  const on = (modelIds: readonly string[]) =>
    certifyPair(w.db, {
      runnerId: w.adapter.id,
      runnerVersion: FIXTURE_VERSION,
      caps: w.adapter.caps(),
      executorId: EXECUTOR_ID,
      at: T0,
      modelIds,
    });
  // The rig's profile runs the standard tier; only the cheap model is certified.
  await on([`${FIXTURE_RUNNER_ID}.cheap`]);
  expect(await w.spawn("M1")).toMatchObject({
    ok: false,
    error: {
      class: "admission_refused",
      cause: { gate: "uncertified" },
      message: expect.stringContaining(
        `runner ${FIXTURE_RUNNER_ID} with model fixture-model is not certified on executor ${EXECUTOR_ID}`,
      ),
    },
  });
  expect((await getSession(w.db, "M1")).ok).toBe(false);
  await on([`${FIXTURE_RUNNER_ID}.standard`]);
  unwrap(await w.spawn("M2"));
  await w.until("M2", { state: "idle" });
  expect(unwrap(await getSession(w.db, "M2"))).toMatchObject({
    model_tier: "standard",
  });
});

test("an unpriced model is refused no_model before any row; a price of 0 spawns", async () => {
  const w = await world();
  const standard = `${FIXTURE_RUNNER_ID}.standard`;
  unwrap(await w.edit("models", standard, { price_out_per_mtok: null }));
  expect(await w.spawn("NP")).toMatchObject({
    ok: false,
    error: {
      class: "admission_refused",
      cause: { gate: "no_model" },
      message: expect.stringContaining(
        `model fixture-model of runner ${FIXTURE_RUNNER_ID} is unpriced`,
      ),
    },
  });
  expect((await getSession(w.db, "NP")).ok).toBe(false);
  unwrap(await w.edit("models", standard, { price_out_per_mtok: 0 }));
  unwrap(await w.spawn("ZP"));
  await w.until("ZP", { state: "idle" });
});

test("the model row's adapter settings ride the SpawnSpec; a row with none adds nothing", async () => {
  const watched = async (settings?: string) => {
    const specs: SpawnSpec[] = [];
    const w = await world({
      wrap: (inner) => ({
        ...inner,
        prepareHome: (spec, ex) => {
          specs.push(spec);
          return inner.prepareHome(spec, ex);
        },
      }),
    });
    if (settings !== undefined)
      unwrap(
        await w.edit("models", `${FIXTURE_RUNNER_ID}.standard`, {
          settings_json: settings,
        }),
      );
    unwrap(await w.spawn("S"));
    await w.until("S", { state: "idle" });
    return specs;
  };
  const [plain] = await watched();
  expect(plain).toBeDefined();
  expect(plain).not.toHaveProperty("modelSettings");
  const [own] = await watched('{"provider_url":"http://10.0.0.7:11434/v1"}');
  expect(own?.modelSettings).toEqual({
    provider_url: "http://10.0.0.7:11434/v1",
  });
});

test("the role binding's tier wins over the profile's: the session runs, and is certified on, the binding's model", async () => {
  const w = await world({ certified: false });
  await certifyPair(w.db, {
    runnerId: w.adapter.id,
    runnerVersion: FIXTURE_VERSION,
    caps: w.adapter.caps(),
    executorId: EXECUTOR_ID,
    at: T0,
    modelIds: [`${FIXTURE_RUNNER_ID}.standard`],
  });
  unwrap(
    await putRoleBinding(
      w.db,
      { role: "builder", runner_id: FIXTURE_RUNNER_ID, model_tier: "complex" },
      "operator",
    ),
  );
  // The profile's standard model is certified, but the binding says complex: refused.
  expect(await w.spawn("B1")).toMatchObject({
    ok: false,
    error: { cause: { gate: "uncertified" } },
  });
  await certifyPair(w.db, {
    runnerId: w.adapter.id,
    runnerVersion: FIXTURE_VERSION,
    caps: w.adapter.caps(),
    executorId: EXECUTOR_ID,
    at: T0,
    modelIds: [`${FIXTURE_RUNNER_ID}.complex`],
  });
  unwrap(await w.spawn("B2"));
  await w.until("B2", { state: "idle" });
  expect(unwrap(await getSession(w.db, "B2"))).toMatchObject({
    model_tier: "complex",
  });
});

test("a role binding with no tier leaves the profile's model", async () => {
  const w = await world();
  unwrap(
    await putRoleBinding(
      w.db,
      { role: "builder", runner_id: FIXTURE_RUNNER_ID, model_tier: null },
      "operator",
    ),
  );
  unwrap(await w.spawn("N1"));
  await w.until("N1", { state: "idle" });
  expect(unwrap(await getSession(w.db, "N1"))).toMatchObject({
    model_tier: "standard",
  });
});

test("a staffed builder whose profile allows no MCP tool is refused before any row, loudly and for good", async () => {
  // As the playground's `frm config apply` wrote it: the column's default, [].
  const w = await world({
    rows: { toolAllowlist: [] },
    extra: { tickets: [ticketRow(1, { status: "prioritized" })] },
  });
  // A ticket session as staffing sends it: no prompt, the ticket's own run 1.
  const refused = await w.spawn("T", { ticket_id: "ticket-1" });
  expect(refused).toMatchObject({
    ok: false,
    error: {
      class: "admission_refused",
      retryable: false,
      cause: { gate: "no_tools" },
    },
  });
  expect(!refused.ok && refused.error.message).toMatch(
    new RegExp(
      `^refused \\(no_tools\\): agent ${AGENT_ID}: profile ${PROFILE_ID} allows none of role builder's \\d+ MCP tools .*could not write back`,
    ),
  );
  expect((await getSession(w.db, "T")).ok).toBe(false);
});

test("a run class whose context cap is below the runner's session baseline is refused before any row, loudly and for good", async () => {
  // The runner row as boot writes it from the adapter's own defaults.
  const w = await world({
    rows: { runnerDefaults: { sessionBaselineTokens: 20_000 } },
  });
  // The seeded pulse class (6,000 tokens), for a builder: it runs with the runner's own tools.
  const refused = await w.spawn("L", { run_class: "pulse" });
  expect(refused).toMatchObject({
    ok: false,
    error: {
      class: "admission_refused",
      retryable: false,
      cause: { gate: "context_baseline" },
    },
  });
  expect(!refused.ok && refused.error.message).toMatch(
    new RegExp(
      `^refused \\(context_baseline\\): run class pulse's context_tokens_cap 6000 is below runner ${FIXTURE_RUNNER_ID}'s session baseline of 20000 tokens`,
    ),
  );
  expect((await getSession(w.db, "L")).ok).toBe(false);
  // The seeded build class (300,000 tokens) clears it.
  unwrap(await w.spawn("B", { run_class: "build" }));
  await w.until("B", { state: "idle" });
});

test("an MCP-only session (the pulse's role) is not held to the runner's session baseline", async () => {
  const w = await world({
    rows: { runnerDefaults: { sessionBaselineTokens: 20_000 } },
  });
  unwrap(await w.spawn("P", { role: PULSE_ROLE, run_class: "pulse" }));
  await w.until("P", { state: "idle" });
});

test("a job runner skips `uncertified` only: every other gate still holds it", async () => {
  const w = await world({
    certified: false,
    jobRunners: new Set([FIXTURE_RUNNER_ID]),
  });
  unwrap(await w.spawn("J"));
  await w.until("J", { state: "idle" });
  unwrap(await w.setting("fleet.paused", 1));
  unwrap(await w.spawn("J2"));
  await w.until("J2", { state: "pending", queued_reason: "fleet_paused" });
});

test("a queued spawn whose executor is disabled meanwhile is refused, keeping its queued_reason", async () => {
  const w = await world();
  unwrap(await w.setting("fleet.paused", 1));
  unwrap(await w.spawn("L"));
  await w.until("L", { state: "pending", queued_reason: "fleet_paused" });
  unwrap(await w.edit("executors", EXECUTOR_ID, { enabled: 0 }));
  await w.recheck();
  await w.until("L", {
    state: "exited",
    error_class: "admission_refused",
    error_message: `refused (disabled): executor ${EXECUTOR_ID} is disabled`,
    queued_reason: "fleet_paused",
  });
});

test("a spent fleet budget queues `budget`; the raised cap admits it", async () => {
  const w = await world({
    extra: {
      budgets: [
        {
          id: "b-fleet",
          scope: "fleet",
          scope_ref: null,
          period: "day",
          cap_usd: 0,
          updated_at: T0,
        },
      ],
    },
  });
  unwrap(await w.spawn("B"));
  await w.until("B", { state: "pending", queued_reason: "budget" });
  unwrap(await w.edit("budgets", "b-fleet", { cap_usd: 100 }));
  await w.recheck();
  await w.until("B", { state: "idle" });
});

test("a retry storm on this runner and executor queues `retry_storm`", async () => {
  // watchdog.retry_storm_count (5, 012) failed runner_error runs of this pair, just now.
  const ids = ["F0", "F1", "F2", "F3", "F4"];
  const w = await world({
    extra: {
      sessions: ids.map((id) => ({
        id,
        agent_id: AGENT_ID,
        role: "builder",
        run_class: "build",
        runner_id: FIXTURE_RUNNER_ID,
        executor_id: EXECUTOR_ID,
        session_root: `/tmp/${id}`,
        home_dir: `/tmp/${id}/home`,
        config_hash: "0".repeat(64),
        raw_log_path: `/tmp/${id}/raw.jsonl`,
        mcp_token_hash: `${id}`.padEnd(64, "0"),
        state: "exited",
        created_at: T0 - 60_000,
      })),
      runs: ids.map((id, i) => ({
        id: `R-${id}`,
        session_id: id,
        seq: 1,
        trigger: "operator",
        prompt_path: `/tmp/${id}/run-1.md`,
        prompt_hash: "0".repeat(64),
        context_hash: "0".repeat(64),
        state: "failed",
        error_class: "runner_error",
        started_at: T0 - 60_000,
        ended_at: T0 - 30_000 + i,
      })),
    },
  });
  unwrap(await w.spawn("S"));
  await w.until("S", { state: "pending", queued_reason: "retry_storm" });
});

test("executors.slots resized at runtime admits without a restart", async () => {
  // Two live sessions of one agent on purpose: this test is about the executor's capacity.
  const w = await world({ slots: 1, rows: { maxConcurrency: 2 } });
  unwrap(await w.spawn("A"));
  await w.until("A", { state: "idle" });
  unwrap(await w.spawn("B"));
  await w.until("B", { state: "pending", queued_reason: "slot" });
  unwrap(await w.edit("executors", EXECUTOR_ID, { slots: 2 }));
  await w.recheck();
  await w.until("B", { state: "idle", queued_reason: null });
  expect(w.slots.capacity()).toEqual({ slots: 2, used: 2 });
});

test("boot sizes each loaded counter from its row, before any spawn (LOW-2)", async () => {
  const w = await world({ slots: 2, counter: 5 });
  expect(w.slots.capacity()).toEqual({ slots: 2, used: 0 });
});

// §5.1 `concurrentSessions`: a credential that serves one session at a time is a
// capacity limit, so its second spawn waits, exactly as a spent budget or a full executor makes
// one wait. Conformance test 15's N/A rests on these three tests: without them a runner could
// declare its way out of a non-negotiable test.
test("a runner that serves one session at a time queues the second spawn, then starts it when the first ends", async () => {
  // Concurrency and slots are both wide open: only the runner's own credential is scarce.
  const w = await world({ singleSession: true, rows: { maxConcurrency: 4 } });
  unwrap(await w.spawn("A"));
  await w.until("A", { state: "idle" });
  const queued = await w.spawn("B");
  // Queued, never refused: the spawn is accepted and the row is pending with its reason.
  expect(queued).toMatchObject({ ok: true });
  await w.until("B", { state: "pending", queued_reason: "runner_concurrency" });
  expect(w.slots.capacity()).toMatchObject({ used: 1 });
  await w.stop("A", "kill");
  await w.until("B", { state: "idle", queued_reason: null });
});

test("two spawns arriving inside one drain pass: one is admitted, the other waits for it", async () => {
  const w = await world({ singleSession: true, rows: { maxConcurrency: 4 } });
  unwrap(await w.spawn("X"));
  unwrap(await w.spawn("Y"));
  await vi.waitFor(async () => {
    await w.lifecycle.settled();
    const states = [
      (await w.session("X")).state,
      (await w.session("Y")).state,
    ].toSorted();
    expect(states).toEqual(["idle", "pending"]);
  }, WAIT);
  const waiting = (await w.session("X")).state === "pending" ? "X" : "Y";
  expect(await w.session(waiting)).toMatchObject({
    queued_reason: "runner_concurrency",
  });
});

test("a runner that declares concurrentSessions runs both at once: the gate is the cap, not the runner", async () => {
  const w = await world({ rows: { maxConcurrency: 4 } });
  unwrap(await w.spawn("A"));
  unwrap(await w.spawn("B"));
  await w.until("A", { state: "idle", queued_reason: null });
  await w.until("B", { state: "idle", queued_reason: null });
});
