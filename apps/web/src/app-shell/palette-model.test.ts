import { expect, test } from "vitest";
import {
  RECENT_LIMIT,
  paletteGroups,
  parseRecent,
  ticketNumOf,
  withRecent,
  type PaletteItem,
  type PaletteSources,
} from "@/app-shell/palette-model";
import { projectView } from "@/test/project-fixtures";

// The palette's pure half: what a query offers, a ticket by reference, and Recent read
// back from storage that may hold anything.

const BAYON = projectView();
const KITE = projectView({
  id: "kite",
  name: "kite",
  paused: true,
  agents: [],
});

const sources = (over: Partial<PaletteSources> = {}): PaletteSources => ({
  projects: [BAYON, KITE],
  current: null,
  ticketHref: (num) => `#/tickets/${num}`,
  recent: [],
  ...over,
});

const shape = (query: string, over?: Partial<PaletteSources>) =>
  paletteGroups(query, sources(over)).map((group) => [
    group.value,
    group.items.map((item) => item.label),
  ]);

test.each([
  ["#45", 45],
  ["45", 45],
  ["FRM-45", 45],
  ["frm-45", 45],
  ["  #812 ", 812],
  ["BANK2-7", 7],
  ["#0", null],
  ["08", null],
  ["abc", null],
  ["#", null],
  ["FRM-", null],
  ["-45", null],
  ["FRM--45", null],
  ["45 x", null],
])("ticketNumOf(%j) is %j", (query, num) => {
  expect(ticketNumOf(query)).toBe(num);
});

test("with no query: the screens, the projects and their agents; Recent only when it holds picks", () => {
  expect(shape("")).toEqual([
    [
      "Screens",
      [
        "Fleet",
        "Tickets",
        "Reviews",
        "Inbox",
        "Pulses",
        "Spend",
        "Runners",
        "Executors",
        "Settings",
        "Audit",
        "Settings · Notifications",
        "Settings · Roles",
        "Projects",
        "New project",
      ],
    ],
    ["Projects", ["bayon", "kite"]],
    ["Agents", ["bayon-builder", "bayon-reviewer"]],
  ]);
  const audit: PaletteItem = { id: "a", label: "Audit", href: "#/audit" };
  expect(shape("", { recent: [audit] })[0]).toEqual(["Recent", ["Audit"]]);
  expect(shape("aud", { recent: [audit] })[0]).toEqual(["Screens", ["Audit"]]);
});

test("every word must match the label, the hint or the group; empty groups go", () => {
  expect(shape("pul")).toEqual([["Screens", ["Pulses"]]]);
  expect(shape("bayon build")).toEqual([["Agents", ["bayon-builder"]]]);
  expect(shape("disabled")).toEqual([["Agents", ["bayon-reviewer"]]]);
  expect(shape("paused")).toEqual([["Projects", ["kite"]]]);
  expect(shape("AGENTS")).toEqual([
    ["Agents", ["bayon-builder", "bayon-reviewer"]],
  ]);
  expect(shape("zzz")).toEqual([]);
});

test("inside a project its views are a group of their own, named for it", () => {
  const groups = paletteGroups("", sources({ current: BAYON }));
  const views = groups.find((group) => group.value === "bayon");
  expect(views?.items.map((item) => [item.label, item.href])).toEqual([
    ["Overview", "#/p/ws-bayon/overview"],
    ["Tickets", "#/p/ws-bayon/tickets"],
    ["Reviews", "#/p/ws-bayon/reviews"],
    ["Inbox", "#/p/ws-bayon/inbox"],
    ["Orchestrator", "#/p/ws-bayon/orchestrator"],
    ["Agents", "#/p/ws-bayon/agents"],
    ["Spend", "#/p/ws-bayon/spend"],
    ["History", "#/p/ws-bayon/history"],
    ["Project settings", "#/p/ws-bayon/settings"],
  ]);
  const agent = groups
    .find((group) => group.value === "Agents")
    ?.items.find((item) => item.label === "bayon-builder");
  expect(agent?.href).toBe("#/p/ws-bayon/agents?open=agent:bayon-builder");
});

test("a ticket reference comes first, going where this scope opens tickets", () => {
  const groups = paletteGroups(
    "FRM-12",
    sources({
      ticketHref: (num) => `#/p/ws-bayon/overview?open=ticket:${num}`,
    }),
  );
  expect(groups[0]).toEqual({
    value: "Ticket",
    items: [
      {
        id: "ticket:12",
        label: "Open ticket 12",
        href: "#/p/ws-bayon/overview?open=ticket:12",
      },
    ],
  });
});

test("Recent reads back only a list of items with hash addresses; anything else is none", () => {
  const good = [{ id: "a", label: "Audit", href: "#/audit", hint: "Screens" }];
  expect(parseRecent(JSON.stringify(good))).toEqual(good);
  for (const bad of [
    null,
    "",
    "not json",
    "{}",
    JSON.stringify([{ id: "a", label: "x", href: "javascript:alert(1)" }]),
    JSON.stringify([{ id: "a", href: "#/" }]),
  ])
    expect(parseRecent(bad), String(bad)).toEqual([]);
});

test("a pick goes first, once, remembers its group, and Recent stays short", () => {
  const item = (n: number): PaletteItem => ({
    id: `i${n}`,
    label: `Item ${n}`,
    href: `#/p/${n}`,
  });
  let recent: readonly PaletteItem[] = [];
  for (let n = 0; n < RECENT_LIMIT + 2; n++)
    recent = withRecent(recent, item(n), "Screens");
  expect(recent.map((r) => r.id)).toEqual(["i6", "i5", "i4", "i3", "i2"]);
  recent = withRecent(recent, { ...item(3), hint: "bayon" }, "Agents");
  expect(recent.map((r) => r.id)).toEqual(["i3", "i6", "i5", "i4", "i2"]);
  expect(recent[0]?.hint).toBe("bayon");
  expect(recent[1]?.hint).toBe("Screens");
  expect(withRecent(recent, recent[2] as PaletteItem, "Recent")[0]).toEqual(
    recent[2],
  );
});
