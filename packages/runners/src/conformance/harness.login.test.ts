// A granted login through the suite's sessions (§14): the harness reads it again at every
// process start, as a session's spawn and adopt read it, carries it on SpawnSpec.grantedLogin (the
// field the adapters' write-back keys on), redacts it from the process's records, and makes a
// failed read `incomplete` without starting anything. The fixture ignores the field, so these
// tests watch the specs it is handed rather than what it does with them.
import { err, ok, systemClock, type Result } from "@bayon/core";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import { afterEach, expect, test } from "vitest";
import type { RunnerAdapter, SpawnSpec } from "../adapter.js";
import { FIXTURE_KIT } from "../adapters/fixture/conformance.js";
import {
  FIXTURE_PROGRAM,
  createFixtureAdapter,
  fixtureProgram,
} from "../adapters/fixture/index.js";
import { frmError } from "../errors.js";
import { FaultExecutor } from "./fault-executor.js";
import { Incomplete, SuiteCtx } from "./harness.js";
import { createReferencePorts } from "./reference.js";
import {
  OFFLINE_BUDGETS,
  type Budgets,
  type ConformancePorts,
  type ConformanceSubject,
} from "./types.js";

const BUDGETS: Budgets = { ...OFFLINE_BUDGETS, callMs: 2_000, turnMs: 5_000 };

type Login = NonNullable<SpawnSpec["grantedLogin"]>;
const FIRST: Login = {
  path: "/op/auth.json",
  value: '{"tokens":{"refresh_token":"r-1"}}',
  mode: 0o600,
};
const ROTATED: Login = {
  ...FIRST,
  value: '{"tokens":{"refresh_token":"r-2"}}',
};

/** What the harness handed the adapter and the ingest, per process start. */
interface Seen {
  readonly specs: SpawnSpec[];
  readonly redact: (readonly string[] | undefined)[];
}

const opened: ConformancePorts[] = [];
afterEach(async () => {
  for (const p of opened.splice(0)) await p.workspace.dispose();
});

async function suite(
  grantedLogin?: ConformanceSubject["grantedLogin"],
): Promise<{ ctx: SuiteCtx; seen: Seen }> {
  const seen: Seen = { specs: [], redact: [] };
  const fx = createFixtureAdapter({ command: [FIXTURE_PROGRAM], graceMs: 200 });
  const adapter: RunnerAdapter = {
    ...fx,
    spawn: (spec, ex) => {
      seen.specs.push(spec);
      return fx.spawn(spec, ex);
    },
    adopt: (spec, ex) => {
      seen.specs.push(spec);
      return fx.adopt(spec, ex);
    },
  };
  const ports = await createReferencePorts({
    clock: systemClock,
    budgets: BUDGETS,
  });
  opened.push(ports);
  const ingest = ports.ingest;
  const executor = new FakeExecutor({
    programs: { [FIXTURE_PROGRAM]: fixtureProgram },
    slots: new SlotCounter(8),
  });
  const ctx = new SuiteCtx(
    {
      adapter,
      kit: FIXTURE_KIT,
      model: "fixture-model",
      executor: new FaultExecutor(executor),
      env: {},
      ...(grantedLogin === undefined ? {} : { grantedLogin }),
    },
    {
      ...ports,
      ingest: {
        ...ingest,
        attach: (a) => {
          seen.redact.push(a.redact);
          return ingest.attach(a);
        },
      },
    },
    BUDGETS,
  );
  return { ctx, seen };
}

test("every process start reads the grant again and carries it on SpawnSpec.grantedLogin, redacted from its records", async () => {
  const logins = [FIRST, ROTATED];
  let reads = 0;
  const { ctx, seen } = await suite(async () => {
    const login = logins[Math.min(reads, logins.length - 1)];
    reads += 1;
    return login === undefined
      ? err(frmError("internal", "no login"))
      : ok(login);
  });
  const a = await ctx.open({ scenario: "plain" });
  expect(reads).toBe(0); // opening a session starts nothing, so reads nothing
  expect(a.spec.grantedLogin).toBeUndefined();
  await a.spawn();
  expect(seen.specs[0]?.grantedLogin).toEqual(FIRST);
  expect(seen.redact[0]).toEqual([FIRST.value]);
  // The next start reads the file as it is now: a rotation written back in between is what it gets.
  const b = await ctx.open({ scenario: "plain" });
  expect((await b.prepareHome()).ok).toBe(true);
  await b.adopt("frm-conformance-no-such-session");
  expect(reads).toBe(2);
  expect(seen.specs[1]).toMatchObject({
    grantedLogin: ROTATED,
    resumeRunnerSessionId: "frm-conformance-no-such-session",
  });
  expect(await ctx.teardown()).toEqual([]);
});

test("without a grant nothing is read and no spec carries one", async () => {
  const { ctx, seen } = await suite();
  const live = await ctx.open({ scenario: "plain" });
  await live.spawn();
  expect(seen.specs).toHaveLength(1);
  expect(seen.specs[0]).not.toHaveProperty("grantedLogin");
  expect(seen.redact[0]).toEqual([]);
  expect(await ctx.teardown()).toEqual([]);
});

test("a grant that cannot be read makes the test incomplete, and starts nothing", async () => {
  const refused: Result<Login> = err(
    frmError("validation", "runners.login_in_place: the file is gone"),
  );
  const { ctx, seen } = await suite(async () => refused);
  const live = await ctx.open({ scenario: "plain" });
  const spawned = live.spawn();
  await expect(spawned).rejects.toBeInstanceOf(Incomplete);
  await expect(spawned).rejects.toThrow("the file is gone");
  await expect(live.adopt("rsid")).rejects.toBeInstanceOf(Incomplete);
  expect(seen.specs).toEqual([]);
  expect(await ctx.teardown()).toEqual([]);
});
