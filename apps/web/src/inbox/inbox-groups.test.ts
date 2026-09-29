import { expect, test } from "vitest";
import {
  groupByTicket,
  kindLabel,
  recommendationOf,
} from "@/inbox/inbox-groups";
import { inboxItem } from "@/test/inbox-fixtures";

const T0 = 1_800_000_000_000;
const ticket = (num: number) => ({
  id: `ticket-${num}`,
  num,
  title: `ticket ${num}`,
  status: "building",
});

test("requests group by ticket: the most recently asked group first, each newest first", () => {
  const groups = groupByTicket([
    inboxItem({ id: "a", ticket: ticket(7), asked_at: T0 + 1 }),
    inboxItem({ id: "b", ticket: ticket(9), asked_at: T0 + 5 }),
    inboxItem({ id: "c", ticket: null, asked_at: T0 + 2 }),
    inboxItem({ id: "d", ticket: ticket(7), asked_at: T0 + 3 }),
    inboxItem({ id: "e", ticket: ticket(9), asked_at: T0 + 4 }),
  ]);
  expect(
    groups.map((g) => [g.ticket?.num ?? null, g.items.map((i) => i.id)]),
  ).toEqual([
    [9, ["b", "e"]],
    [7, ["d", "a"]],
    [null, ["c"]],
  ]);
});

test("requests asked at the same moment keep the server's order", () => {
  const groups = groupByTicket([
    inboxItem({ id: "q" }),
    inboxItem({ id: "p" }),
  ]);
  expect(groups[0]?.items.map((i) => i.id)).toEqual(["q", "p"]);
});

test.each([
  ["Recommendation: Keep v1 for a week", "Keep v1 for a week"],
  ["  Recommendation:  yes \n", "yes"],
  ["The **guard** fails.", null],
  ["Recommendation:", null],
  [null, null],
])("recommendationOf(%j) is %j", (context, recommendation) => {
  expect(recommendationOf(context)).toBe(recommendation);
});

test("kinds read as words", () => {
  expect(kindLabel("decision")).toBe("Decision");
  expect(kindLabel("staff_approval")).toBe("Staffing proposal");
  expect(kindLabel("retry_storm")).toBe("Retry storm");
});
