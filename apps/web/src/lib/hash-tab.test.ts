import { expect, test } from "vitest";
import { tabOf, withTab } from "@/lib/hash-tab";

test.each([
  ["#/sessions/s1", null],
  ["#/sessions/s1?tab=diff", "diff"],
  ["#/p/shop/overview?open=session:s1&tab=watch", "watch"],
  ["#/x?tab=", null],
  ["#/x?tab=%E0%A4%A", null],
  ["#/x?tabs=diff", null],
])("tabOf(%j) is %j", (hash, tab) => {
  expect(tabOf(hash)).toBe(tab);
});

test("withTab sets, replaces and clears the tab, keeping every other pair", () => {
  expect(withTab("#/sessions/s1", "diff")).toBe("#/sessions/s1?tab=diff");
  expect(withTab("#/sessions/s1?tab=diff", "watch")).toBe(
    "#/sessions/s1?tab=watch",
  );
  expect(withTab("#/p/shop/overview?open=session:s1", "watch")).toBe(
    "#/p/shop/overview?open=session:s1&tab=watch",
  );
  expect(withTab("#/p/shop/overview?tab=diff&open=session:s1", null)).toBe(
    "#/p/shop/overview?open=session:s1",
  );
  expect(withTab("#/sessions/s1?tab=diff", null)).toBe("#/sessions/s1");
  expect(withTab("#/x", "a b")).toBe("#/x?tab=a%20b");
  // An empty hash is the Fleet's: the query stays inside the hash.
  expect(withTab("", "a")).toBe("#/?tab=a");
  expect(withTab("", null)).toBe("");
});
