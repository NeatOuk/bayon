import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  SPINE_SEED,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import { createSession } from "./sessions.js";
import {
  countHandoffWorktreeRows,
  insertWorktree,
  listHandoffWorktrees,
  setWorktreeState,
  type NewWorktree,
} from "./worktrees.js";

// countHandoffWorktreeRows: has a hand-off's chain ever had a worktree row?
const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
afterAll(() => t.cleanup());
unwrap(await seedSpine(t.db, 2));
unwrap(
  await seedRows(t.db, {
    repos: [{ id: "repo", name: "repo", mirror_path: "/m/repo" }],
    workspaces: [{ id: "ws", name: "ws", kind: "single" }],
  }),
);

const worktree = (sessionId: string, path: string): NewWorktree => ({
  session_root: `/w/${sessionId}`,
  workspace_id: "ws",
  repo_id: "repo",
  path,
  branch: `frm/${sessionId}`,
  base_sha: "abc123",
  session_id: sessionId,
  state: "active",
});

const session = async (id: string, handoffIn: string | null = null) =>
  unwrap(
    await createSession(t.db, {
      ...newSessionInput(),
      id,
      mcp_token_hash: `hash-${id}`,
      handoff_in_id: handoffIn,
    }),
  );

test("a chain with no worktree row counts 0; a removed one still counts, and listHandoffWorktrees leaves it out", async () => {
  const chain = { id: "h-1", from_session_id: SPINE_SEED.sessionId };
  expect(unwrap(await countHandoffWorktreeRows(t.db, chain))).toBe(0);
  const row = unwrap(
    await insertWorktree(t.db, worktree(SPINE_SEED.sessionId, "/w/a")),
  );
  unwrap(await setWorktreeState(t.db, row.id, "removed"));
  expect(unwrap(await countHandoffWorktreeRows(t.db, chain))).toBe(1);
  expect(unwrap(await listHandoffWorktrees(t.db, chain))).toEqual([]);
});

test("a successor spawned for the hand-off counts toward its chain; another session's worktree does not", async () => {
  await session("from-2");
  await session("succ-2", "h-2");
  await session("other");
  const chain = { id: "h-2", from_session_id: "from-2" };
  unwrap(await insertWorktree(t.db, worktree("other", "/w/other")));
  expect(unwrap(await countHandoffWorktreeRows(t.db, chain))).toBe(0);
  unwrap(await insertWorktree(t.db, worktree("succ-2", "/w/succ-2")));
  expect(unwrap(await countHandoffWorktreeRows(t.db, chain))).toBe(1);
});
