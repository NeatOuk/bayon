import { describe, expect, test } from "vitest";
import { changedFiles, parseNumstat, parsePorcelain } from "./facts.js";

// The git parsers of a hand-off's facts: -z output, renames, binaries.
describe("parsePorcelain", () => {
  test("reads codes and paths, skipping a rename's original path", () => {
    const out =
      " M README.md\0?? new file.txt\0R  moved.ts\0old.ts\0A  added.ts\0";
    expect([...parsePorcelain(out)]).toEqual([
      ["README.md", "M"],
      ["new file.txt", "??"],
      ["moved.ts", "R"],
      ["added.ts", "A"],
    ]);
  });

  test("an empty status is no files", () => {
    expect(parsePorcelain("").size).toBe(0);
  });
});

describe("parseNumstat", () => {
  test("reads counts, a rename's new path, and no counts for a binary", () => {
    const out =
      "3\t1\tREADME.md\0" + "0\t0\t\0old.ts\0moved.ts\0" + "-\t-\tlogo.png\0";
    expect([...parseNumstat(out)]).toEqual([
      ["README.md", { added: 3, removed: 1 }],
      ["moved.ts", { added: 0, removed: 0 }],
      ["logo.png", {}],
    ]);
  });
});

test("changedFiles unions status and diff: a clean path changed since base is committed", () => {
  const files = changedFiles(
    " M README.md\0?? new.txt\0",
    "1\t0\tREADME.md\0" + "5\t0\tdone.ts\0",
  );
  expect(files).toEqual([
    { path: "README.md", code: "M", added: 1, removed: 0 },
    { path: "done.ts", code: "committed", added: 5, removed: 0 },
    { path: "new.txt", code: "??" },
  ]);
});
