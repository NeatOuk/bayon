// The remote workspace step's refusals: a successor
// cannot inherit a worktree across containers until M4's sync-back, and a pinned checkout names
// only a refs/frm/{gate,pin}/<id> ref. Both are refused before anything reaches the executor: no
// mirror push, no exec, no mirror mutex.
import { describe, expect, test, vi } from "vitest";
import type { Executor, ExecutorMirrors } from "@bayon/executors";

// The workspace's layout, without a database: its one repo's id takes the reserved prefix. The
// other refusals come before it is looked up.
vi.mock("./workspace-plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace-plan.js")>();
  const repo = {
    id: "frm-conformance",
    rel_path: "repo",
    role: "primary",
    submodule_path: null,
    has_submodules: 0,
    mirror_path: "/m/frm-conformance.git",
    default_base_branch: "main",
    origin_url: null,
    doctrine: [],
  };
  return {
    ...actual,
    loadLayout: () =>
      Promise.resolve({
        ok: true,
        value: { kind: "single", primary: repo, extras: [], submodules: [] },
      }),
  };
});
import type { Ctx } from "./context.js";
import { prepareRemoteWorkspace } from "./remote-workspace.js";
import type { Resolved } from "./resolve.js";

/** A container stand-in that records every call that would reach the docker host. */
function recorder() {
  const calls: string[] = [];
  const mirrors: ExecutorMirrors = {
    path: (name) => `/r/mirror/${name}.git`,
    push: async (o) => {
      calls.push(`push ${o.name}`);
    },
    fetchFromSession: async (o) => {
      calls.push(`fetch ${o.dir}`);
    },
    listPins: async () => {
      calls.push("list pins");
      return [];
    },
    dropPins: async (name) => {
      calls.push(`drop pins ${name}`);
    },
  };
  const executor = {
    id: "ctr-x",
    kind: "container",
    capabilities: { pty: false },
    mirrors,
    placeSession: (sid: string) => ({
      root: `/frm/s/${sid}`,
      home: `/frm/s/${sid}/.frm/home`,
      tmp: `/frm/s/${sid}/.frm/tmp`,
    }),
    prepare: async () => {
      calls.push("prepare");
      return { root: "/frm/s/S9" };
    },
    exec: async () => {
      calls.push("exec");
      throw new Error("no exec expected");
    },
    pty: async () => {
      throw new Error("no pty expected");
    },
    probe: async () => "dead" as const,
    cleanup: async () => undefined,
    capacity: () => ({ slots: 1, used: 0 }),
    health: async () => {
      calls.push("health");
      throw new Error("no health check expected");
    },
  } satisfies Executor;
  // Only what the refusals may touch: a call to anything else fails the test.
  const ctx = {
    mirrors: {
      run: () => {
        calls.push("mirror mutex");
        throw new Error("no mirror work expected");
      },
    },
  } as unknown as Ctx;
  return { calls, executor, ctx };
}

const resolved = (over: Partial<Resolved>): Resolved =>
  ({
    sessionId: "S9",
    workspaceId: "ws",
    successor: null,
    paths: {
      root: "/frm/s/S9",
      home: "/frm/s/S9/.frm/home",
      tmp: "/frm/s/S9/.frm/tmp",
      remote: true,
    },
    ...over,
  }) as unknown as Resolved;

describe("the remote workspace step refuses before touching the executor", () => {
  test("a successor on a container: validation, and no mirror push first", async () => {
    const { calls, executor, ctx } = recorder();
    const r = resolved({
      // An inherited worktree: a fresh successor (worktree null) clones as usual.
      successor: {
        predecessorId: "S1",
        worktree: { id: "w-1" },
      } as unknown as Resolved["successor"],
    });
    expect(
      await prepareRemoteWorkspace(
        ctx,
        r,
        executor,
        new AbortController().signal,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        class: "validation",
        message:
          "session S9: a worktree is not inherited across containers until M4's sync-back",
      },
    });
    expect(calls).toEqual([]);
  });

  test("a pinned checkout under any ref but refs/frm/{gate,pin}/<id>: validation, nothing pushed", async () => {
    const { calls, executor, ctx } = recorder();
    for (const ref of [
      "refs/heads/main",
      "refs/frm/gate/a b",
      "refs/frm/gate/../x",
    ]) {
      expect(
        await prepareRemoteWorkspace(
          ctx,
          resolved({}),
          executor,
          new AbortController().signal,
          {
            kind: "detached",
            sha: "a".repeat(40),
            baseSha: "b".repeat(40),
            ref,
          },
        ),
      ).toMatchObject({ ok: false, error: { class: "validation" } });
    }
    expect(calls).toEqual([]);
  });

  test("a repo whose id takes the executor-mirror prefix: validation, nothing pushed (H1)", async () => {
    const { calls, executor, ctx } = recorder();
    expect(
      await prepareRemoteWorkspace(
        ctx,
        resolved({}),
        executor,
        new AbortController().signal,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        class: "validation",
        message: expect.stringContaining("repo frm-conformance"),
      },
    });
    expect(calls).toEqual([]);
  });
});
