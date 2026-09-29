import { FakeClock, renderMission, sha256Hex } from "@bayon/core";
import { seedConfig } from "@bayon/db/operator";
import { seedSpine, tempDb, unwrap } from "@bayon/db/testing";
import { MissionSaveRequest, SpawnRequest } from "@bayon/proto";
import { FIXTURE_RUNNER_ID, FixtureScript } from "@bayon/runners/fixture";
import { afterAll, expect, test } from "vitest";
import {
  BUILD_SCRIPT,
  GATED_SCRIPT,
  HANG_SCRIPT,
  MISSION,
  MISSION_REQUEST,
  SMOKE,
  SMOKE_AGENTS,
  agentId,
  missionHash,
  smokeConfig,
  spawnRequest,
} from "./config.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const repo = {
  origin: "/tmp/o",
  mirror: "/tmp/m.git",
  baseSha: "a".repeat(40),
};
const config = await smokeConfig({
  now: T0,
  repo,
  runnerId: FIXTURE_RUNNER_ID,
});
// A registered fixture runner and the `local` executor, as the supervisor's boot leaves them.
const registered = unwrap(await tempDb(clock));
unwrap(await seedSpine(registered.db, 2));
const fresh = unwrap(await tempDb(clock));
afterAll(() => {
  registered.cleanup();
  fresh.cleanup();
});

test("the scripts are valid fixture scripts; only BUILD edits the README", () => {
  const build = FixtureScript.parse(BUILD_SCRIPT);
  expect(build.runs[0]?.appends).toEqual([
    { path: "README.md", text: `${SMOKE.readmeLine}\n` },
  ]);
  expect(FixtureScript.parse(GATED_SCRIPT).runs[0]?.gate).toBe("release");
  expect(FixtureScript.parse(HANG_SCRIPT).runs[0]?.then).toBe("hard_hang");
});

test("beforeBoot needs no runner or executor row; afterBoot needs the boot's", async () => {
  unwrap(await seedConfig(fresh.db, config.beforeBoot));
  const early = await seedConfig(fresh.db, config.afterBoot);
  expect(early.ok ? null : early.error.class).toBe("validation");
  unwrap(await seedConfig(registered.db, config.beforeBoot));
  unwrap(await seedConfig(registered.db, config.afterBoot));
});

test("missions are not operator rows: agents start without one, saved later over POST /missions", async () => {
  expect(config.beforeBoot).not.toHaveProperty("missions");
  expect(config.afterBoot).not.toHaveProperty("missions");
  expect(
    config.afterBoot.agents?.filter((agent) => "mission_id" in agent),
  ).toEqual([]);
  expect(MissionSaveRequest.parse(MISSION_REQUEST)).toEqual(MISSION_REQUEST);
  expect(MISSION_REQUEST.base_version).toBe(0);
});

test("each agent's mission hash is the core template's over its name, so runs can be checked", async () => {
  expect(config.missionHash).toBe(
    await sha256Hex(renderMission("smoke-build", MISSION)),
  );
  const hashes = await Promise.all(SMOKE_AGENTS.map(missionHash));
  expect(hashes[0]).toBe(config.missionHash);
  expect(new Set(hashes).size).toBe(SMOKE_AGENTS.length);
  expect(SMOKE_AGENTS.map(agentId)).toEqual(
    config.afterBoot.agents?.map((agent) => agent.name),
  );
});

test("each profile carries its script in the sandbox flags", () => {
  const scripts = Object.fromEntries(
    (config.afterBoot.profiles ?? []).map((p) => [
      p.id,
      (JSON.parse(p.sandbox_json ?? "{}") as { script?: unknown }).script,
    ]),
  );
  expect(scripts).toEqual({
    "smoke-build": BUILD_SCRIPT,
    "smoke-gated": GATED_SCRIPT,
    "smoke-hang": HANG_SCRIPT,
  });
});

test("a non-fixture build runner gets no script; gated and hang stay on the fixture", async () => {
  const sdk = await smokeConfig({
    now: T0,
    repo,
    runnerId: "some-sdk",
  });
  const build = sdk.afterBoot.profiles?.find((p) => p.id === "smoke-build");
  expect(build).toMatchObject({ runner_id: "some-sdk", sandbox_json: "{}" });
  expect(sdk.afterBoot.agents?.map((a) => a.runner_id)).toEqual([
    "some-sdk",
    FIXTURE_RUNNER_ID,
    FIXTURE_RUNNER_ID,
  ]);
});

test("spawnRequest builds valid POST /sessions bodies", () => {
  const build = SpawnRequest.parse(spawnRequest("build", "some-sdk"));
  expect(build).toMatchObject({
    agent_id: "smoke-build",
    run_class: "build",
    runner_id: "some-sdk",
    workspace_id: SMOKE.workspace,
    executor_id: SMOKE.executor,
    prompt: SMOKE.prompt,
  });
  expect(SpawnRequest.parse(spawnRequest("hang", "some-sdk"))).toMatchObject({
    run_class: SMOKE.hangRunClass,
    runner_id: FIXTURE_RUNNER_ID,
  });
});
