// The gate engine and a CI gate: a `qa_harness` gate opened with the `pull_request`
// subject runs nothing. The poll never launches it as "untracked, never started", never times it
// out on gates.wall_clock_ms, and a claimed `gate.run` for it starts no session. Only the CI sweep
// (delivery/ci-checks.ts) decides it. The same gate running a command is launched, which is the
// control that shows the subject — not the kind — is what the engine reads. No process is spawned.
import { CI_SUBJECT, FLEET_PAUSED_KEY, FakeClock } from "@bayon/core";
import { getGate } from "@bayon/db";
import { GATE_NOW, gateDb, seedRows, unwrap } from "@bayon/db/testing";
import { afterEach, expect, test, vi } from "vitest";
import { createGateEngine, type GateEngine } from "./engine.js";

const WALL_CLOCK_MS = 900_000; // 007's gates.wall_clock_ms
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function world(subjectKind: string) {
  const t = await gateDb(["qa_harness"]);
  const clock: FakeClock = t.clock;
  unwrap(
    await seedRows(t.db, {
      // Resumed before the gate opened, so its wall clock runs from its own start (pause.test.ts).
      settings: [
        {
          key: FLEET_PAUSED_KEY,
          value_json: "0",
          updated_at: GATE_NOW - 60_000,
        },
      ],
      gates: [
        {
          id: "G1",
          ticket_id: "ticket-1",
          kind: "qa_harness",
          state: "running",
          subject_kind: subjectKind,
          subject_ref: "unpinned",
          started_at: GATE_NOW,
        },
      ],
    }),
  );
  const spawnInternal = vi.fn(async () => ({
    ok: false as const,
    error: {
      class: "internal" as const,
      message: "no spawn here",
      retryable: false,
    },
  }));
  const engine: GateEngine = createGateEngine({
    db: t.db,
    clock,
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    frmHome: "/nonexistent",
    lifecycle: {
      spawnInternal,
      stop: async () => undefined,
      onSessionEnded: () => () => undefined,
    },
    adapters: new Map(),
    executors: new Map(),
    path: "",
  });
  cleanups.push(async () => {
    await engine.stop();
    t.cleanup();
  });
  const gate = async () => unwrap(await getGate(t.db, "G1"));
  return { clock, engine, spawnInternal, gate };
}

test("the poll leaves a CI gate running, however far past gates.wall_clock_ms", async () => {
  const w = await world(CI_SUBJECT);
  await w.engine.start();
  await w.clock.advance(4 * WALL_CLOCK_MS);
  await w.engine.tick();
  await w.engine.settled();
  expect(await w.gate()).toMatchObject({
    state: "running",
    evidence_json: null,
    decided_at: null,
  });
  expect(w.spawnInternal).not.toHaveBeenCalled();
});

test("a gate.run claimed for a CI gate starts no session; the gate stays running", async () => {
  const w = await world(CI_SUBJECT);
  const result = await w.engine.handler.handle(
    { gate_id: "G1", session_id: "S-CI" },
    { id: "cmd-1", attempts: 1 },
  );
  expect(result.ok).toBe(true);
  await w.engine.settled();
  expect(w.spawnInternal).not.toHaveBeenCalled();
  expect(await w.gate()).toMatchObject({ state: "running" });
});

test("control: the same gate over a workspace is launched, and timed out past the wall clock", async () => {
  const launched = await world("workspace");
  await launched.engine.tick();
  await launched.engine.settled();
  // It launched: no QA job is seeded, so it fails at once — which a CI gate never does.
  expect(await launched.gate()).toMatchObject({ state: "failed" });

  const late = await world("workspace");
  await late.clock.advance(2 * WALL_CLOCK_MS);
  await late.engine.tick();
  await late.engine.settled();
  expect(await late.gate()).toMatchObject({ state: "failed" });
  expect((await late.gate()).evidence_json).toContain('"timeout"');
});
