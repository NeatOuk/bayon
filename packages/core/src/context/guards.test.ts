import { describe, expect, test } from "vitest";
import { isUnifiedDiff, mentionsContextStore } from "./guards.js";

describe("isUnifiedDiff: a diff header or a hunk header starts some line", () => {
  test.each([
    [
      "diff --git a/x.ts b/x.ts\nindex 1..2\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b",
      true,
    ],
    ["commit abc\nAuthor: x\n\ndiff --git a/y b/y\n", true], // git log -p
    ["--- a.txt\n+++ b.txt\n@@ -1,3 +1,4 @@\n x\n", true], // diff -u
    ["diff --cc file.ts\n@@@ -1,2 -1,2 +1,3 @@@\n", true], // a merge's combined diff
    ["@@@ -1,2 -1,2 +1,3 @@@", true],
    ["plain log\n@@ not a hunk\n", false],
    ["  diff --git indented is not a header", false],
    ["a line mentioning diff --git later", false],
    ["", false],
  ])("%j → %s", (text, want) => expect(isUnifiedDiff(text)).toBe(want));
});

describe("mentionsContextStore", () => {
  test.each([
    ["cat .foreman/ctx/ab12.txt", true],
    ['{"command":"sed -n 1,50p .foreman/ctx/ab12.txt"}', true],
    ['{"path":"\\/w\\/.foreman\\/ctx\\/ab.txt"}', true], // JSON-escaped slashes
    ["grep -n Error /w/.foreman//ctx/ab.txt", true],
    ["ls .foreman/ctx", true],
    ['{"pattern":"x","path":".foreman/ctx"}', true],
    ["ls .foreman/ctx2", false],
    ["cat .foreman/ctx.bak", false],
    ["cat .foreman/handoff-1.md", false],
    ["cat src/ctx/a.ts", false],
    ["", false],
  ])("%j → %s", (input, want) =>
    expect(mentionsContextStore(input)).toBe(want),
  );
});
