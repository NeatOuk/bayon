import { describe, expect, test } from "vitest";
import { rootsOf, type RootRepo, type RootRow } from "./roots.js";

const repos: RootRepo[] = [
  { id: "lib", role: "dep", rel_path: "lib" },
  { id: "app", role: "primary", rel_path: "app" },
  { id: "aux", role: "dep", rel_path: "aux" },
];
const wt = (repo: string): RootRow => ({
  id: `wt-${repo}`,
  repo_id: repo,
  path: `/w/s/${repo}`,
});

describe("rootsOf (H2)", () => {
  test("a builder's cwd is the primary whatever the row order; the rest are extras by rel_path", () => {
    const r = rootsOf([wt("lib"), wt("aux"), wt("app")], repos, {
      pinned: false,
    });
    expect(r).toEqual({
      ok: true,
      value: { cwd: "/w/s/app", extraRoots: ["/w/s/aux", "/w/s/lib"] },
    });
  });

  test("a builder's set without the primary is refused", () => {
    const r = rootsOf([wt("lib")], repos, { pinned: false });
    expect(!r.ok && r.error).toMatchObject({
      class: "validation",
      message: "the session's worktrees lack the workspace's primary repo app",
    });
  });

  test("a pinned checkout's one row is its cwd even when it is a dep; two rows are refused", () => {
    expect(rootsOf([wt("lib")], repos, { pinned: true })).toEqual({
      ok: true,
      value: { cwd: "/w/s/lib", extraRoots: [] },
    });
    const two = rootsOf([wt("lib"), wt("app")], repos, { pinned: true });
    expect(!two.ok && two.error.message).toBe(
      "a pinned checkout works in exactly one worktree, not 2",
    );
  });

  test("a one-repo workspace needs no role; no rows is no workspace", () => {
    expect(
      rootsOf([wt("solo")], [{ id: "solo", role: "dep", rel_path: "solo" }], {
        pinned: false,
      }),
    ).toEqual({ ok: true, value: { cwd: "/w/s/solo", extraRoots: [] } });
    expect(rootsOf([], repos, { pinned: false })).toEqual({
      ok: true,
      value: null,
    });
  });

  test("two worktrees of one repo are refused", () => {
    const r = rootsOf([wt("app"), { ...wt("app"), id: "wt-2" }], repos, {
      pinned: false,
    });
    expect(!r.ok && r.error.message).toBe(
      "the session holds two worktrees of one repo",
    );
  });
});
