import { expect, test } from "vitest";
import {
  FLEET_ITEMS,
  PROJECT_GROUPS,
  currentFleetItem,
  currentProjectsItem,
  routeLabel,
} from "@/app-shell/nav-model";
import { IDE_VIEWS, parseRoute } from "@/routing";

// The sidebar's model: every project view listed once; which fleet item a route marks.

test("a project's groups list every IDE view exactly once", () => {
  const listed = PROJECT_GROUPS.flatMap((group) => group.items);
  expect([...listed].sort()).toEqual([...IDE_VIEWS].sort());
  expect(new Set(listed).size).toBe(listed.length);
});

test("every fleet item's address parses as the route that marks it", () => {
  for (const item of FLEET_ITEMS)
    expect(currentFleetItem(parseRoute(item.href)), item.href).toBe(item.key);
});

test.each([
  ["#/", "fleet"],
  ["#/tickets/812", "tickets"],
  ["#/pulses/P-1", "pulses"],
  ["#/settings/general", "settings"],
  ["#/settings/roles", "settings"],
  ["#/settings/notifications", "settings"],
  ["#/inbox?ticket=4", "inbox"],
  ["#/sessions/s1", null],
  ["#/missions/qa", null],
  ["#/projects", null],
  ["#/p/ws-bayon/tickets", null],
  ["#/nowhere", null],
])("%j marks %j", (hash, key) => {
  expect(currentFleetItem(parseRoute(hash))).toBe(key);
});

test("the Projects screens mark the Projects group's own entries", () => {
  expect(currentProjectsItem(parseRoute("#/projects"))).toBe("projects");
  expect(currentProjectsItem(parseRoute("#/projects/new"))).toBe("newProject");
  expect(currentProjectsItem(parseRoute("#/"))).toBeNull();
});

test.each([
  ["", "Fleet"],
  ["#/", "Fleet"],
  ["#/tickets", "Tickets"],
  ["#/tickets/45", "Ticket 45"],
  ["#/reviews", "Reviews"],
  ["#/settings/roles", "Settings"],
  ["#/p/ws-bayon/history", "History"],
  ["#/p/ws-bayon/agents?open=agent:b", "Agents"],
  ["#/p/ws-bayon/settings", "Project settings"],
  ["#/sessions/s1", "Session"],
  ["#/missions/qa", "Mission · qa"],
  ["#/projects/new", "New project"],
])("a back link to %j reads %j", (hash, label) => {
  expect(routeLabel(parseRoute(hash))).toBe(label);
});
