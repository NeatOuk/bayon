import { expect, test } from "vitest";
import { exportedFileProblems, frontmatterStatus } from "./export-checks.js";

const MD =
  "---\nkey: FRM-1\nstatus: backlog\ntype: feature\n---\n\n# A\n\nbody\n";

test("frontmatterStatus reads status from the frontmatter, and only there", () => {
  expect(frontmatterStatus(MD)).toBe("backlog");
  expect(frontmatterStatus("---\nstatus: 'in_progress'\n---\n")).toBe(
    "in_progress",
  );
  expect(frontmatterStatus("# no frontmatter\nstatus: done\n")).toBeUndefined();
  expect(frontmatterStatus("---\nkey: x\n---\nstatus: done\n")).toBeUndefined();
});

test("exportedFileProblems: at tickets/<KEY>.md, synced, status as the DB's, hash as the file's", () => {
  const row = {
    path: "tickets/FRM-1.md",
    content_hash: "h1",
    state: "synced",
  };
  const file = {
    key: "FRM-1",
    dbStatus: "backlog",
    row,
    text: MD,
    sha256: "h1",
  };
  expect(exportedFileProblems(file)).toEqual([]);
  expect(exportedFileProblems({ ...file, row: undefined })).toEqual([
    "FRM-1: no ticket_exports row",
  ]);
  expect(exportedFileProblems({ ...file, text: undefined })).toEqual([
    "FRM-1: tickets/FRM-1.md is not in the exports repo",
  ]);
  expect(
    exportedFileProblems({
      ...file,
      dbStatus: "ready",
      sha256: "h2",
      row: { ...row, path: "tickets/X.md", state: "failed" },
    }),
  ).toEqual([
    "FRM-1: exported to tickets/X.md, expected tickets/FRM-1.md",
    "FRM-1: ticket_exports state failed, expected synced",
    "FRM-1: frontmatter status backlog, the DB says ready",
    "FRM-1: the file hashes to h2, ticket_exports says h1",
  ]);
});
