import { decodeTime, isValid } from "ulid";
import { expect, test } from "vitest";
import { newId } from "./id.js";

test("newId returns a valid ULID", () => {
  const id = newId();
  expect(id).toHaveLength(26);
  expect(isValid(id)).toBe(true);
});

test("newId encodes the given time, even after a later one", () => {
  newId(9_000_000);
  expect(decodeTime(newId(1_234_567))).toBe(1_234_567);
});

test("ids sort by time and are unique within one millisecond", () => {
  const early = newId(5);
  const late = newId(6);
  expect([late, early].sort()).toEqual([early, late]);
  const sameMs = Array.from({ length: 100 }, () => newId(7));
  expect(new Set(sameMs).size).toBe(sameMs.length);
});
