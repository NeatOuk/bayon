// §15 #8's process_dead after a group kill. The exit t08 waits for is the group leader's;
// another member of the group took the same SIGKILL but can still be in the process table, mid-exit,
// when that exit settles. Under load, a runner's child outlived its host's exit by ~50 ms, and a single
// probe read the group alive. The test re-probes within its call budget, as the reconciler does after
// its own SIGKILL (§9.6), and a group that never dies still fails.
import { FakeClock, systemClock } from "@bayon/core";
import { SlotCounter, type Executor, type ProbeState } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import { describe, expect, test } from "vitest";
import { FIXTURE_KIT } from "../../adapters/fixture/conformance.js";
import {
  FIXTURE_PROGRAM,
  createFixtureAdapter,
  fixtureProgram,
} from "../../adapters/fixture/index.js";
import { FaultExecutor } from "../fault-executor.js";
import { REPROBE_MS, probesDeadWithin } from "../groups.js";
import { createReferencePorts } from "../reference.js";
import { runConformance } from "../suite.js";
import { OFFLINE_BUDGETS, type Budgets } from "../types.js";

/** One event-loop turn: every pending continuation runs before the fake clock moves. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Drives `clock` in REPROBE_MS steps until `pending` settles; at most `steps` of them. */
async function drive<T>(
  clock: FakeClock,
  pending: Promise<T>,
  steps: number,
): Promise<T> {
  let done = false;
  void pending.finally(() => {
    done = true;
  });
  for (let i = 0; i < steps && !done; i += 1) {
    await settle();
    if (!done) await clock.advance(REPROBE_MS);
  }
  await settle();
  if (!done) throw new Error(`still pending after ${steps} steps`);
  return pending;
}

/** A probe that reads each of `states` in turn, then the last one for good; it logs when it ran. */
function scripted(clock: FakeClock, states: readonly ProbeState[]) {
  const at: number[] = [];
  const probe = async (): Promise<ProbeState> => {
    at.push(clock.now());
    return states[Math.min(at.length, states.length) - 1] ?? "dead";
  };
  return { probe, at };
}

describe("probesDeadWithin", () => {
  test("a group that reads dead at once needs no second probe", async () => {
    const clock = new FakeClock(0);
    const s = scripted(clock, ["dead"]);
    expect(await drive(clock, probesDeadWithin(s.probe, clock, 1_000), 1)).toBe(
      true,
    );
    expect(s.at).toEqual([0]);
  });

  test("a member that outlives the leader's exit is waited for, one reprobe at a time", async () => {
    const clock = new FakeClock(0);
    const s = scripted(clock, ["alive", "alive", "dead"]);
    expect(
      await drive(clock, probesDeadWithin(s.probe, clock, 1_000), 10),
    ).toBe(true);
    expect(s.at).toEqual([0, REPROBE_MS, 2 * REPROBE_MS]);
  });

  test("a group still alive at the deadline is not dead: process_dead is not weakened", async () => {
    const clock = new FakeClock(0);
    const s = scripted(clock, ["alive"]);
    expect(await drive(clock, probesDeadWithin(s.probe, clock, 300), 10)).toBe(
      false,
    );
    // Probed at 0, 100, 200 and at the deadline itself, never after it.
    expect(s.at).toEqual([0, 100, 200, 300]);
  });
});

/**
 * The fake executor, but after `kill9` its probe reads the group alive `lingering` more times, as a
 * killed leader's child still exiting does. Everything else is the real FaultExecutor.
 */
class LingeringGroup extends FaultExecutor {
  readonly #lingering: number;
  #left = 0;
  #afterKill: ProbeState[] = [];

  constructor(inner: Executor, lingering: number) {
    super(inner);
    this.#lingering = lingering;
  }

  /** What each probe after the kill read, in order. */
  get probesAfterKill(): readonly ProbeState[] {
    return this.#afterKill;
  }

  override kill9(cwd: string): boolean {
    this.#left = this.#lingering;
    this.#afterKill = [];
    return super.kill9(cwd);
  }

  override async probe(ref: string): Promise<ProbeState> {
    const real = await super.probe(ref);
    const state: ProbeState =
      real === "dead" && this.#left > 0 ? "alive" : real;
    if (state !== real) this.#left -= 1;
    this.#afterKill = [...this.#afterKill, state];
    return state;
  }
}

const BUDGETS: Budgets = { ...OFFLINE_BUDGETS, callMs: 2_000, turnMs: 3_000 };

async function testEight(executor: LingeringGroup) {
  const ports = await createReferencePorts({
    clock: systemClock,
    budgets: BUDGETS,
  });
  try {
    const result = await runConformance(
      {
        adapter: createFixtureAdapter({
          command: [FIXTURE_PROGRAM],
          graceMs: 200,
        }),
        kit: FIXTURE_KIT,
        model: "fixture-model",
        executor,
        env: {},
      },
      ports,
      { budgets: BUDGETS, only: [8] },
    );
    if (!result.ok) throw new Error(result.error.message);
    const eight = result.value.tests.find((t) => t.id === 8);
    return {
      status: eight?.status,
      failed: eight?.checks.filter((c) => !c.ok).map((c) => c.name),
    };
  } finally {
    await ports.workspace.dispose();
  }
}

const lingering = (probes: number) =>
  new LingeringGroup(
    new FakeExecutor({
      programs: { [FIXTURE_PROGRAM]: fixtureProgram },
      slots: new SlotCounter(8),
    }),
    probes,
  );

describe("§15 #8 kill + adopt", { timeout: 20_000 }, () => {
  test("passes when the group dies a moment after its leader's exit", async () => {
    const executor = lingering(2);
    expect(await testEight(executor)).toEqual({ status: "pass", failed: [] });
    expect(executor.probesAfterKill.slice(0, 3)).toEqual([
      "alive",
      "alive",
      "dead",
    ]);
  });

  test("fails process_dead when the group never dies, and its teardown's stop with it", async () => {
    const executor = lingering(Number.POSITIVE_INFINITY);
    // The teardown waits for the session's groups and kills what is left: one that
    // outlives its kill is a stop that never finished.
    expect(await testEight(executor)).toEqual({
      status: "fail",
      failed: ["process_dead", "call_timeout:stop"],
    });
  });
});
