import { SESSION_DIFF_CAP } from "@bayon/proto";
import { describe, expect, test } from "vitest";
import { capPatch, diffFiles } from "./diff-text.js";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " keep",
  "-old",
  "+new",
  "+++ an added line that starts with ++",
  "--- a deleted line that starts with --",
  "\\ No newline at end of file",
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1 @@",
  "+hello",
  "diff --git a/img.png b/img.png",
  "index 1..2 100644",
  "Binary files a/img.png and b/img.png differ",
  'diff --git "a/with space\\tand tab.txt" "b/with space\\tand tab.txt"',
  "deleted file mode 100644",
  '--- "a/with space\\tand tab.txt"',
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/old/name.ts b/new/name.ts",
  "similarity index 100%",
  "rename from old/name.ts",
  "rename to new/name.ts",
  "",
].join("\n");

describe("diffFiles", () => {
  test("reads each file off its header, counting hunk lines only; binary files have no counts", () => {
    expect(diffFiles(PATCH)).toEqual([
      { path: "src/a.ts", added: 2, deleted: 2 },
      { path: "new.txt", added: 1, deleted: 0 },
      { path: "img.png", added: null, deleted: null },
      { path: "with space\\tand tab.txt", added: 0, deleted: 1 },
      { path: "new/name.ts", added: 0, deleted: 0 },
    ]);
  });

  test("no header, no file", () => {
    expect(diffFiles("")).toEqual([]);
    expect(diffFiles("not a diff\n+x\n-y")).toEqual([]);
  });
});

const lines = (n: number, width = 7) =>
  Array.from({ length: n }, (_, i) => `${i}`.padStart(width, "x")).join("\n") +
  "\n";

describe("capPatch", () => {
  test("a patch within the cap comes back whole; a trailing newline starts no line", () => {
    expect(capPatch("a\nb\n")).toEqual({
      text: "a\nb\n",
      truncated: false,
      bytes: 4,
      lines: 2,
    });
    expect(capPatch("")).toEqual({
      text: "",
      truncated: false,
      bytes: 0,
      lines: 0,
    });
  });

  test("over the line cap: the first cap.lines lines, and the whole patch's size", () => {
    const text = lines(250);
    const capped = capPatch(text);
    expect(capped.truncated).toBe(true);
    expect(capped.lines).toBe(250);
    expect(capped.bytes).toBe(Buffer.byteLength(text));
    expect(capped.text.split("\n")).toHaveLength(SESSION_DIFF_CAP.lines);
    expect(text.startsWith(capped.text)).toBe(true);
  });

  test("over the byte cap: cut on a line boundary within cap.bytes", () => {
    const text = lines(100, 99);
    const capped = capPatch(text);
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.text)).toBeLessThanOrEqual(
      SESSION_DIFF_CAP.bytes,
    );
    expect(capped.text.split("\n").every((line) => line.length === 99)).toBe(
      true,
    );
    expect(text.startsWith(capped.text)).toBe(true);
  });

  test("one line over the byte cap is cut mid-line, never mid-character", () => {
    const capped = capPatch("é".repeat(5_000), { bytes: 101, lines: 200 });
    expect(capped).toEqual({
      text: "é".repeat(50),
      truncated: true,
      bytes: 10_000,
      lines: 1,
    });
  });
});
