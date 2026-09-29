// Design an earlier change §7: a worker writes only its own ticket (§11.1 "own"); the orchestrator any.
// an orchestrator with a project reaches only that project's tickets.
import { expect, test } from "vitest";
import {
  heldProject,
  outsideProject,
  writeScope,
  type McpActor,
} from "./scope.js";

const builder: McpActor = {
  kind: "session",
  id: "S1",
  role: "builder",
  agentId: "A1",
  agentName: "builder-1",
  ticketId: "T1",
  workspaceId: null,
};

test("a worker writes its own ticket, and writes that touch no ticket", () => {
  expect(writeScope(builder, "T1")).toEqual({ allowed: true });
  expect(writeScope(builder, null)).toEqual({ allowed: true });
});

test("a worker's write to another ticket, or a ticketless worker's to any, is cross_ticket_write", () => {
  const refused = { allowed: false, reason: "cross_ticket_write" };
  expect(writeScope(builder, "T2")).toEqual(refused);
  expect(writeScope({ ...builder, ticketId: null }, "T1")).toEqual(refused);
  expect(writeScope({ ...builder, role: "reviewer" }, "T2")).toEqual(refused);
});

test("the orchestrator writes any ticket", () => {
  expect(
    writeScope({ ...builder, role: "orchestrator", ticketId: null }, "T9"),
  ).toEqual({ allowed: true });
});

const orchestrator: McpActor = {
  ...builder,
  role: "orchestrator",
  ticketId: null,
  workspaceId: "P-A",
};

test("an orchestrator with a project reaches only that project's tickets, not one with none", () => {
  expect(heldProject(orchestrator)).toBe("P-A");
  expect(outsideProject(orchestrator, "P-A")).toBeNull();
  expect(outsideProject(orchestrator, "P-B")).toBe(
    "that ticket is not in project P-A, the only one this orchestrator works",
  );
  expect(outsideProject(orchestrator, null)).toBe(
    "that ticket has no project; this orchestrator works only project P-A",
  );
});

test("a fleet orchestrator and a worker with a project are held to none", () => {
  const fleet = { ...orchestrator, workspaceId: null };
  expect(heldProject(fleet)).toBeNull();
  for (const project of ["P-A", "P-B", null]) {
    expect(outsideProject(fleet, project)).toBeNull();
  }
  const worker = { ...builder, workspaceId: "P-A" };
  expect(heldProject(worker)).toBeNull();
  expect(outsideProject(worker, "P-B")).toBeNull();
});
