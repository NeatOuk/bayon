import { expect, test } from "vitest";
import { fleet, fleetRow } from "@/test/fixtures";
import { projectSessions, sessionsByAgent } from "@/ide/project-fleet";

// One project's live sessions out of the fleet-wide snapshot, grouped by agent name.

const rows = [
  fleetRow({ id: "s1", agent: "shop-builder", workspace_id: "shop" }),
  fleetRow({ id: "s2", agent: "blog-builder", workspace_id: "blog" }),
  fleetRow({ id: "s3", agent: "shop-builder", workspace_id: "shop" }),
  fleetRow({ id: "s4", agent: "fleet-orchestrator", workspace_id: null }),
];

test("a project keeps its own rows, in the fleet's order; no fleet yet is none", () => {
  expect(projectSessions(fleet(rows), "shop").map((r) => r.id)).toEqual([
    "s1",
    "s3",
  ]);
  expect(projectSessions(fleet(rows), "nowhere")).toEqual([]);
  expect(projectSessions(undefined, "shop")).toEqual([]);
});

test("rows group by agent name, each agent's in order", () => {
  const byAgent = sessionsByAgent(rows);
  expect([...byAgent.keys()]).toEqual([
    "shop-builder",
    "blog-builder",
    "fleet-orchestrator",
  ]);
  expect(byAgent.get("shop-builder")?.map((r) => r.id)).toEqual(["s1", "s3"]);
});
