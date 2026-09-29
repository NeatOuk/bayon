import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SMOKE } from "./config.js";
import { EXPORTER, exporterRows } from "./export-config.js";
import { repoRoot } from "./stack.js";

test("the exporter's ids are the supervisor's own", () => {
  const root = repoRoot();
  if (!root.ok) throw new Error(root.error.message);
  const source = readFileSync(
    join(root.value, "apps/supervisor/src/jobs/export-agent.ts"),
    "utf8",
  );
  expect(source).toContain(`EXPORTER_RUNNER_ID = "${EXPORTER.runnerId}"`);
  expect(source).toContain(`EXPORTER_AGENT_ID = "${EXPORTER.agentId}"`);
  expect(source).toContain(`EXPORTER_RUN_CLASS = "${EXPORTER.runClass}"`);
});

test("the exporter's rows: no workspace, a zero-budget run class, the DB in its env", async () => {
  const rows = await exporterRows({ now: 1, home: "/tmp/h" });
  expect(rows.agents).toMatchObject([
    {
      id: EXPORTER.agentId,
      kind: "util",
      runner_id: EXPORTER.runnerId,
      executor_id: SMOKE.executor,
      profile_id: EXPORTER.agentId,
      workspace_id: null,
    },
  ]);
  expect(JSON.parse(rows.profiles?.[0]?.env_json ?? "{}")).toEqual({
    FRM_HOME: "/tmp/h",
    FRM_DB: "/tmp/h/foreman.db",
  });
  expect(rows.profiles?.[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(rows.run_classes).toMatchObject([
    {
      name: EXPORTER.runClass,
      max_turns: 0,
      cost_cap_usd: 0,
      default_tier: "cheap",
    },
  ]);
});
