// The gate engine under the kill switch: while the fleet is
// paused no reviewer launches and no unlaunched gate times out, however long the pause; after the
// resume the gate launches with its wall clock from the resume. The gates here are qa_harness,
// which has no reviewer at all: a launch then ends at once in `no_reviewer`, so a decision other
// than `timeout` is the proof it launched. A FakeClock drives time; no process is spawned.
//
// an earlier change gave `qa_harness` a job, so the kind with no reviewer is now `human_qa` — the last one
// `isRoundGateKind` refuses. What is under test is the pause, not the kind.
import {
  FLEET_PAUSED_KEY,
  FakeClock,
  StoredGateEvidence,
  type GateKind,
} from "@bayon/core";
import { getGate } from "@bayon/db";
import { GATE_NOW, gateDb, seedRows, unwrap } from "@bayon/db/testing";
import { afterEach, expect, test, vi } from "vitest";
import { createGateEngine, type GateEngine } from "./engine.js";

const WALL_CLOCK_MS = 900_000; // 007's gates.wall_clock_ms
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function world(o: {
  readonly paused: boolean;
  readonly kind?: GateKind;
}) {
  const t = await gateDb(["code_review"]);
  const clock: FakeClock = t.clock;
  unwrap(
    await seedRows(t.db, {
      settings: [
        {
          key: FLEET_PAUSED_KEY,
          value_json: o.paused ? "1" : "0",
          updated_at: GATE_NOW - 60_000,
        },
      ],
      gates: [
        {
          id: "G1",
          ticket_id: "ticket-1",
          kind: o.kind ?? "human_qa",
          state: "running",
          subject_kind: "commit",
          subject_ref: "HEAD",
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
  const reason = async () => {
    const evidence = (await gate()).evidence_json;
    return evidence === null
      ? null
      : StoredGateEvidence.parse(JSON.parse(evidence)).reason;
  };
  const setPaused = (paused: boolean) =>
    seedRows(t.db, {
      settings: [
        {
          key: FLEET_PAUSED_KEY,
          value_json: paused ? "1" : "0",
          updated_at: clock.now(),
        },
      ],
    });
  return { t, clock, engine, spawnInternal, gate, reason, setPaused };
}

test("unpaused, an unlaunched gate past its wall clock times out (the rule the pause suspends)", async () => {
  const w = await world({ paused: false });
  await w.clock.advance(2 * WALL_CLOCK_MS);
  await w.engine.tick();
  await w.engine.settled();
  expect(await w.gate()).toMatchObject({ state: "failed" });
  expect(await w.reason()).toBe("timeout");
});

test("paused for twice the wall clock: nothing launches or times out; resumed, it launches then", async () => {
  const w = await world({ paused: true });
  await w.engine.start();
  await w.clock.advance(2 * WALL_CLOCK_MS);
  await w.engine.tick();
  await w.engine.settled();
  expect(await w.gate()).toMatchObject({
    state: "running",
    evidence_json: null,
  });

  unwrap(await w.setPaused(false));
  await w.engine.tick();
  await w.engine.settled();
  // Launched (its kind has no reviewer, so it fails at once), not timed out.
  expect(await w.gate()).toMatchObject({ state: "failed" });
  expect(await w.reason()).toBe("no_reviewer");
});

test("a gate.run claimed while paused is skipped, not launched; the gate stays running", async () => {
  const w = await world({ paused: true, kind: "code_review" });
  const result = await w.engine.handler.handle(
    { gate_id: "G1", session_id: "S-REVIEW" },
    { id: "cmd-1", attempts: 1 },
  );
  expect(result).toEqual({
    ok: true,
    value: { gate_id: "G1", skipped: "fleet_paused" },
  });
  await w.engine.settled();
  expect(w.spawnInternal).not.toHaveBeenCalled();
  expect(await w.gate()).toMatchObject({ state: "running" });
});
