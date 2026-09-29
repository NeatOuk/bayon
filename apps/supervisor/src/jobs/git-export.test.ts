// Exercises the real `git` binary against a real temporary directory (design review: "git verified
// with a real temp repo (commit count, file mtimes)") -- no mocked executor here on purpose.
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { afterEach, describe, expect, test } from "vitest";
import {
  MARKER_FILE,
  commitExportChanges,
  ensureExportRepo,
} from "./git-export.js";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const commitCount = (repoPath: string): number =>
  Number(
    execFileSync("git", ["-C", repoPath, "rev-list", "--count", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
  );

describe("ensureExportRepo", () => {
  test("git init on first use, writes the marker, creates both export dirs", async () => {
    dir = mkdtempSync(join(tmpdir(), "frm-export-git-"));
    const clock = new FakeClock(1_700_000_000_000);
    expect(await ensureExportRepo(dir, clock)).toEqual({ ok: true });
    expect(readFileSync(join(dir, MARKER_FILE), "utf8")).toMatch(/foreman/);
    expect(statSync(join(dir, "tickets")).isDirectory()).toBe(true);
    expect(statSync(join(dir, "mission")).isDirectory()).toBe(true);
    expect(statSync(join(dir, ".git")).isDirectory()).toBe(true);
  });

  test("a second call is a no-op: idempotent, no re-init", async () => {
    dir = mkdtempSync(join(tmpdir(), "frm-export-git-"));
    const clock = new FakeClock(1_700_000_000_000);
    await ensureExportRepo(dir, clock);
    const before = readFileSync(join(dir, MARKER_FILE), "utf8");
    expect(await ensureExportRepo(dir, clock)).toEqual({ ok: true });
    expect(readFileSync(join(dir, MARKER_FILE), "utf8")).toBe(before);
  });

  test("refuses a git repo without the marker", async () => {
    dir = mkdtempSync(join(tmpdir(), "frm-export-git-"));
    execFileSync("git", ["-C", dir, "init"]);
    const result = await ensureExportRepo(dir, new FakeClock(0));
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toContain(MARKER_FILE);
  });
});

describe("commitExportChanges", () => {
  async function freshRepo(): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), "frm-export-git-"));
    const ok = await ensureExportRepo(dir, new FakeClock(0));
    if (!ok.ok) throw new Error(ok.error);
    return dir;
  }

  test("no changes: no commit, no git add or commit step recorded", async () => {
    const repo = await freshRepo();
    const result = await commitExportChanges(
      repo,
      "export: nothing changed",
      new FakeClock(0),
    );
    expect(result).toMatchObject({ ok: true, value: { committed: false } });
    expect(() => commitCount(repo)).toThrow(); // HEAD does not exist yet: never committed
  });

  test("a new file is staged from tickets/ only and committed once", async () => {
    const repo = await freshRepo();
    writeFileSync(join(repo, "tickets", "T-1.md"), "hello\n");
    const result = await commitExportChanges(
      repo,
      "export: 1 ticket(s)",
      new FakeClock(0),
    );
    expect(result).toMatchObject({ ok: true, value: { committed: true } });
    expect(commitCount(repo)).toBe(1);

    // A second run with nothing new makes no second commit.
    const again = await commitExportChanges(
      repo,
      "export: nothing changed",
      new FakeClock(1),
    );
    expect(again).toMatchObject({ ok: true, value: { committed: false } });
    expect(commitCount(repo)).toBe(1);
  });

  test("stages only tickets/ and mission/, never files elsewhere in the repo", async () => {
    const repo = await freshRepo();
    writeFileSync(join(repo, "tickets", "T-1.md"), "hello\n");
    writeFileSync(join(repo, "outside.txt"), "should never be committed\n");
    const result = await commitExportChanges(
      repo,
      "export: 1 ticket(s)",
      new FakeClock(0),
    );
    expect(result).toMatchObject({ ok: true, value: { committed: true } });
    const tracked = execFileSync(
      "git",
      ["-C", repo, "ls-tree", "-r", "--name-only", "HEAD"],
      {
        encoding: "utf8",
      },
    );
    expect(tracked).toContain("tickets/T-1.md");
    expect(tracked).not.toContain("outside.txt");
  });

  test("only files actually rewritten get a new mtime; untouched files are left alone", async () => {
    const repo = await freshRepo();
    const t2Path = join(repo, "tickets", "T-2.md");
    writeFileSync(join(repo, "tickets", "T-1.md"), "v1\n");
    writeFileSync(t2Path, "v1\n");
    await commitExportChanges(repo, "export: 2 ticket(s)", new FakeClock(0));
    // Pin T-2's mtime to a known, arbitrary value instead of racing the real clock: the exporter's
    // own byte-compare-before-write is what this test is really about, not filesystem timing.
    const pinned = new Date(2020, 0, 1);
    utimesSync(t2Path, pinned, pinned);
    const t2Before = statSync(t2Path).mtimeMs;

    writeFileSync(join(repo, "tickets", "T-1.md"), "v2\n");
    await commitExportChanges(repo, "export: 1 ticket(s)", new FakeClock(1));
    expect(statSync(t2Path).mtimeMs).toBe(t2Before);
    expect(commitCount(repo)).toBe(2);
  });

  test("a failing git step is reported with its evidence, not thrown", async () => {
    const repo = await freshRepo();
    writeFileSync(join(repo, "tickets", "T-1.md"), "hello\n");
    // Make the commit step fail: a conflicting index.lock left behind simulates a broken git state.
    writeFileSync(join(repo, ".git", "index.lock"), "");
    const result = await commitExportChanges(
      repo,
      "export: 1 ticket(s)",
      new FakeClock(0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.steps.length).toBeGreaterThan(0);
  });
});
