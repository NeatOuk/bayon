// The conformance workspace on an executor that places sessions (a container):
// two remote steps without their DB rows. The fixture repo is committed on this host,
// deterministically, and pushed into the executor's own mirror under a content-addressed ref. Each
// session's clone and every read of it run in that session's container, through the raw executor
// (never the fault wrapper: test 3 counts the runner's processes). A journal in the run directory
// names every session placed and released, so a crashed run's leftovers can be freed (recover.ts).
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { RESERVED_MIRROR_PREFIX, err, ok, type Result } from "@bayon/core";
import {
  GIT_ENV_FLOOR,
  GIT_ENV_FLOOR_SH,
  SAFE_GIT_SH,
  type Argv,
  type Executor,
  type SessionPlace,
} from "@bayon/executors";
import {
  FIXTURE_FILES,
  parseDiff,
  safeName,
  type FileDiff,
  type SessionDirs,
  type WorkspacePort,
} from "@bayon/runners/conformance";
import { frmError } from "../lifecycle/errors.js";
import { runArgv, type ExecCtx, type Exited } from "../lifecycle/exec.js";
import {
  cloneInContainer,
  hostGit,
  pushToExecutorMirror,
} from "../lifecycle/remote-workspace.js";

/** The executor's mirror of the fixture: a name no repo may take (H1). */
export const CONFORMANCE_MIRROR = `${RESERVED_MIRROR_PREFIX}conformance`;

/** A fixed identity, date and no system or user config: the same fixture commit on every host. */
const FIXTURE_DATE = "2026-01-01T00:00:00Z";
const FIXTURE_GIT_ENV: Readonly<Record<string, string>> = {
  ...GIT_ENV_FLOOR,
  GIT_AUTHOR_NAME: "frm conformance",
  GIT_AUTHOR_EMAIL: "conformance@frm.invalid",
  GIT_AUTHOR_DATE: FIXTURE_DATE,
  GIT_COMMITTER_NAME: "frm conformance",
  GIT_COMMITTER_EMAIL: "conformance@frm.invalid",
  GIT_COMMITTER_DATE: FIXTURE_DATE,
};
/** Signing off is this port's own; the hook and maintenance flags are safeGitArgs'. */
const NO_HOOKS = ["-c", "commit.gpgsign=false"];

const READ_CAP = 1024 * 1024;
const SNAPSHOT_CAP = 4 * 1024 * 1024;
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const NUMSTAT = ":frm-numstat:";

/** `$1` the worktree: its name-status, a separator line, its numstat, against HEAD (L1). */
export const DIFF_SH = [
  "set -eu",
  'cd "$1"',
  `export ${GIT_ENV_FLOOR_SH}`,
  `g() { git ${SAFE_GIT_SH} "$@"; }`,
  "g add -A -N",
  "g diff --name-status --no-renames --no-ext-diff --no-textconv HEAD",
  `echo '${NUMSTAT}'`,
  "g diff --numstat --no-renames --no-ext-diff --no-textconv HEAD",
].join("\n");
const EXISTS_SH = 'test -e "$1"';
/** A missing file exits 3. */
const READ_SH = ['[ -e "$1" ] || exit 3', 'exec cat -- "$1"'].join("\n");
/** Every regular file under `$1`: `<sha256>  <path>`; an unreadable one hashes as empty (L1). */
export const SNAPSHOT_SH = [
  'cd "$1" 2>/dev/null || exit 0',
  "find . -type f -print | while IFS= read -r f; do",
  '  h=$(sha256sum -- "$f" 2>/dev/null | cut -c1-64)',
  `  printf '%s  %s\\n' "\${h:-${EMPTY_SHA256}}" "\${f#./}"`,
  "done",
].join("\n");
const SCRATCH_SH = ["umask 077", 'mkdir -p -m 0700 -- "$@"'].join("\n");
const SNAPSHOT_LINE = /^([0-9a-f]{64}) {2}(.+)$/;

export interface RemoteWorkspaceOptions {
  /** This run's local scratch: the fixture's seed and bare mirror. */
  readonly root: string;
  /** The run's journal: `placed <executor> <sid>` and `released <sid>` lines, append-only. */
  readonly journal: string;
  /** The raw executor, never the suite's fault wrapper. */
  readonly executor: Executor;
  readonly exec: ExecCtx;
  /** Where scratch dirs live inside a container (each container's own /tmp). */
  readonly scratchRoot?: string;
}

/** The fixture committed here, deterministically, and cloned bare. */
async function seedFixture(
  o: RemoteWorkspaceOptions,
): Promise<Result<{ readonly mirror: string; readonly sha: string }>> {
  const seed = join(o.root, "seed");
  const mirror = join(o.root, "mirror.git");
  try {
    await mkdir(seed, { recursive: true });
    for (const [name, text] of Object.entries(FIXTURE_FILES)) {
      await writeFile(join(seed, name), text);
    }
  } catch (e) {
    return err(frmError("internal", `cannot write ${seed}`, String(e)));
  }
  const git = (dir: string, args: readonly string[]) =>
    hostGit(o.exec, dir, args, new AbortController().signal, {
      env: FIXTURE_GIT_ENV,
    });
  for (const args of [
    ["init", "-q", "--object-format=sha1", "-b", "main"],
    ["add", "-A"],
    [...NO_HOOKS, "commit", "-q", "-m", "conformance fixture"],
  ]) {
    const done = await git(seed, args);
    if (!done.ok) return done;
  }
  const cloned = await git(o.root, ["clone", "-q", "--bare", seed, mirror]);
  if (!cloned.ok) return cloned;
  const sha = await git(mirror, [
    "rev-parse",
    "--verify",
    "refs/heads/main^{commit}",
  ]);
  return sha.ok ? ok({ mirror, sha: sha.value }) : sha;
}

/** The fixture pushed into the executor's mirror, then a port over it. */
export async function remoteWorkspace(
  o: RemoteWorkspaceOptions,
): Promise<Result<WorkspacePort>> {
  const { executor } = o;
  const { mirrors } = executor;
  if (
    executor.placeSession === undefined ||
    mirrors === undefined ||
    executor.release === undefined
  ) {
    return err(
      frmError(
        "validation",
        `executor ${executor.id} does not place, mirror and release sessions`,
      ),
    );
  }
  const fixture = await seedFixture(o);
  if (!fixture.ok) return fixture;
  const { sha } = fixture.value;
  const pushed = await pushToExecutorMirror(executor, mirrors, {
    localMirror: fixture.value.mirror,
    name: CONFORMANCE_MIRROR,
    // Content-addressed and never forced: it names one commit forever (H1).
    refspecs: [`refs/heads/main:refs/heads/fixture-${sha.slice(0, 12)}`],
    signal: AbortSignal.timeout(o.exec.settings["workspace.git_timeout_ms"]),
    attempts: 2,
  });
  if (!pushed.ok) return pushed;
  return ok(new RemoteWorkspace(o, sha, mirrors.path(CONFORMANCE_MIRROR)));
}

interface Placed extends SessionPlace {
  readonly sessionId: string;
}

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

class RemoteWorkspace implements WorkspacePort {
  readonly source = "supervisor";
  readonly #o: RemoteWorkspaceOptions;
  readonly #sha: string;
  readonly #mirror: string;
  readonly #scratchRoot: string;
  /** Placed and not yet released. */
  readonly #places = new Map<string, Placed>();
  /** Every session this run placed. */
  readonly #all = new Set<string>();
  /** Scratch dir → the sessions holding a copy of it. */
  readonly #scratch = new Map<string, Set<string>>();

  constructor(o: RemoteWorkspaceOptions, sha: string, mirror: string) {
    this.#o = o;
    this.#sha = sha;
    this.#mirror = mirror;
    this.#scratchRoot = o.scratchRoot ?? "/tmp/frm-scratch";
  }

  async place(sessionId: string): Promise<string> {
    const place = this.#o.executor.placeSession?.(sessionId);
    if (place === undefined) throw new Error("the executor places no sessions");
    // The journal line before the container exists: a crash leaves nothing unnamed.
    await appendFile(
      this.#o.journal,
      `placed ${this.#o.executor.id} ${sessionId}\n`,
      { mode: 0o600 },
    );
    this.#places.set(sessionId, { ...place, sessionId });
    this.#all.add(sessionId);
    return place.root;
  }

  async create(sessionId: string): Promise<SessionDirs> {
    const p = this.#places.get(sessionId);
    if (p === undefined) throw new Error(`${sessionId} was never placed`);
    const cwd = posix.join(p.root, "work");
    const cloned = await cloneInContainer(
      this.#o.exec,
      this.#o.executor,
      p,
      {
        mode: "branch",
        clones: [
          {
            mirror: this.#mirror,
            dest: cwd,
            rev: this.#sha,
            branch: `frm/${sessionId}`,
          },
        ],
      },
      new AbortController().signal,
    );
    if (!cloned.ok) throw new Error(cloned.error.message);
    const scratches = [...this.#scratch.keys()];
    if (scratches.length > 0) {
      const made = await this.#run(
        ["/bin/sh", "-c", SCRATCH_SH, "frm-scratch", ...scratches],
        p.root,
        `the scratch dirs of ${sessionId}`,
      );
      if (made.code !== 0) throw new Error(`mkdir failed: ${made.stderr}`);
      for (const dir of scratches) this.#scratch.get(dir)?.add(sessionId);
    }
    return {
      root: p.root,
      cwd,
      homeDir: p.home,
      tmpDir: p.tmp,
      baseSha: this.#sha,
      extraRoots: [],
    };
  }

  /**
   * A writable directory of this session besides its worktree (test 16), made inside its own
   * container: `#owner` then reaches it like any other path under the session's root. No docker
   * host exists today, so this path is reviewed and never run (see the repo doctrine's Status).
   */
  async extraRoot(sessionId: string, name: string): Promise<string> {
    const p = this.#places.get(sessionId);
    if (p === undefined) throw new Error(`${sessionId} was never placed`);
    const dir = posix.join(p.root, "roots", safeName(name));
    const made = await this.#run(
      ["/bin/sh", "-c", SCRATCH_SH, "frm-roots", dir],
      p.root,
      `the extra roots of ${sessionId}`,
    );
    if (made.code !== 0) throw new Error(`mkdir ${dir} failed: ${made.stderr}`);
    return dir;
  }

  /** A path in each later session's own /tmp, made there when the session is created. */
  async scratch(name: string): Promise<string> {
    const safe = name.replace(/[^A-Za-z0-9_-]/g, "_");
    const dir = `${this.#scratchRoot}/${safe}-${this.#scratch.size + 1}`;
    this.#scratch.set(dir, new Set());
    return dir;
  }

  scratchCopies(dir: string): number {
    return this.#scratch.get(dir)?.size ?? 1;
  }

  async diff(cwd: string): Promise<readonly FileDiff[]> {
    const [p, path] = this.#owner(cwd);
    const ran = await this.#run(
      ["/bin/sh", "-c", DIFF_SH, "frm-diff", path],
      p.root,
      `git diff in ${p.sessionId}`,
      SNAPSHOT_CAP,
    );
    if (ran.code !== 0) {
      throw new Error(`git diff in ${path}: ${ran.stderr.trim().slice(-300)}`);
    }
    const [names = "", numbers = ""] = ran.stdout.split(
      new RegExp(`^${NUMSTAT}$`, "m"),
    );
    return parseDiff(names, numbers);
  }

  async exists(target: string): Promise<boolean> {
    const [p, path] = this.#owner(target);
    const ran = await this.#run(
      ["/bin/sh", "-c", EXISTS_SH, "frm-exists", path],
      p.root,
      `test -e in ${p.sessionId}`,
    );
    if (ran.code === 0 || ran.code === 1) return ran.code === 0;
    throw new Error(`test -e ${path} exited ${String(ran.code)}`);
  }

  async read(target: string): Promise<string | undefined> {
    const [p, path] = this.#owner(target);
    const ran = await this.#run(
      ["/bin/sh", "-c", READ_SH, "frm-read", path],
      p.root,
      `read in ${p.sessionId}`,
      READ_CAP,
    );
    if (ran.code === 3) return undefined;
    if (ran.code === 0) return ran.stdout;
    throw new Error(`cat ${path}: ${ran.stderr.trim().slice(-300)}`);
  }

  async snapshot(dir: string): Promise<ReadonlyMap<string, string>> {
    const holders = this.#scratch.get(dir);
    if (holders === undefined) {
      const [p, path] = this.#owner(dir);
      return this.#snapshotIn(p, path);
    }
    // A scratch dir: the union of every copy, keyed by the session holding it.
    const union = new Map<string, string>();
    for (const sessionId of holders) {
      const p = this.#places.get(sessionId);
      if (p === undefined) continue;
      for (const [rel, digest] of await this.#snapshotIn(p, dir)) {
        union.set(`${sessionId}/${rel}`, digest);
      }
    }
    return union;
  }

  async release(sessionId: string): Promise<void> {
    if (!this.#places.has(sessionId)) return;
    await this.#o.executor.release?.(sessionId, { root: "remove" });
    this.#places.delete(sessionId);
    for (const holders of this.#scratch.values()) holders.delete(sessionId);
    await appendFile(this.#o.journal, `released ${sessionId}\n`);
  }

  /** Releases what is left, then proves none of this run's sessions is still on the executor. */
  async dispose(): Promise<void> {
    const failed: string[] = [];
    for (const sessionId of [...this.#places.keys()]) {
      await this.release(sessionId).catch((e: unknown) => {
        failed.push(`${sessionId}: ${messageOf(e)}`);
      });
    }
    const owned = (await this.#o.executor.listOwned?.()) ?? [];
    const left = owned.map((o) => o.sessionId).filter((s) => this.#all.has(s));
    if (failed.length > 0 || left.length > 0) {
      throw new Error(
        `sessions left on ${this.#o.executor.id}: ${[...failed, ...left].join("; ")}`,
      );
    }
  }

  /** The placed session holding `target`, and the path: absolute, with no `..` (L1). */
  #owner(target: string): readonly [Placed, string] {
    if (!posix.isAbsolute(target) || target.split("/").includes("..")) {
      throw new Error(
        `refusing ${JSON.stringify(target)}: not absolute or has ..`,
      );
    }
    const path = posix.normalize(target);
    for (const p of this.#places.values()) {
      if (path === p.root || path.startsWith(`${p.root}/`)) return [p, path];
    }
    throw new Error(`${path} lies in no session this run placed`);
  }

  async #snapshotIn(
    p: Placed,
    dir: string,
  ): Promise<ReadonlyMap<string, string>> {
    const ran = await this.#run(
      ["/bin/sh", "-c", SNAPSHOT_SH, "frm-snapshot", dir],
      p.root,
      `snapshot in ${p.sessionId}`,
      SNAPSHOT_CAP,
    );
    if (ran.code !== 0) {
      throw new Error(`snapshot of ${dir}: ${ran.stderr.trim().slice(-300)}`);
    }
    const digests = new Map<string, string>();
    for (const line of ran.stdout.split("\n")) {
      if (line === "") continue;
      const m = SNAPSHOT_LINE.exec(line);
      if (m?.[1] === undefined || m[2] === undefined) {
        throw new Error(`snapshot of ${dir}: an unreadable listing line`);
      }
      digests.set(m[2], m[1]);
    }
    return digests;
  }

  /** One program in the session's container, to its exit; a cut output is an error, never data. */
  async #run(
    argv: Argv,
    cwd: string,
    what: string,
    maxStdoutChars?: number,
  ): Promise<Exited> {
    const ran = await runArgv(this.#o.exec, this.#o.executor, argv, {
      what,
      cwd,
      ...(maxStdoutChars === undefined ? {} : { maxStdoutChars }),
    });
    if (!ran.ok) throw new Error(ran.error.message);
    if (ran.value.overflow === true) {
      throw new Error(`${what}: over ${String(maxStdoutChars)} characters`);
    }
    return ran.value;
  }
}
