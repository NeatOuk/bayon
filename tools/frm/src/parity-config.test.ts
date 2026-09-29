import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { m3Rows } from "./smoke/m3-config.js";
import { PARITY, parityRows } from "./parity-config.js";
import { repoRoot } from "./smoke/stack.js";

test("the parity checker's ids are the supervisor's own", () => {
  const root = repoRoot();
  if (!root.ok) throw new Error(root.error.message);
  const source = readFileSync(
    join(root.value, "apps/supervisor/src/jobs/parity-agent.ts"),
    "utf8",
  );
  expect(source).toContain(`PARITY_RUNNER_ID = "${PARITY.runnerId}"`);
  expect(source).toContain(`PARITY_AGENT_ID = "${PARITY.agentId}"`);
  expect(source).toContain(`PARITY_RUN_CLASS = "${PARITY.runClass}"`);
});

test("the parity checker's rows: a util agent on local, no workspace, no tools, no budget", async () => {
  const rows = await parityRows({ now: 1, home: "/tmp/h" });
  expect(rows.agents).toMatchObject([
    {
      id: PARITY.agentId,
      // A job, not a review: chooseParityJob reads kind='util' (listUtilAgents).
      kind: "util",
      runner_id: PARITY.runnerId,
      executor_id: PARITY.executor,
      profile_id: PARITY.agentId,
      workspace_id: null,
    },
  ]);
  expect(JSON.parse(rows.profiles?.[0]?.env_json ?? "{}")).toEqual({
    FRM_HOME: "/tmp/h",
    FRM_DB: "/tmp/h/foreman.db",
  });
  expect(rows.profiles?.[0]?.tool_allowlist_json).toBe("[]");
  expect(rows.profiles?.[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(rows.run_classes).toMatchObject([
    {
      name: PARITY.runClass,
      max_turns: 0,
      cost_cap_usd: 0,
      default_tier: "cheap",
    },
  ]);
  // The runner row is the supervisor's, from its own adapter at boot -- never an operator row.
  expect(rows).not.toHaveProperty("runners");
});

// These rows were written and tested and then never seeded by anything: `parityRows`
// had no caller but its own test, so no `kind='util'` agent of the parity runner ever existed and
// `chooseParityJob` answered `no_reviewer` every time the gate ran. The exporter's analogue
// (`exporterRows`) is seeded by the M1 smoke; this one rides with the gate engine's own fleet.
test("the M3 smoke seeds them: the gate's pick has a util agent to find", async () => {
  const rows = await m3Rows({
    now: 1,
    tickets: { main: "t1", hang: "t2", same: "t3" },
    schemaRunner: "stub",
    home: "/tmp/h",
  });
  expect(rows.agents?.map((a) => a.id)).toContain(PARITY.agentId);
  expect(rows.agents?.find((a) => a.id === PARITY.agentId)).toMatchObject({
    kind: "util",
    runner_id: PARITY.runnerId,
  });
  // Its profile and run class ride with it: an agent naming neither seeds nothing usable.
  expect(rows.profiles?.map((p) => p.id)).toContain(PARITY.agentId);
  expect(rows.run_classes?.map((c) => c.name)).toContain(PARITY.runClass);
});
