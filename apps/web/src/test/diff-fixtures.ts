import { RepoDiff, SessionDiff } from "@bayon/proto";

// Wire-shaped session diffs (DTO): every value here passes its proto schema.

export const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "",
].join("\n");

export const repoDiff = (o: Partial<RepoDiff> = {}): RepoDiff =>
  RepoDiff.parse({
    repo_id: "repo-1",
    worktree_id: "wt-1",
    branch: "agent/FRM-812",
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    gate: null,
    files: [
      { path: "src/a.ts", added: 1, deleted: 1 },
      { path: "logo.png", added: null, deleted: null },
    ],
    files_total: 2,
    untracked: ["notes.txt"],
    untracked_total: 1,
    patch: {
      text: PATCH,
      truncated: false,
      bytes: PATCH.length,
      lines: 8,
      full_path: null,
    },
    unavailable: null,
    ...o,
  });

export const sessionDiff = (
  o: Partial<SessionDiff> & Pick<SessionDiff, "session_id">,
): SessionDiff =>
  SessionDiff.parse({
    source: "worktree",
    repos: [repoDiff()],
    reason: null,
    generated_at: 1_800_000_000_000,
    ...o,
  });
