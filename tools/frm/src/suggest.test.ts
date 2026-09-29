import { expect, test } from "vitest";
import { closest, editDistance } from "./suggest.js";

test("edit distance counts insertions, deletions and substitutions", () => {
  expect(editDistance("settings", "settings")).toBe(0);
  expect(editDistance("setings", "settings")).toBe(1);
  expect(editDistance("stings", "settings")).toBe(2);
  expect(editDistance("", "abc")).toBe(3);
  expect(editDistance("kitten", "sitting")).toBe(3);
});

test("closest: a typo, a prefix, or nothing when too far", () => {
  const words = ["settings", "smoke", "roots", "restore", "resume"];
  expect(closest("setings", words)).toBe("settings");
  expect(closest("root", words)).toBe("roots");
  expect(closest("smok", words)).toBe("smoke");
  expect(closest("deploy", words)).toBeNull();
  expect(closest("x", words)).toBeNull();
  expect(closest("yez", ["yes"])).toBe("yes");
});

test("two neighbours swapped are one edit", () => {
  expect(editDistance("yse", "yes")).toBe(1);
  expect(editDistance("rots", "roots")).toBe(1);
  expect(editDistance("stetings", "settings")).toBe(1);
  expect(editDistance("ab", "ba")).toBe(1);
});

test("closest: a transposition, and two edits from 4 characters on", () => {
  expect(closest("yse", ["yes"])).toBe("yes");
  expect(closest("rots", ["roots", "smoke", "restore"])).toBe("roots");
  // Two edits: "stetngs" drops an i and swaps e and t.
  expect(closest("stetngs", ["settings", "smoke"])).toBe("settings");
  // Under 4 characters, one edit only.
  expect(closest("xyz", ["yes"])).toBeNull();
});
