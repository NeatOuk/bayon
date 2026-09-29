// The conformance workspace on the supervisor's worktree path (§9.2): a mirror
// of the fixture repo under the run's directory, and per session a `git worktree add` off it, run
// through the executor as the spawn pipeline runs it; the session's home and tmp are 0700. Reads
// of a worktree (diff, snapshot, …) are the local filesystem's, the reference's own. An executor
// that places sessions (a container) gets remote-workspace-port.ts instead.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, type Result } from "@bayon/core";
import type { Executor } from "@bayon/executors";
import {
  FIXTURE_FILES,
  createLocalWorkspace,
  safeName,
  type WorkspacePort,
} from "@bayon/runners/conformance";
import type { ExecCtx } from "../lifecycle/exec.js";
import { git } from "../lifecycle/workspace.js";
import { remoteWorkspace } from "./remote-workspace-port.js";

// A fixed identity and no signing, so every host makes the same fixture commit. The hook and
// maintenance flags are not repeated here: this runs git through lifecycle/workspace.js, which
// carries safeGitArgs already.
const COMMIT_FLAGS = [
  "-c",
  "user.name=frm conformance",
  "-c",
  "user.email=conformance@frm.invalid",
  "-c",
  "commit.gpgsign=false",
];

export interface SupervisorWorkspaceOptions {
  /** Everything lives under it; dispose() leaves it to the caller. */
  readonly root: string;
  /** The run's journal of placed sessions (remote only; recover.ts). */
  readonly journal: string;
  readonly executor: Executor;
  readonly exec: ExecCtx;
}

/** The fixture repo committed once, then cloned bare: the mirror every session's worktree is off. */
async function fixtureMirror(
  o: SupervisorWorkspaceOptions,
): Promise<Result<{ readonly mirror: string; readonly base: string }>> {
  const seed = join(o.root, "seed");
  const mirror = join(o.root, "mirror.git");
  await mkdir(seed, { recursive: true });
  for (const [name, text] of Object.entries(FIXTURE_FILES)) {
    await writeFile(join(seed, name), text);
  }
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    [...COMMIT_FLAGS, "commit", "-q", "-m", "conformance fixture"],
  ]) {
    const done = await git(o.exec, o.executor, seed, args);
    if (!done.ok) return done;
  }
  const cloned = await git(o.exec, o.executor, o.root, [
    "clone",
    "-q",
    "--bare",
    seed,
    mirror,
  ]);
  if (!cloned.ok) return cloned;
  const base = await git(o.exec, o.executor, mirror, [
    "rev-parse",
    "--verify",
    "refs/heads/main^{commit}",
  ]);
  return base.ok ? ok({ mirror, base: base.value }) : base;
}

export async function supervisorWorkspace(
  o: SupervisorWorkspaceOptions,
): Promise<Result<WorkspacePort>> {
  // Where sessions are not this host's (a container): its own workspace, as spawn does.
  if (
    o.executor.placeSession !== undefined &&
    o.executor.mirrors !== undefined
  ) {
    return remoteWorkspace(o);
  }
  const made = await fixtureMirror(o);
  if (!made.ok) return made;
  const { mirror, base } = made.value;
  const reads = await createLocalWorkspace();
  return ok({
    ...reads,
    source: "supervisor",
    async place(sessionId) {
      return join(o.root, "sessions", sessionId);
    },
    async create(sessionId) {
      const root = join(o.root, "sessions", sessionId);
      const dirs = {
        root,
        cwd: join(root, "work"),
        homeDir: join(root, "home"),
        tmpDir: join(root, "tmp"),
      };
      await mkdir(root, { recursive: true });
      const added = await git(o.exec, o.executor, mirror, [
        "worktree",
        "add",
        "-q",
        "-b",
        `frm/${sessionId}`,
        dirs.cwd,
        base,
      ]);
      if (!added.ok) throw new Error(added.error.message);
      await mkdir(dirs.homeDir, { recursive: true, mode: 0o700 });
      await mkdir(dirs.tmpDir, { recursive: true, mode: 0o700 });
      return { ...dirs, baseSha: base, extraRoots: [] };
    },
    // Under this port's own session root, never the reference's scratch (test 16).
    async extraRoot(sessionId, name) {
      const dir = join(o.root, "sessions", sessionId, "roots", safeName(name));
      await mkdir(dir, { recursive: true });
      return dir;
    },
  });
}
