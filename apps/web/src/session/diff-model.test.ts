import { expect, test } from "vitest";
import { patchLines, shortSha } from "@/session/diff-model";

test("header lines are meta until a hunk; inside one, +/- are adds and deletes, even +++ and ---", () => {
  const patch = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "+++ added, not a header",
    "\\ No newline at end of file",
    "diff --git a/b.ts b/b.ts",
    "+++ b/b.ts",
    "",
  ].join("\n");
  expect(patchLines(patch).map((line) => line.tone)).toEqual([
    "meta",
    "meta",
    "meta",
    "hunk",
    "context",
    "del",
    "add",
    "add",
    "meta",
    "meta",
    "meta",
  ]);
  expect(patchLines("")).toEqual([]);
});

test("a sha shows as its first seven characters, an unknown one as ?", () => {
  expect(shortSha("0123456789abcdef")).toBe("0123456");
  expect(shortSha(null)).toBe("?");
});
