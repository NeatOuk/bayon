import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { LINT, lintRows } from "./lint-config.js";
import { repoRoot } from "./smoke/stack.js";

// A real directory, as every neighbouring test uses: these rows carry a FRM_HOME into a profile's
// env and hash it, so a shared literal would make two runs of two suites agree by accident.
const home = mkdtempSync(join(tmpdir(), "frm-lint-config-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

// frm cannot import an app, so the lint checker's ids are restated here; this is what keeps the two
// copies the same. Four things have to agree on them: the supervisor's adapter, the gate engine's
// pick, these rows and the operator's database.
test("the lint checker's ids are the supervisor's own", () => {
  const root = repoRoot();
  if (!root.ok) throw new Error(root.error.message);
  const source = readFileSync(
    join(root.value, "apps/supervisor/src/jobs/lint-agent.ts"),
    "utf8",
  );
  expect(source).toContain(`LINT_RUNNER_ID = "${LINT.runnerId}"`);
  expect(source).toContain(`LINT_AGENT_ID = "${LINT.agentId}"`);
  expect(source).toContain(`LINT_RUN_CLASS = "${LINT.runClass}"`);
});

test("the lint checker's rows: a util agent on local, no workspace, no tools, no budget", async () => {
  const rows = await lintRows({ now: 1, home });
  expect(rows.agents).toMatchObject([
    {
      id: LINT.agentId,
      // A job, not a review: chooseLintJob reads kind='util' (listUtilAgents).
      kind: "util",
      runner_id: LINT.runnerId,
      executor_id: LINT.executor,
      profile_id: LINT.agentId,
      // The gate hands it a detached worktree at the pinned head; it owns no workspace of its own.
      workspace_id: null,
    },
  ]);
  expect(JSON.parse(rows.profiles?.[0]?.env_json ?? "{}")).toEqual({
    FRM_HOME: home,
    FRM_DB: join(home, "foreman.db"),
  });
  expect(rows.profiles?.[0]?.tool_allowlist_json).toBe("[]");
  expect(rows.profiles?.[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  // The wall clock is the gate's own 15 minutes, not parity's two: this job runs the repo's install
  // on a worktree with no node_modules, and a shorter run class would call a slow install a timeout.
  expect(rows.run_classes).toMatchObject([
    {
      name: LINT.runClass,
      max_turns: 0,
      cost_cap_usd: 0,
      wall_clock_ms: 900_000,
      default_tier: "cheap",
    },
  ]);
  // The runner row is the supervisor's, from its own adapter at boot -- never an operator row.
  expect(rows).not.toHaveProperty("runners");
});

// §4, and the reason this ticket needed no new config surface: the command itself is the operator's
// `repos.lint_cmd`, never a default shipped here. A default would be this repository's own command
// hardcoded into a control plane for arbitrary repositories.
test("no command is seeded: the gate runs the operator's repos.lint_cmd or nothing", async () => {
  const rows = await lintRows({ now: 1, home });
  expect(rows).not.toHaveProperty("repos");
  expect(JSON.stringify(rows)).not.toContain("lint_cmd");
});
