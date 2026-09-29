// The suite's model pre-flight, runner-neutral on the in-process fixture: a model the
// provider does not serve, or a provider that does not answer, refuses the run before any test;
// served and unchecked run it as before.
import { systemClock } from "@bayon/core";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import { expect, test, vi } from "vitest";
import type { ModelPreflight, RunnerAdapter } from "../adapter.js";
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

const BUDGETS: Budgets = { ...OFFLINE_BUDGETS, callMs: 300, turnMs: 3_000 };

function adapterWith(verdict: ModelPreflight) {
  const hook = vi.fn<NonNullable<RunnerAdapter["preflightModel"]>>(
    async () => verdict,
  );
  const spawn = vi.fn();
  const base = createFixtureAdapter({
    command: [FIXTURE_PROGRAM],
    graceMs: 200,
  });
  const adapter: RunnerAdapter = {
    ...base,
    preflightModel: hook,
    spawn: (spec, ex) => {
      spawn();
      return base.spawn(spec, ex);
    },
  };
  return { adapter, hook, spawn };
}

async function run(adapter: RunnerAdapter) {
  const ports = await createReferencePorts({
    clock: systemClock,
    budgets: BUDGETS,
  });
  try {
    return await runConformance(
      {
        adapter,
        kit: FIXTURE_KIT,
        model: "fixture-model",
        modelSettings: { knob: 1 },
        executor: new FaultExecutor(
          new FakeExecutor({
            programs: { [FIXTURE_PROGRAM]: fixtureProgram },
            slots: new SlotCounter(8),
          }),
        ),
        env: { PROVIDER_URL: "http://127.0.0.1:9/v1" },
      },
      ports,
      { budgets: BUDGETS, only: [1] },
    );
  } finally {
    await ports.workspace.dispose();
  }
}

test("not served: the run is refused before any test, with the adapter's reason", async () => {
  const { adapter, hook, spawn } = adapterWith({
    verdict: "not_served",
    reason: "model m-1 not served by 127.0.0.1:9",
  });
  const got = await run(adapter);
  expect(got).toEqual({
    ok: false,
    error: {
      class: "runner_error",
      message: "model m-1 not served by 127.0.0.1:9",
      retryable: false,
    },
  });
  expect(spawn).not.toHaveBeenCalled();
  // Asked as a session of the run would spawn: the model, its settings, the kit's flags, the env.
  expect(hook.mock.calls[0]?.[0]).toEqual({
    model: "fixture-model",
    modelSettings: { knob: 1 },
    flags: FIXTURE_KIT.scenario("plain", {
      nonce: "{nonce}",
      mcpTool: "{mcpTool}",
      marker: "{marker}",
      roots: ["{root}"],
      outside: "{outside}",
      rootMarker: "{rootMarker}",
    }).flags,
    env: { PROVIDER_URL: "http://127.0.0.1:9/v1" },
    executorKind: "local",
  });
});

test("unreachable: the run fails closed, retryable, naming why", async () => {
  const { adapter, spawn } = adapterWith({
    verdict: "unreachable",
    reason: "cannot ask 127.0.0.1:9 which models it serves: refused",
  });
  const got = await run(adapter);
  expect(got).toMatchObject({
    ok: false,
    error: {
      class: "runner_error",
      message:
        "the model pre-flight could not confirm fixture-model: cannot ask 127.0.0.1:9 which models it serves: refused",
      retryable: true,
    },
  });
  expect(spawn).not.toHaveBeenCalled();
});

test.each<ModelPreflight>([
  { verdict: "served" },
  { verdict: "unchecked", reason: "nothing to ask" },
])("$verdict: the suite runs", async (verdict) => {
  const { adapter } = adapterWith(verdict);
  const got = await run(adapter);
  expect(got.ok).toBe(true);
  expect(got.ok && got.value.tests[0]?.status).toBe("pass");
});
