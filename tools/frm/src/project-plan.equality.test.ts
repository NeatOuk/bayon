import { projectIds, type ProjectPlanInput } from "@bayon/core";
import { toNewProject } from "@bayon/api/src/projects/project-plan.js";
import { join } from "node:path";
import { expect, test } from "vitest";
import { idsOf, toConfigRows, type ProjectAddCommand } from "./project-add.js";

// `frm project add` and `POST /projects` must write identical rows for the same
// input: the whole point of lifting `projectPlan`/`withProfileDefaults` into shared packages,
// asserted directly rather than trusted.

// `frm project add`'s `home` (mirror_path = <home>/mirrors/<id>.git) vs. the route's own
// `mirrorsRoot` (already `<home>/mirrors`, from `loadMirrorsRoot`): the same $FRM_HOME, in each
// side's own shape.
const HOME = "/home/frm";
const MIRRORS_ROOT = join(HOME, "mirrors");
const NOW = 1_700_000_000_000;

function fixture(o: {
  readonly orchestrator: boolean;
  readonly reviewerRunner: string | null;
}): { readonly cmd: ProjectAddCommand; readonly input: ProjectPlanInput } {
  const shared = {
    name: "eq-demo",
    runner: "fixture",
    executor: "ctr-1",
    base: "trunk",
    orchestrator: o.orchestrator,
    reviewerRunner: o.reviewerRunner,
  };
  return {
    cmd: { ...shared, repo: "git@github.com:acme/app.git", dryRun: false },
    input: { ...shared, repoUrl: "git@github.com:acme/app.git" },
  };
}

async function assertEqualRows(o: {
  readonly orchestrator: boolean;
  readonly reviewerRunner: string | null;
}): Promise<void> {
  const { cmd, input } = fixture(o);
  const ids = idsOf(cmd);
  expect(ids).toEqual(projectIds(input));

  const cliRows = await toConfigRows(cmd, ids, HOME, NOW);
  const planned = await toNewProject(input, ids, MIRRORS_ROOT, NOW);
  // A plan with no documentation source is never refused; unwrapped here so the row
  // comparison below stays exactly what it was.
  if (!planned.ok) throw new Error(planned.error.message);
  const apiProject = planned.value;

  expect(cliRows.repos?.[0]).toEqual(apiProject.repo);
  expect(cliRows.workspaces?.[0]).toEqual(apiProject.workspace);
  expect(cliRows.workspace_repos?.[0]).toEqual(apiProject.workspaceRepo);
  expect(cliRows.profiles).toEqual(apiProject.profiles);
  expect(cliRows.agents).toEqual(apiProject.agents);
}

test("the default shape (orchestrator + reviewer on the same runner)", async () => {
  await assertEqualRows({ orchestrator: true, reviewerRunner: "fixture" });
});

test("a distinct reviewer runner", async () => {
  await assertEqualRows({ orchestrator: true, reviewerRunner: "critic" });
});

test("no orchestrator", async () => {
  await assertEqualRows({ orchestrator: false, reviewerRunner: "fixture" });
});

test("no reviewer", async () => {
  await assertEqualRows({ orchestrator: true, reviewerRunner: null });
});

test("neither orchestrator nor reviewer: just the builder", async () => {
  await assertEqualRows({ orchestrator: false, reviewerRunner: null });
});
