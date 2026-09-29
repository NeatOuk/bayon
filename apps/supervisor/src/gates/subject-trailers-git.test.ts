// git seam, against a real repository. The parser has its own unit tests
// (subject-trailers.test.ts); what this file pins is the argv `noAttributionTrailers` builds and the
// bytes real git hands back for it. That is the part that has already regressed once: a record
// separator passed as a NUL byte is rejected by the OS in argv, which failed every review gate
// fleet-wide with "cannot run git" — a shape no amount of parser testing can catch.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { afterAll, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lifecycle/settings.js";
import { noAttributionTrailers } from "./subject.js";
import type { GitCtx } from "./git.js";

// A real repository, real commits, a real `git log`: more than the default 5 s on a loaded host.
vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

const ctx = (home: string): GitCtx => ({
  exec: {
    settings: DEFAULT_SETTINGS,
    clock: new FakeClock(0),
    frmHome: home,
    path: process.env["PATH"] ?? "/usr/bin:/bin",
    log: silent,
  },
  executor: new LocalExecutor({ id: "local", slots: new SlotCounter(4) }),
});

/** A repo with one base commit, then one commit per message given. Returns base and head shas. */
function repoWith(...messages: readonly string[]): {
  readonly dir: string;
  readonly base: string;
  readonly head: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "frm-trailer-git-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "chore(repo): base");
  const base = git(dir, "rev-parse", "HEAD");
  messages.forEach((message, i) => {
    writeFileSync(join(dir, `f${String(i)}.txt`), `${String(i)}\n`);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", message);
  });
  return { dir, base, head: git(dir, "rev-parse", "HEAD") };
}

test("a branch of clean commits passes through real git", async () => {
  const { dir, base, head } = repoWith(
    "feat(db): 013 budgets",
    "fix(web): a dead feed says so",
  );
  const clean = await noAttributionTrailers(ctx(dir), dir, base, head);
  expect(clean.ok).toBe(true);
});

test("a commit whose real message carries a trailer is refused, and named", async () => {
  const { dir, base, head } = repoWith(
    "feat(db): 013 budgets",
    "fix(web): a dead feed says so\n\nCo-Authored-By: Someone <s@example.com>",
  );
  const clean = await noAttributionTrailers(ctx(dir), dir, base, head);
  expect(clean.ok).toBe(false);
  if (clean.ok) return;
  expect(clean.error.message).toContain("1 commit(s)");
  expect(clean.error.message).toContain("a dead feed says so");
});

// The message body, not just its subject: a trailer sits at the bottom of a commit, and a format
// that only returned the subject would have missed every real one.
test("a trailer below a long body is still found", async () => {
  const { dir, base, head } = repoWith(
    "feat(core): a change\n\nA paragraph of why.\n\nAnother paragraph.\n\nSession: https://example.test/session_abc",
  );
  const clean = await noAttributionTrailers(ctx(dir), dir, base, head);
  expect(clean.ok).toBe(false);
});

// The line the rule draws, through real git rather than a hand-built string: prose about a trailer
// is not a trailer. This branch's own commits discuss the rule, and must stay mergeable.
test("a message that talks about a trailer passes", async () => {
  const { dir, base, head } = repoWith(
    "fix(gates): refuse a branch whose commits carry a Co-Authored-By trailer\n\nThe rule was only prose before this.",
  );
  const clean = await noAttributionTrailers(ctx(dir), dir, base, head);
  expect(clean.ok).toBe(true);
});

// An empty range is the ordinary case for a gate on an unchanged branch, and must not refuse.
test("an empty range is clean", async () => {
  const { dir, base } = repoWith();
  const clean = await noAttributionTrailers(ctx(dir), dir, base, base);
  expect(clean.ok).toBe(true);
});
