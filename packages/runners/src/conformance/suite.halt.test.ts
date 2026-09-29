// the harness failing mid-run (here a port that throws during a teardown) ends the suite
// with its results so far, never a rejection: the test it failed in and every later one are
// incomplete, and the caller still has a result to write its report from.
import { systemClock } from "@bayon/core";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import { expect, test } from "vitest";
import { FIXTURE_KIT } from "../adapters/fixture/conformance.js";
import {
  FIXTURE_PROGRAM,
  createFixtureAdapter,
  fixtureProgram,
} from "../adapters/fixture/index.js";
import { FaultExecutor } from "./fault-executor.js";
import { createReferencePorts } from "./reference.js";
import { runConformance } from "./suite.js";
import { OFFLINE_BUDGETS, type Budgets } from "./types.js";

const BUDGETS: Budgets = { ...OFFLINE_BUDGETS, callMs: 2_000, turnMs: 5_000 };

test("a harness failing mid-run keeps the results so far: that test and the rest are incomplete", async () => {
  const ports = await createReferencePorts({
    clock: systemClock,
    budgets: BUDGETS,
  });
  const executor = new FaultExecutor(
    new FakeExecutor({
      programs: { [FIXTURE_PROGRAM]: fixtureProgram },
      slots: new SlotCounter(8),
    }),
  );
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
      {
        ...ports,
        ingest: {
          ...ports.ingest,
          ended: () => {
            throw new Error("ingest ended exploded (test)");
          },
        },
      },
      { budgets: BUDGETS, only: [1, 2, 10] },
    );
    if (!result.ok) throw new Error(result.error.message);
    const byId = new Map(result.value.tests.map((t) => [t.id, t]));
    expect(byId.get(1)?.status).toBe("pass");
    expect(byId.get(2)).toMatchObject({
      status: "incomplete",
      checks: [
        {
          name: "incomplete",
          ok: false,
          detail: expect.stringContaining(
            "the harness failed in test 2: ingest ended exploded (test)",
          ),
        },
      ],
    });
    expect(byId.get(10)).toMatchObject({
      status: "incomplete",
      checks: [
        {
          name: "incomplete",
          detail: expect.stringContaining(
            "not run: the harness failed in test 2",
          ),
        },
      ],
    });
    expect(result.value.summary.certifiable).toBe(false);
  } finally {
    await executor.end(systemClock, BUDGETS.callMs);
    await ports.workspace.dispose();
  }
});
