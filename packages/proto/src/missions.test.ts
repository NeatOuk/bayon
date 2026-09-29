import { expect, test } from "vitest";
import {
  MissionDiff,
  MissionSaveRequest,
  MissionVersion,
  MissionVersionNumber,
  MissionView,
} from "./missions.js";
import { WireError } from "./rest.js";

const TEXT = {
  who_md: "who",
  what_md: "what",
  how_md: "how",
  laws_md: "laws",
};
const V1 = {
  id: "01J0MISSION0000000000000001",
  agent_name: "builder-1",
  version: 1,
  ...TEXT,
  rendered_md: "# Mission: builder-1\n",
  hash: "a".repeat(64),
  note: "first",
  created_at: 1_700_000_000_000,
  created_by: "operator",
};

test("a save needs every section, a changelog note and a base version", () => {
  const ok = { ...TEXT, note: "  tighten the laws ", base_version: 0 };
  expect(MissionSaveRequest.parse(ok).note).toBe("tighten the laws");
  for (const bad of [
    { ...ok, note: undefined },
    { ...ok, note: "" },
    { ...ok, note: " \n\t" },
    { ...ok, base_version: -1 },
    { ...ok, base_version: 1.5 },
    { ...ok, base_version: "1" },
    { ...ok, laws_md: undefined },
  ]) {
    expect(MissionSaveRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(
      false,
    );
  }
});

test("a mission view carries the latest version (or null) and the version list", () => {
  const { id, version, hash, note, created_at, created_by } = V1;
  const summary = { id, version, hash, note, created_at, created_by };
  expect(
    MissionView.parse({ agent: "builder-1", latest: V1, versions: [summary] }),
  ).toEqual({ agent: "builder-1", latest: V1, versions: [summary] });
  expect(
    MissionView.parse({ agent: "builder-1", latest: null, versions: [] })
      .latest,
  ).toBeNull();
  expect(MissionVersion.parse({ ...V1, note: null }).note).toBeNull();
  expect(MissionVersion.safeParse({ ...V1, version: 0 }).success).toBe(false);
});

test("a diff lists every section with its line changes", () => {
  const diff = {
    agent: "builder-1",
    from: 1,
    to: 2,
    sections: [
      {
        section: "laws",
        changed: true,
        changes: [
          { op: "remove", text: "a\n" },
          { op: "add", text: "b\n" },
          { op: "same", text: "c\n" },
        ],
      },
    ],
  };
  expect(MissionDiff.parse(diff)).toEqual(diff);
  expect(
    MissionDiff.safeParse({
      ...diff,
      sections: [{ section: "rules", changed: false, changes: [] }],
    }).success,
  ).toBe(false);
});

test("version path params coerce to positive integers", () => {
  expect(MissionVersionNumber.parse("3")).toBe(3);
  for (const bad of ["0", "-1", "1.5", "abc", ""]) {
    expect(MissionVersionNumber.safeParse(bad).success, bad).toBe(false);
  }
});

test("a wire error may name the current version of a stale write (409)", () => {
  const conflict = {
    class: "conflict",
    message: "stale",
    retryable: false,
    current_version: 2,
  };
  expect(WireError.parse(conflict)).toEqual(conflict);
  expect(
    WireError.parse({ class: "conflict", message: "x", retryable: false }),
  ).not.toHaveProperty("current_version");
});
