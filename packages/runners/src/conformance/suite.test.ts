// The suite's own rules, on the in-process fixture: a missed call deadline fails the test on
// `call_timeout:<method>`, a spent budget leaves tests `incomplete` (never failed), and `only`
// marks the rest not run. The kit hash pins every scenario.
import { systemClock, type Result } from "@bayon/core";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import { expect, test } from "vitest";
import type { RunnerAdapter } from "../adapter.js";
import { FIXTURE_KIT } from "../adapters/fixture/conformance.js";
import {
  FIXTURE_PROGRAM,
  createFixtureAdapter,
  fixtureProgram,
} from "../adapters/fixture/index.js";
import { FaultExecutor } from "./fault-executor.js";
import { createReferencePorts } from "./reference.js";
import { kitHash, runConformance } from "./suite.js";
import { OFFLINE_BUDGETS, type Budgets, type ConformanceKit } from "./types.js";

const BUDGETS: Budgets = { ...OFFLINE_BUDGETS, callMs: 300, turnMs: 3_000 };
const never = <T>() => new Promise<T>(() => undefined);

async function run(
  adapter: RunnerAdapter,
  o: {
    readonly budgets?: Budgets;
    readonly only?: readonly (1 | 2 | 3 | 14)[];
    readonly model?: string;
    readonly kit?: ConformanceKit;
  } = {},
) {
  const budgets = o.budgets ?? BUDGETS;
  const ports = await createReferencePorts({ clock: systemClock, budgets });
  try {
    const result = await runConformance(
      {
        adapter,
        kit: o.kit ?? FIXTURE_KIT,
        model: o.model ?? "fixture-model",
        executor: new FaultExecutor(
          new FakeExecutor({
            programs: { [FIXTURE_PROGRAM]: fixtureProgram },
            slots: new SlotCounter(8),
          }),
        ),
        env: {},
      },
      ports,
      { budgets, ...(o.only === undefined ? {} : { only: o.only }) },
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  } finally {
    await ports.workspace.dispose();
  }
}

const fixture = () =>
  createFixtureAdapter({ command: [FIXTURE_PROGRAM], graceMs: 200 });

test("a hanging adapter call fails its test on call_timeout:<method>", async () => {
  const hanging: RunnerAdapter = {
    ...fixture(),
    version: () => never<string>(),
    health: () => never<Result<{ version: string }>>(),
  };
  const r = await run(hanging, { only: [1] });
  expect(r.runner_version).toBe("unknown");
  expect(r.tests[0]).toMatchObject({
    id: 1,
    status: "fail",
    checks: [{ name: "call_timeout:version", ok: false }],
  });
});

test("a kit whose blocker finds nothing leaves a failed test failed, and the suite keeps going", async () => {
  const hanging: RunnerAdapter = {
    ...fixture(),
    version: () => never<string>(),
    health: () => never<Result<{ version: string }>>(),
  };
  const kit: ConformanceKit = { ...FIXTURE_KIT, blocker: () => null };
  const r = await run(hanging, { only: [1, 2], kit });
  const byId = new Map(r.tests.map((t) => [t.id, t]));
  expect(byId.get(1)?.status).toBe("fail");
  expect(byId.get(1)?.checks).not.toContainEqual(
    expect.objectContaining({ name: "runner_version" }),
  );
  // Not halted: test 2 ran normally, on the fixture's own model-free adapter (version/health only
  // hang; spawn and send are untouched).
  expect(byId.get(2)?.status).not.toBe("incomplete");
  expect(
    byId.get(2)?.checks.find((c) => c.name === "incomplete"),
  ).toBeUndefined();
});

test("a spent budget leaves the remaining tests incomplete, never failed", async () => {
  const r = await run(fixture(), {
    budgets: { ...BUDGETS, callMs: 3_000, maxUsd: 0 },
    only: [1, 2, 3, 14],
  });
  const byId = new Map(r.tests.map((t) => [t.id, t]));
  expect(byId.get(1)?.status).toBe("pass"); // model-free, before any spend
  expect(byId.get(2)?.status).toBe("pass"); // the run that spent it
  expect(byId.get(3)?.status).toBe("incomplete");
  expect(byId.get(3)?.checks).toContainEqual({
    name: "incomplete",
    ok: false,
    detail: "budget spent before this test",
  });
  expect(byId.get(4)?.checks).toEqual([
    { name: "not_run", ok: false, detail: "not in options.only" },
  ]);
  expect(r.summary).toMatchObject({ failed: [], certifiable: false });
});

test("the kit hash pins every scenario and changes with any of them", async () => {
  const h = await kitHash(FIXTURE_KIT, "fixture-model");
  expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(await kitHash(FIXTURE_KIT, "fixture-model")).toBe(h);
  const changed: ConformanceKit = {
    ...FIXTURE_KIT,
    scenario: (name, vars) => ({
      ...FIXTURE_KIT.scenario(name, vars),
      turns: ["something else"],
    }),
  };
  expect(await kitHash(changed, "fixture-model")).not.toBe(h);
});

test("compression off hashes exactly as before M12; on, the ruleset and test 17's scenario join", async () => {
  // Pinned from before this change: every compression-off certificate keeps its hash.
  const off =
    "sha256:88030f3ce36d4f29c6e8125f3a477235ce3604c59fa35bdcdbf2d04b4eefc134";
  expect(await kitHash(FIXTURE_KIT, "fixture-model")).toBe(off);
  expect(await kitHash(FIXTURE_KIT, "fixture-model", {}, undefined)).toBe(off);
  const on = await kitHash(
    FIXTURE_KIT,
    "fixture-model",
    {},
    { ruleset: "ctx1" },
  );
  expect(on).not.toBe(off);
  expect(
    await kitHash(FIXTURE_KIT, "fixture-model", {}, { ruleset: "ctx2" }),
  ).not.toBe(on);
  const scenario: ConformanceKit = {
    ...FIXTURE_KIT,
    compressionScenario: (vars) => ({ flags: {}, turns: [vars.logFile] }),
  };
  expect(await kitHash(scenario, "fixture-model")).toBe(off);
  expect(
    await kitHash(scenario, "fixture-model", {}, { ruleset: "ctx1" }),
  ).not.toBe(on);
});

test("a compression run of a runner that declares no compression is refused before any test", async () => {
  const ports = await createReferencePorts({
    clock: systemClock,
    budgets: BUDGETS,
  });
  try {
    const r = await runConformance(
      {
        adapter: fixture(),
        kit: FIXTURE_KIT,
        model: "fixture-model",
        executor: new FaultExecutor(
          new FakeExecutor({
            programs: { [FIXTURE_PROGRAM]: fixtureProgram },
            slots: new SlotCounter(8),
          }),
        ),
        env: {},
      },
      ports,
      { budgets: BUDGETS, compression: true },
    );
    expect(r.ok ? "ran" : r.error).toMatchObject({
      class: "validation",
      message: expect.stringMatching(/does not compress context/),
    });
  } finally {
    await ports.workspace.dispose();
  }
});

test("the run spawns with the subject's model, records it, and hashes it with the kit", async () => {
  const base = fixture();
  const models: string[] = [];
  const watching: RunnerAdapter = new Proxy(base, {
    get(target, key, receiver): unknown {
      if (key === "spawn") {
        return (...args: Parameters<RunnerAdapter["spawn"]>) => {
          models.push(args[0].model);
          return target.spawn(...args);
        };
      }
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const r = await run(watching, { only: [2], model: "tier-model-x" });
  expect(r.model).toBe("tier-model-x");
  expect(models.length).toBeGreaterThan(0);
  expect(new Set(models)).toEqual(new Set(["tier-model-x"]));
  // The subject's model, not the kit's, is hashed with the kit: another model, another hash.
  const other = await run(fixture(), { only: [2], model: "tier-model-y" });
  expect(r.kit_hash).toBe(await kitHash(FIXTURE_KIT, "tier-model-x"));
  expect(other.kit_hash).toBe(await kitHash(FIXTURE_KIT, "tier-model-y"));
  expect(other.kit_hash).not.toBe(r.kit_hash);
  expect(other.model).toBe("tier-model-y");
});
