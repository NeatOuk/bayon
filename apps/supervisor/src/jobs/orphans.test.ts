import { expect, test } from "vitest";
import { findOrphans } from "./orphans.js";

test("finds files present but not expected", () => {
  const expected = new Set(["T-1.md", "T-2.md"]);
  expect(findOrphans(expected, ["T-1.md", "T-2.md", "OLD-5.md"])).toEqual([
    "OLD-5.md",
  ]);
});

test("a key_prefix change orphans every old-prefix file at once", () => {
  const expected = new Set(["NEW-1.md", "NEW-2.md"]);
  const present = ["OLD-1.md", "OLD-2.md"];
  expect(findOrphans(expected, present)).toEqual(present);
});

test("nothing present, nothing orphaned", () => {
  expect(findOrphans(new Set(["T-1.md"]), [])).toEqual([]);
});

test("everything expected is present: no orphans", () => {
  const expected = new Set(["T-1.md", "T-2.md"]);
  expect(findOrphans(expected, ["T-1.md", "T-2.md"])).toEqual([]);
});
