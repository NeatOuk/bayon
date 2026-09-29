import type { TimelineSource } from "@bayon/core";
import { expect, test } from "vitest";
import {
  focusAfterClose,
  tabKey,
  tabOf,
  ticketNumOf,
  withTab,
  withoutTab,
} from "@/ide/open-tabs";
import type { EditorTab } from "@/routing";

const ticket = (num: number): EditorTab => ({ kind: "ticket", num });
const session = (id: string): EditorTab => ({ kind: "session", id });
const agent = (id: string): EditorTab => ({ kind: "agent", id });

test("a tab opens once, at the end, and closes by identity", () => {
  const one = withTab([], ticket(1));
  const two = withTab(one, session("s1"));
  expect(withTab(two, ticket(1))).toBe(two);
  expect(two.map(tabKey)).toEqual(["ticket:1", "session:s1"]);
  expect(withoutTab(two, ticket(1)).map(tabKey)).toEqual(["session:s1"]);
  expect(one.map(tabKey)).toEqual(["ticket:1"]);
});

test("closing a tab focuses its left neighbour, and the leftmost hands focus to the view", () => {
  const tabs = [ticket(1), session("s1"), agent("a1")];
  expect(focusAfterClose(tabs, agent("a1"))).toEqual(session("s1"));
  expect(focusAfterClose(tabs, session("s1"))).toEqual(ticket(1));
  expect(focusAfterClose(tabs, ticket(1))).toBeUndefined();
  expect(focusAfterClose(tabs, ticket(9))).toBeUndefined();
});

test.each([
  ["FRM-812", 812],
  ["KITE-7", 7],
  ["A1B2-30", 30],
  ["FRM-0", null],
  ["FRM-", null],
  ["812", null],
])("ticketNumOf(%j)", (key, num) => {
  expect(ticketNumOf(key)).toBe(num);
});

test("a history row opens its session when it is a session row, its pulse when a pulse row, else its ticket, else its session", () => {
  const row = (
    source: TimelineSource,
    ticket_key: string | null,
    session_id: string | null,
  ) => ({ source, key: "K1", ticket_key, session_id });
  expect(tabOf(row("session", "FRM-3", "s1"))).toEqual(session("s1"));
  expect(tabOf(row("ticket", "FRM-3", "s1"))).toEqual(ticket(3));
  expect(tabOf(row("audit", null, "s1"))).toEqual(session("s1"));
  expect(tabOf(row("session", "FRM-3", null))).toEqual(ticket(3));
  expect(tabOf(row("pulse", null, "s1"))).toEqual({ kind: "pulse", id: "K1" });
  expect(tabOf(row("audit", null, null))).toBe(null);
});
