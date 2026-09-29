// GET /sessions/:id/diff against a temp-file DB and real git repos: a local session's
// worktrees diffed on this host, a session elsewhere (or a reviewer) shown its gates' diff.patch,
// the §8.5 cap with the full patch kept on disk, and every refusal said per repo.
import { FakeClock, systemClock } from "@bayon/core";
import {
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import { ApiErrorBody, SESSION_DIFF_CAP, SessionDiff } from "@bayon/proto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dbStore } from "../db-store.js";
import { EVIDENCE, gate } from "../gates/fixtures.js";
import { startApi, type RunningApi } from "../server.js";
import { SessionDiffService, type SessionDiffDeps } from "./session-diff.js";

const TOKEN = "e2e-diff-bearer-0123456789abcdef";
const NOW = 1_700_000_000_000;
const GATE_PATCH = [
  "diff --git a/src/x.ts b/src/x.ts",
  "index 1111111..2222222 100644",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -1 +1,2 @@",
  " x",
  "+y",
  "",
].join("\n");

let t: TempDb;
let home: string;
let runtime: string;
let artifacts: string;
let api: RunningApi;
let base: string;
let head: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      "-C",
      cwd,
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
}

/** A repo at `dir` with `files` committed; its sha. */
function repoAt(dir: string, files: Readonly<Record<string, string>>): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return git(dir, "rev-parse", "HEAD");
}

const service = (o: Partial<SessionDiffDeps> = {}) =>
  new SessionDiffService({
    db: t.db,
    clock: new FakeClock(NOW),
    runtimeDir: runtime,
    workRoot: join(runtime, "work"),
    artifactsDir: artifacts,
    ...o,
  });

const evidenceFor = (gateId: string): string =>
  JSON.stringify({
    ...EVIDENCE,
    artifact_paths: [
      join(artifacts, "gates", gateId, "diff.patch"),
      join(artifacts, "gates", gateId, "review.json"),
    ],
    subject: {
      repo_id: null,
      base_sha: "a".repeat(40),
      head_sha: "b".repeat(40),
      files: 1,
    },
  });

const session = (
  id: string,
  o: {
    readonly executor_id?: string;
    readonly ticket_id?: string;
    readonly gate_id?: string;
  } = {},
) => ({
  ...newSessionInput(),
  id,
  state: "idle" as const,
  created_at: 0,
  ...o,
});

const worktree = (
  id: string,
  sessionId: string,
  path: string,
  baseSha: string,
  o: { readonly state?: "merged" } = {},
) => ({
  id,
  session_root: join(runtime, "sessions", sessionId),
  workspace_id: "ws-1",
  repo_id: "repo-1",
  path,
  branch: `agent/${id}`,
  base_sha: baseSha,
  session_id: sessionId,
  state: "active" as const,
  created_at: 0,
  ...o,
});

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "bayon-diff-"));
  runtime = join(home, "runtime");
  artifacts = join(home, "artifacts");

  // wt-1: committed, uncommitted, binary, deleted and untracked changes since its base.
  const wt1 = join(runtime, "work", "wt-1");
  base = repoAt(wt1, { "a.txt": "one\n", "gone.txt": "bye\n" });
  writeFileSync(join(wt1, "a.txt"), "one\ntwo\n");
  writeFileSync(join(wt1, "b.txt"), "new\n");
  writeFileSync(join(wt1, "bin.dat"), Buffer.from([0, 1, 2, 0, 255]));
  rmSync(join(wt1, "gone.txt"));
  git(wt1, "add", "-A");
  git(wt1, "commit", "-q", "-m", "change");
  head = git(wt1, "rev-parse", "HEAD");
  writeFileSync(join(wt1, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(wt1, "untracked.txt"), "?\n");

  // wt-big: a staged 300-line file, over the cap.
  const big = join(runtime, "work", "wt-big");
  const bigBase = repoAt(big, { "seed.txt": "x\n" });
  writeFileSync(
    join(big, "big.txt"),
    Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n") + "\n",
  );
  git(big, "add", "big.txt");

  // wt-out: a repo outside <runtime>/work, which git must never be run in.
  const outside = join(home, "elsewhere");
  const outBase = repoAt(outside, { "a.txt": "a\n" });

  mkdirSync(join(artifacts, "gates", "g-new"), { recursive: true });
  writeFileSync(join(artifacts, "gates", "g-new", "diff.patch"), GATE_PATCH);
  mkdirSync(join(artifacts, "gates", "g-old"), { recursive: true });
  writeFileSync(join(artifacts, "gates", "g-old", "diff.patch"), "old\n");
  mkdirSync(join(artifacts, "gates", "g-out"), { recursive: true });
  writeFileSync(join(home, "secret.patch"), "diff --git a/s b/s\n");
  symlinkSync(
    join(home, "secret.patch"),
    join(artifacts, "gates", "g-out", "diff.patch"),
  );

  t = unwrap(await tempDb(new FakeClock(NOW)));
  unwrap(await seedSpine(t.db, 8));
  unwrap(
    await seedRows(t.db, {
      executors: [{ id: "ctr", kind: "container", config_json: "{}" }],
      repos: [{ id: "repo-1", name: "repo-1", mirror_path: "/mirror/repo-1" }],
      workspaces: [{ id: "ws-1", name: "ws-1", kind: "single" }],
      tickets: [ticketRow(1, { status: "code_review" }), ticketRow(2)],
      gates: [
        gate("g-old", 1, {
          state: "failed",
          started_at: 5,
          evidence_json: evidenceFor("g-old"),
        }),
        gate("g-new", 1, {
          state: "passed",
          attempt: 2,
          started_at: 10,
          evidence_json: evidenceFor("g-new"),
        }),
        gate("g-run", 2, { state: "running" }),
        gate("g-out", 2, {
          kind: "ce_review",
          state: "failed",
          started_at: 3,
          evidence_json: evidenceFor("g-out"),
        }),
      ],
    }),
  );
  unwrap(
    await seedRows(t.db, {
      sessions: [
        session("S-local"),
        session("S-big"),
        session("S-out"),
        session("S-merged"),
        session("S-empty"),
        session("S-remote", { executor_id: "ctr", ticket_id: "ticket-1" }),
        session("S-adrift", { executor_id: "ctr" }),
        session("S-review", { gate_id: "g-run" }),
        session("S-escape", { gate_id: "g-out" }),
      ],
      worktrees: [
        worktree("wt-1", "S-local", wt1, base),
        worktree("wt-big", "S-big", big, bigBase),
        worktree("wt-out", "S-out", outside, outBase),
        worktree(
          "wt-merged",
          "S-merged",
          join(runtime, "work", "wt-merged"),
          base,
          { state: "merged" },
        ),
      ],
    }),
  );

  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(t.db),
    clock: systemClock,
    logger: false,
    diffs: service(),
  });
});

// Guarded: a setup that failed half-way must not hide its own error behind these.
afterAll(async () => {
  if (api !== undefined) await api.close();
  if (t !== undefined) t.cleanup();
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
});

describe("a local session's worktrees, diffed on this host", () => {
  test("committed and uncommitted changes against the base, with binary, deleted and untracked files", async () => {
    const diff = unwrap(await service().diff("S-local"));
    expect(diff).toMatchObject({
      session_id: "S-local",
      source: "worktree",
      reason: null,
      generated_at: NOW,
    });
    const [repo] = diff.repos;
    expect(repo).toMatchObject({
      repo_id: "repo-1",
      worktree_id: "wt-1",
      branch: "agent/wt-1",
      base_sha: base,
      head_sha: head,
      gate: null,
      unavailable: null,
      files_total: 4,
      untracked: ["untracked.txt"],
      untracked_total: 1,
    });
    expect(repo?.files).toEqual([
      { path: "a.txt", added: 2, deleted: 0 },
      { path: "b.txt", added: 1, deleted: 0 },
      { path: "bin.dat", added: null, deleted: null },
      { path: "gone.txt", added: 0, deleted: 1 },
    ]);
    expect(repo?.patch).toMatchObject({ truncated: false, full_path: null });
    expect(repo?.patch?.text).toContain("+three");
  });

  test("a patch over the cap is capped, and kept whole 0600 under the session's runtime dir", async () => {
    const [repo] = unwrap(await service().diff("S-big")).repos;
    const patch = repo?.patch;
    if (patch === null || patch === undefined) throw new Error("no patch");
    expect(patch.truncated).toBe(true);
    expect(patch.lines).toBeGreaterThan(SESSION_DIFF_CAP.lines);
    expect(patch.text.split("\n").length).toBeLessThanOrEqual(
      SESSION_DIFF_CAP.lines,
    );
    expect(Buffer.byteLength(patch.text)).toBeLessThanOrEqual(
      SESSION_DIFF_CAP.bytes,
    );
    const full = patch.full_path ?? "";
    expect(full.startsWith(join(runtime, "sessions", "S-big", "diffs"))).toBe(
      true,
    );
    const kept = readFileSync(full, "utf8");
    expect(Buffer.byteLength(kept)).toBe(patch.bytes);
    expect(kept.startsWith(patch.text)).toBe(true);
    expect(statSync(full).mode & 0o777).toBe(0o600);
    const again = unwrap(await service().diff("S-big")).repos[0]?.patch;
    expect(again?.full_path).toBe(full);
  });

  test("a worktree outside the work root, a merged one, no work root and a failed git each say why", async () => {
    expect(unwrap(await service().diff("S-out")).repos[0]?.unavailable).toMatch(
      /^worktree wt-out is not under /,
    );
    expect(unwrap(await service().diff("S-merged")).repos[0]).toMatchObject({
      unavailable: "worktree wt-merged is merged",
      patch: null,
    });
    expect(
      unwrap(await service({ workRoot: null }).diff("S-local")).repos[0]
        ?.unavailable,
    ).toBe("the API has no work root (FRM_HOME) to find worktrees in");
    const timedOut = service({
      git: () =>
        Promise.resolve({
          ok: false,
          detail: "git timed out after 10000 ms",
        }),
    });
    expect(unwrap(await timedOut.diff("S-local")).repos[0]).toMatchObject({
      worktree_id: "wt-1",
      unavailable: "git timed out after 10000 ms",
    });
  });
});

describe("a session elsewhere, or a reviewer: its gates' diff.patch", () => {
  test("a container session shows its ticket's newest gate per repo", async () => {
    const diff = unwrap(await service().diff("S-remote"));
    expect(diff.source).toBe("gate");
    expect(diff.repos).toHaveLength(1);
    expect(diff.repos[0]).toEqual({
      repo_id: null,
      worktree_id: null,
      branch: null,
      base_sha: "a".repeat(40),
      head_sha: "b".repeat(40),
      gate: { id: "g-new", kind: "code_review", attempt: 2, state: "passed" },
      files: [{ path: "src/x.ts", added: 1, deleted: 0 }],
      files_total: 1,
      untracked: [],
      untracked_total: 0,
      patch: {
        text: GATE_PATCH,
        truncated: false,
        bytes: Buffer.byteLength(GATE_PATCH),
        lines: 7,
        full_path: null,
      },
      unavailable: null,
    });
  });

  test("a reviewer's gate before its pin, a diff.patch that links out, and no artifacts dir each say why", async () => {
    expect(unwrap(await service().diff("S-review"))).toMatchObject({
      source: "gate",
      repos: [
        {
          gate: { id: "g-run", state: "running" },
          unavailable: "gate g-run has no diff.patch yet",
        },
      ],
    });
    expect(unwrap(await service().diff("S-escape")).repos[0]?.unavailable).toBe(
      "the diff.patch path is outside its gate's artifacts",
    );
    expect(
      unwrap(await service({ artifactsDir: null }).diff("S-remote")).repos[0]
        ?.unavailable,
    ).toBe("diff.patch files are not served: set FRM_HOME");
  });

  test("nothing to show says why; an unknown session is not_found", async () => {
    expect(unwrap(await service().diff("S-empty"))).toMatchObject({
      source: "none",
      repos: [],
      reason:
        "session S-empty holds no worktree (a successor may have taken it over) and reviews no gate",
    });
    expect(unwrap(await service().diff("S-adrift")).reason).toBe(
      "session S-adrift runs on the container executor ctr, whose worktrees are not on the API's host, and it works no ticket",
    );
    const unknown = await service().diff("no-such-session");
    expect(unknown.ok ? null : unknown.error.class).toBe("not_found");
  });
});

describe("over HTTP", () => {
  const get = (path: string, auth = true) =>
    fetch(`${api.url}${path}`, {
      headers: auth ? { authorization: `Bearer ${TOKEN}` } : {},
    });

  test("GET /sessions/:id/diff is a SessionDiff; an unknown session is 404; the route needs the bearer", async () => {
    const res = await get("/sessions/S-remote/diff");
    expect(res.status).toBe(200);
    expect(SessionDiff.parse(await res.json()).repos[0]?.gate?.id).toBe(
      "g-new",
    );
    const missing = await get("/sessions/no-such-session/diff");
    expect(missing.status).toBe(404);
    expect(ApiErrorBody.parse(await missing.json()).error.class).toBe(
      "not_found",
    );
    expect((await get("/sessions/S-remote/diff", false)).status).toBe(401);
  });
});
