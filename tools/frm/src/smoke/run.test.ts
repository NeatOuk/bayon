import { mkdtempSync, rmSync } from "node:fs";
import { FakeClock } from "@bayon/core";
import { keychainScope } from "@bayon/executors";
import { expect, test } from "vitest";
import type { SmokeOptions } from "../cli.js";
import { SMOKE_HOME_PREFIX, m3Placement, runSmoke } from "./run.js";

const m3: SmokeOptions = {
  mode: "m3",
  runner: "fixture",
  timeoutMs: 1_000,
  keep: false,
  certify: false,
};

test("m3Placement: local unless --executor names another; the container run needs FRM_CONTAINER=1", () => {
  expect(m3Placement(m3, {})).toEqual({ ok: true, value: null });
  expect(m3Placement({ ...m3, executor: "local" }, {})).toEqual({
    ok: true,
    value: null,
  });
  // FRM_CONTAINER=1 alone does not make the plain --m3 remote: it stays local and fast.
  expect(m3Placement(m3, { FRM_CONTAINER: "1" })).toEqual({
    ok: true,
    value: null,
  });
  expect(m3Placement({ ...m3, mode: "m2", executor: "ctr-lab" }, {})).toEqual({
    ok: true,
    value: null,
  });
  expect(
    m3Placement({ ...m3, executor: "ctr-lab" }, { FRM_CONTAINER: "1" }),
  ).toEqual({ ok: true, value: "ctr-lab" });
  expect(m3Placement({ ...m3, executor: "ctr-lab" }, {})).toMatchObject({
    ok: false,
    error: { message: expect.stringMatching(/set FRM_CONTAINER=1 to opt in/) },
  });
});

test("runSmoke refuses the container run without FRM_CONTAINER=1: one FAIL line, exit 1, nothing started", async () => {
  const out: string[] = [];
  const code = await runSmoke(
    { ...m3, executor: "ctr-lab" },
    { env: {}, clock: new FakeClock(0), out: (l) => out.push(l) },
  );
  expect(code).toBe(1);
  expect(out).toEqual([
    "FAIL  --m3 --executor ctr-lab runs on the shared docker host: set FRM_CONTAINER=1 to opt in",
  ]);
});

test("runSmoke refuses an executor name the per-run suffix cannot follow, before touching the host", async () => {
  const out: string[] = [];
  const code = await runSmoke(
    { ...m3, executor: "Not_A_Name" },
    {
      env: { FRM_CONTAINER: "1", FRM_CONTAINER_HOST: "ops@192.0.2.10" },
      clock: new FakeClock(0),
      out: (l) => out.push(l),
    },
  );
  expect(code).toBe(1);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatch(/^FAIL {2}--executor "Not_A_Name" must match/);
});

test("a smoke's FRM_HOME reads its own Keychain service, never the live install's foreman", () => {
  const home = mkdtempSync(SMOKE_HOME_PREFIX);
  try {
    const scope = keychainScope({ FRM_HOME: home });
    expect(scope.owner).toBe(false);
    expect(scope.service).toMatch(/^foreman-[0-9a-f]{12}$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
