import { expect, test } from "vitest";
import { workspaceLayout } from "../workspace/layout.js";
import { projectIds } from "./plan.js";
import { projectSubmodulePlan, submoduleRepoId } from "./submodule-plan.js";

const ids = projectIds({
  name: "kite",
  repoUrl: "/src/kite",
  runner: "fixture",
  executor: "local",
  orchestrator: false,
  reviewerRunner: null,
});

test("a submodule's repo id is the project's, then its path as a slug", () => {
  expect(submoduleRepoId("kite", "KITE-Web")).toBe("kite-kite-web");
  expect(submoduleRepoId("kite", "apps/My_App.v2")).toBe("kite-apps-my-app-v2");
});

test("the rows are a submodule workspace workspaceLayout accepts", () => {
  const deps = projectSubmodulePlan(ids, "kite", [
    { path: "KITE-Web", origin: "/src/kite/KITE-Web", base: "master" },
    { path: "apps/api", origin: "/src/kite/apps/api", base: "develop" },
  ]);
  expect(deps[0]?.repo).toEqual({
    id: "kite-kite-web",
    name: "kite-kite-web",
    origin_url: "/src/kite/KITE-Web",
    default_base_branch: "master",
  });
  expect(deps[1]?.repo.default_base_branch).toBe("develop");
  const rows = [
    {
      id: "kite",
      rel_path: "kite",
      role: "primary",
      submodule_path: null,
      has_submodules: 1,
    },
    ...deps.map((d) => ({
      id: d.repo.id,
      rel_path: d.workspaceRepo.rel_path,
      role: d.workspaceRepo.role,
      submodule_path: d.workspaceRepo.submodule_path,
      has_submodules: 0,
    })),
  ];
  const layout = workspaceLayout("submodule", rows);
  expect(layout.ok).toBe(true);
  if (!layout.ok) return;
  expect(layout.value.submodules.map((r) => r.rel_path)).toEqual([
    "kite/KITE-Web",
    "kite/apps/api",
  ]);
});
