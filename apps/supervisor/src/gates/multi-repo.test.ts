// Gate subjects across repos on real git: a repo-less diff gate refused when
// the ticket's worktrees span repos (H3), a gate pinned by its repo, plan_review's source changes
// across every repo (N2), a submodule commit published to its mirror and one that cannot be (H1,
//), a dep repo's
// reviewer in its one worktree (H2), and a submodule reviewer's worktree left to the sweep, which
// removes the clean one and keeps the modified one dirty (M5, N3; design N4).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, TEMPLATES, ok } from "@bayon/core";
import { getTicket, listSessionWorktrees } from "@bayon/db";
import { seedRows, tempDb, unwrap, type SeedRows } from "@bayon/db/testing";
import type { SpawnSpec } from "@bayon/runners";
import { afterAll, describe, expect, test } from "vitest";
import { KeyedQueue } from "../lifecycle/session-queue.js";
import { DEFAULT_SETTINGS } from "../lifecycle/settings.js";
import { AGENT_ID } from "../lifecycle/testing/fixtures.js";
import {
  T0,
  TICKET,
  TURN,
  git,
  kindsOf,
  mirrorOf,
  multiRows,
  session,
  settle,
  startMultiWorld,
  submoduleRows,
  waitState,
  type MultiWorld,
  type WorldOptions,
} from "../lifecycle/testing/multi-world.js";

import { sourceChangesAcross } from "./run-gate.js";
import { loadEngineSettings } from "./settings.js";
import { pinSubject, type PinInput } from "./subject.js";

/** A world on its own temp database (only tests import @bayon/db/testing). */
async function multiWorld(o: WorldOptions): Promise<MultiWorld> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  return startMultiWorld({
    ...o,
    clock,
    db: t.db,
    dropDb: t.cleanup,
    seed: async (rows) => {
      unwrap(await seedRows(t.db, rows as SeedRows));
    },
  });
}

const worlds: MultiWorld[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const w of worlds) await w.cleanup();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const PATH = process.env["PATH"] ?? "/usr/bin:/bin";
const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const work = (w: MultiWorld, sid: string, ...rest: string[]) =>
  join(w.home, "work", sid, ...rest);

/** pinSubject's input for the ticket, git on the world's local executor. */
async function pinInput(
  w: MultiWorld,
  o: Pick<PinInput, "kind" | "repoId" | "subjectKind">,
): Promise<PinInput> {
  const artifactsDir = mkdtempSync(join(tmpdir(), "frm-pin-"));
  dirs.push(artifactsDir);
  const git = {
    exec: {
      settings: DEFAULT_SETTINGS,
      clock: w.clock,
      frmHome: w.home,
      path: PATH,
      log: silent,
    },
    executor: w.executor,
  };
  return {
    db: w.db,
    git,
    // One executor in this world: every worktree of it is read there.
    gitOn: () => ok(git),
    ticket: unwrap(await getTicket(w.db, TICKET)),
    gateId: "g-pin",
    artifactsDir,
    mirrors: new KeyedQueue(),
    ...o,
  };
}

/** A reviewer's internal spawn, pinned, a gate's when `gateId` is given; the adapter captures its spec. */
async function reviewer(
  w: MultiWorld,
  sid: string,
  at: { sha: string; baseSha: string; repoId?: string },
  gateId?: string,
): Promise<void> {
  unwrap(
    await w.lifecycle.spawnInternal({
      ...(gateId === undefined
        ? {}
        : { gate: { id: gateId, fallbackFrom: null } }),
      payload: {
        session_id: sid,
        agent_id: AGENT_ID,
        role: "reviewer",
        run_class: "review",
        ticket_id: TICKET,
        workspace_id: "ws",
      },
      run: {
        seq: 1,
        trigger: "gate",
        template: TEMPLATES.operator,
        inputs: { task: "go" },
      },
      workspace: { at },
    }),
  );
}

describe("a multi-repo ticket's gates", { timeout: 60_000 }, () => {
  const specs = new Map<string, SpawnSpec>();
  let w: MultiWorld;
  let sources = { app: "", lib: "" };

  test("setup: a builder changes both repos and commits", async () => {
    w = await multiWorld({
      rows: (home) => {
        const made = multiRows(home);
        sources = made.sources;
        return made.rows;
      },
      // A reviewer of the builder's own agent beside its live builder.
      maxConcurrency: 2,
      script: (home) => ({
        runs: [
          {
            events: [TURN],
            appends: [
              { path: "PLAN.md", text: "the plan\n" },
              {
                path: join(home, "work", "B", "lib", "lib.js"),
                text: "code\n",
              },
            ],
            commit: "plan, and a change in lib",
          },
        ],
      }),
      adapter: (base) => ({
        ...base,
        spawn: async (spec, ex) => {
          specs.set(spec.sessionId, spec);
          return base.spawn(spec, ex);
        },
      }),
    });
    worlds.push(w);
    await w.spawn("B", { prompt: "go" });
    await settle(w, async () =>
      expect(await kindsOf(w.db, "B")).toContain("terminal"),
    );
  });

  test("H3: a repo-less diff gate is refused while the worktrees span repos", async () => {
    const pin = await pinSubject(
      await pinInput(w, {
        kind: "code_review",
        repoId: null,
        subjectKind: "diff",
      }),
    );
    expect(pin).toMatchObject({
      ok: false,
      error: {
        class: "validation",
        message: `ticket ${TICKET} has worktrees in 2 repos and no ticket_repos`,
      },
    });
  });

  test("a gate with repo_id pins that repo's worktree", async () => {
    const pin = unwrap(
      await pinSubject(
        await pinInput(w, {
          kind: "code_review",
          repoId: "lib",
          subjectKind: "diff",
        }),
      ),
    );
    expect(pin).toMatchObject({ repoId: "lib", files: ["lib.js"], others: [] });
    expect(pin.base).toBe(git(sources.lib, "rev-parse", "HEAD"));
  });

  test("N2: a repo-less plan_review pins the primary and fails source_changes on lib's change", async () => {
    const pin = unwrap(
      await pinSubject(
        await pinInput(w, {
          kind: "plan_review",
          repoId: null,
          subjectKind: "plan",
        }),
      ),
    );
    expect(pin).toMatchObject({
      repoId: "app",
      files: ["PLAN.md"],
      others: [{ repoId: "lib", files: ["lib.js"] }],
    });
    const settings = unwrap(await loadEngineSettings(w.db));
    expect(sourceChangesAcross(pin, settings.planPaths)).toMatchObject({
      total: 1,
      paths: ["lib:lib.js"],
    });
  });

  test("H2: a reviewer of lib's gate works in its one dep worktree, detached, with no extra roots", async () => {
    const libHead = git(work(w, "B", "lib"), "rev-parse", "HEAD");
    const libBase = git(sources.lib, "rev-parse", "HEAD");
    await reviewer(w, "RL", { sha: libHead, baseSha: libBase, repoId: "lib" });
    await waitState(w, "RL", "idle");
    const [row, ...more] = unwrap(await listSessionWorktrees(w.db, "RL"));
    expect(more).toEqual([]);
    expect(row).toMatchObject({ repo_id: "lib", path: work(w, "RL", "lib") });
    expect(git(work(w, "RL", "lib"), "rev-parse", "HEAD")).toBe(libHead);
    const spec = specs.get("RL");
    expect(spec?.cwd).toBe(work(w, "RL", "lib"));
    expect(spec?.extraRoots).toBeUndefined();
  });
});

describe("a submodule ticket's gates", { timeout: 60_000 }, () => {
  let w: MultiWorld;
  let sources = { leaf: "", mid: "", sup: "" };

  test("setup: a builder in the submodule workspace", async () => {
    w = await multiWorld({
      rows: (home) => {
        const made = submoduleRows(home);
        sources = made.sources;
        return made.rows;
      },
      maxConcurrency: 3, // reviewers beside their live builder
      script: () => ({ runs: [{ events: [TURN] }] }),
    });
    worlds.push(w);
    await w.spawn("SB");
    await waitState(w, "SB", "idle");
  });

  test("a gitlink bump to a commit only the module gitdir holds is published to the child's mirror and pins; H1 still refuses one no repository holds", async () => {
    const sup = work(w, "SB", "super");
    const sub = join(sup, "libs", "mid");
    const mid = mirrorOf(w.home, "mid");
    git(sub, "commit", "-q", "--allow-empty", "-m", "inner work");
    const inner = git(sub, "rev-parse", "HEAD");
    git(sup, "add", "libs/mid");
    git(sup, "commit", "-q", "-m", "bump mid");
    // Before the pin it lives only in the worktree's modules/, nowhere a reviewer could read it.
    expect(() => git(mid, "cat-file", "-e", `${inner}^{commit}`)).toThrow();
    const pinned = unwrap(
      await pinSubject(
        await pinInput(w, {
          kind: "code_review",
          repoId: null,
          subjectKind: "diff",
        }),
      ),
    );
    expect(pinned.files).toEqual(["libs/mid"]);
    expect(git(mid, "cat-file", "-t", inner)).toBe("commit");
    // Published under the session's own branch, as the superproject's worktree is.
    expect(git(mid, "rev-parse", "refs/heads/frm/SB")).toBe(inner);
    // H1's guard is still live: a gitlink to a commit the submodule itself does not hold.
    const nowhere = "0".repeat(39) + "1";
    git(
      sup,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${nowhere},libs/mid`,
    );
    git(sup, "commit", "-q", "-m", "bump mid to nothing");
    const refused = await pinSubject(
      await pinInput(w, {
        kind: "code_review",
        repoId: null,
        subjectKind: "diff",
      }),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: {
        class: "validation",
        message: expect.stringContaining(
          `submodule commit ${nowhere} not published to mirror ${mid}`,
        ),
      },
    });
    // a `workspace` subject — parity_check's — still publishes, but is not refused. That
    // gate exists to report an unpublished gitlink as a finding an operator can act on; refusing
    // its pin would lose the answer to the very check meant to produce it.
    const parity = await pinSubject(
      await pinInput(w, {
        kind: "parity_check",
        repoId: null,
        subjectKind: "workspace",
      }),
    );
    expect(parity.ok, parity.ok ? "" : parity.error.message).toBe(true);
    git(sup, "reset", "-q", "--hard", "HEAD~1");
  });

  test("M5/N3, N4: a submodule reviewer's worktree waits for the sweep, which removes the clean one and keeps the modified one dirty; no submodule key ever lands in the mirror's config", async () => {
    const base = git(sources.sup, "rev-parse", "HEAD");
    // Gate reviewers: never a subject, so the ticket's open status does not hold their rows.
    unwrap(
      await seedRows(w.db, {
        gates: [
          {
            id: "g-sweep",
            ticket_id: TICKET,
            kind: "code_review",
            state: "passed",
            subject_kind: "diff",
            subject_ref: `${base}..${base}`,
          },
        ],
      }),
    );
    for (const [sid, modify] of [
      ["RC", false],
      ["RD", true],
    ] as const) {
      await reviewer(w, sid, { sha: base, baseSha: base }, "g-sweep");
      await waitState(w, sid, "idle");
      if (modify) {
        writeFileSync(
          work(w, sid, "super", "libs", "mid", "README.md"),
          "changed\n",
        );
      }
      await w.lifecycle.stop(sid, "kill");
      await waitState(w, sid, "exited");
      // The gate engine's end hook no longer touches it: the row stays for the sweep.
      const [row] = unwrap(await listSessionWorktrees(w.db, sid));
      expect(row?.state).toBe("active");
    }
    // worktree.min_ended_ms has passed for both.
    unwrap(
      await seedRows(w.db, {
        settings: [
          { key: "worktree.min_ended_ms", value_json: "1", updated_at: 0 },
        ],
      }),
    );
    await w.clock.advance(2);
    await w.lifecycle.sweepWorktrees();
    const [clean] = unwrap(await listSessionWorktrees(w.db, "RC"));
    expect(clean).toMatchObject({ state: "removed", kept_reason: null });
    const [dirty] = unwrap(await listSessionWorktrees(w.db, "RD"));
    expect(dirty).toMatchObject({ state: "active", kept_reason: "dirty" });
    expect((await session(w.db, "RD")).state).toBe("exited");
    expect(() =>
      git(
        w.home,
        "config",
        "-f",
        join(mirrorOf(w.home, "super"), "config"),
        "--get-regexp",
        "^submodule\\.",
      ),
    ).toThrow();
  });
});
