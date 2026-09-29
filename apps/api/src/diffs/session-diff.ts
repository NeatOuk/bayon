import { GateEvidence, err, ok, type Clock, type Result } from "@bayon/core";
import {
  getExecutor,
  getGate,
  getSession,
  listSessionWorktrees,
  listTicketGates,
  type Db,
  type ExecutorRow,
  type GateRow,
  type SessionRow,
  type WorktreeRow,
} from "@bayon/db";
import {
  SESSION_DIFF_MAX_FILES,
  SessionDiff,
  type RepoDiff,
  type SessionDiffSource,
} from "@bayon/proto";
import { Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseAs } from "../dto.js";
import { openWithin } from "../payloads.js";
import {
  locateWorktree,
  runGit,
  type GitRunner,
} from "../tickets/git-facts.js";
import { capPatch, diffFiles } from "./diff-text.js";

// GET /sessions/:id/diff (§12.1, §12.4 #5). A read: the API writes no table here (§9.5).
// A local session's worktrees are diffed on this host against their base, git run as argv by
// git-facts' runner (no shell, optional locks and fsmonitor off, a timeout, a buffer cap). A session
// on another executor, or a reviewer (its detached worktree has no row), shows its gates' diff.patch.
// Every patch is capped (§8.5, Invariant 9): a truncated worktree patch is kept whole under the
// session's runtime directory, a gate's already is on disk, and that path is handed back.

const GIT_TIMEOUT_MS = 10_000;
/** The largest patch read: git's output buffer, and a gate's diff.patch on disk. */
export const DIFF_MAX_BYTES = 32 * 1024 * 1024;
const GONE: ReadonlySet<string> = new Set(["merged", "removed"]);
const SHA = /^[0-9a-f]{7,64}$/;
/** Row ids that may name a directory: no separators, no dots. */
const PATH_ID = /^[A-Za-z0-9_-]+$/;
const DIFF_PATCH = "diff.patch";
/** Create or truncate, never through a symlink at the file itself. */
const WRITE_NO_SYMLINK =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_TRUNC |
  constants.O_NOFOLLOW;

const log = new Logger("SessionDiff");

export interface SessionDiffDeps {
  readonly db: Db;
  readonly clock: Clock;
  /** `<FRM_HOME>/runtime`: kept patches live under its sessions/<id>/diffs/. */
  readonly runtimeDir: string | null;
  /** `<FRM_HOME>/work`, where the supervisor roots each session's worktrees (loadWorkRoot). */
  readonly workRoot: string | null;
  /** `<FRM_HOME>/artifacts`: each gate's diff.patch is under its gates/<id>/. */
  readonly artifactsDir: string | null;
  /** git as argv; tests may pass their own. */
  readonly git?: GitRunner;
}

type RepoFacts = Pick<
  RepoDiff,
  "repo_id" | "worktree_id" | "branch" | "base_sha" | "head_sha" | "gate"
>;

const unavailable = (facts: RepoFacts, reason: string): RepoDiff => ({
  ...facts,
  files: [],
  files_total: 0,
  untracked: [],
  untracked_total: 0,
  patch: null,
  unavailable: reason,
});

/** A gate's evidence when it is full GateEvidence; null for none, a bare failure, or one unreadable. */
function evidenceOf(gate: GateRow): GateEvidence | null {
  if (gate.evidence_json === null) return null;
  try {
    const parsed = GateEvidence.safeParse(JSON.parse(gate.evidence_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const diffPatchOf = (gate: GateRow): string | null =>
  evidenceOf(gate)?.artifact_paths.find(
    (path) => basename(path) === DIFF_PATCH,
  ) ?? null;

/** The newest gate per repo that pinned a diff.patch: the last change of each repo under review. */
function latestPerRepo(gates: readonly GateRow[]): GateRow[] {
  const newest = gates
    .filter((gate) => diffPatchOf(gate) !== null)
    .toSorted(
      (a, b) =>
        (b.started_at ?? 0) - (a.started_at ?? 0) || b.attempt - a.attempt,
    );
  return newest.filter(
    (gate, i) =>
      newest.findIndex((other) => other.repo_id === gate.repo_id) === i,
  );
}

function gateFacts(gate: GateRow): RepoFacts {
  const subject = evidenceOf(gate)?.subject;
  return {
    repo_id: subject?.repo_id ?? gate.repo_id,
    worktree_id: null,
    branch: null,
    base_sha: subject?.base_sha ?? null,
    head_sha: subject?.head_sha ?? null,
    gate: {
      id: gate.id,
      kind: gate.kind,
      attempt: gate.attempt,
      state: gate.state,
    },
  };
}

function noDiffReason(session: SessionRow, executor: ExecutorRow): string {
  if (executor.kind === "local")
    return `session ${session.id} holds no worktree (a successor may have taken it over) and reviews no gate`;
  const where = `session ${session.id} runs on the ${executor.kind} executor ${executor.id}, whose worktrees are not on the API's host`;
  return session.ticket_id === null
    ? `${where}, and it works no ticket`
    : `${where}, and no gate of its ticket has pinned a ${DIFF_PATCH} yet`;
}

/** A gate's diff.patch, read whole from inside its artifacts directory (symlinks refused). */
async function readWithin(
  dir: string,
  file: string,
): Promise<Result<{ readonly text: string; readonly path: string }>> {
  const opened = await openWithin(dir, resolve(dir, file), {
    what: DIFF_PATCH,
    where: "its gate's artifacts",
  });
  if (!opened.ok) return opened;
  const { handle, size, path } = opened.value;
  try {
    if (size > DIFF_MAX_BYTES)
      return err({
        class: "validation",
        message: `${DIFF_PATCH} is ${size} bytes, over the ${DIFF_MAX_BYTES} the API reads`,
        retryable: false,
      });
    return ok({ text: await handle.readFile("utf8"), path });
  } catch (cause) {
    return err({
      class: "internal",
      message: `could not read ${DIFF_PATCH}`,
      retryable: false,
      cause,
    });
  } finally {
    await handle.close();
  }
}

export class SessionDiffService {
  readonly #deps: SessionDiffDeps;
  readonly #git: GitRunner;

  constructor(deps: SessionDiffDeps) {
    this.#deps = deps;
    this.#git = deps.git ?? runGit("git", DIFF_MAX_BYTES);
  }

  /** What the session changed, per repo; not_found for an unknown session. One repo's trouble is its own. */
  async diff(sessionId: string): Promise<Result<SessionDiff>> {
    const { db } = this.#deps;
    const session = await getSession(db, sessionId);
    if (!session.ok) return session;
    const executor = await getExecutor(db, session.value.executor_id);
    if (!executor.ok) return executor;
    const worktrees = await listSessionWorktrees(db, sessionId);
    if (!worktrees.ok) return worktrees;
    const local = executor.value.kind === "local";
    if (local && worktrees.value.length > 0)
      return this.#answer(
        sessionId,
        "worktree",
        await Promise.all(
          worktrees.value.map((w) => this.#worktreeDiff(sessionId, w)),
        ),
      );
    const gates = await this.#gatesOf(session.value, local);
    if (!gates.ok) return gates;
    if (gates.value.length > 0)
      return this.#answer(
        sessionId,
        "gate",
        await Promise.all(gates.value.map((gate) => this.#gateDiff(gate))),
      );
    return this.#answer(
      sessionId,
      "none",
      [],
      noDiffReason(session.value, executor.value),
    );
  }

  #answer(
    sessionId: string,
    source: SessionDiffSource,
    repos: readonly RepoDiff[],
    reason: string | null = null,
  ): Result<SessionDiff> {
    return parseAs(
      SessionDiff,
      {
        session_id: sessionId,
        source,
        repos,
        reason,
        generated_at: this.#deps.clock.now(),
      },
      `session ${sessionId} diff`,
    );
  }

  /** A reviewer's own gate; else, for a session off this host, its ticket's newest gate per repo. */
  async #gatesOf(
    session: SessionRow,
    local: boolean,
  ): Promise<Result<GateRow[]>> {
    const { db } = this.#deps;
    if (session.gate_id !== null) {
      const gate = await getGate(db, session.gate_id);
      return gate.ok ? ok([gate.value]) : gate;
    }
    if (local || session.ticket_id === null) return ok([]);
    const gates = await listTicketGates(db, session.ticket_id);
    return gates.ok ? ok(latestPerRepo(gates.value)) : gates;
  }

  async #worktreeDiff(sessionId: string, w: WorktreeRow): Promise<RepoDiff> {
    const facts: RepoFacts = {
      repo_id: w.repo_id,
      worktree_id: w.id,
      branch: w.branch,
      base_sha: w.base_sha,
      head_sha: w.head_sha,
      gate: null,
    };
    if (GONE.has(w.state))
      return unavailable(facts, `worktree ${w.id} is ${w.state}`);
    if (!SHA.test(w.base_sha))
      return unavailable(facts, `worktree ${w.id} has no usable base sha`);
    const where = await locateWorktree(
      { ...w, executor_kind: "local" },
      this.#deps.workRoot,
    );
    if (!where.ok) return unavailable(facts, where.detail);
    const run = (args: readonly string[]) =>
      this.#git(where.root, args, GIT_TIMEOUT_MS);
    // Against the base: committed, staged and unstaged changes to tracked files. Prefixes are fixed
    // and external diff drivers and textconv are off, whatever the user's or the repo's git config says.
    const patch = await run([
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-relative",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      w.base_sha,
      "--",
    ]);
    if (!patch.ok) return unavailable(facts, patch.detail);
    const untracked = await run([
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
    ]);
    if (!untracked.ok) return unavailable(facts, untracked.detail);
    const head = await run(["rev-parse", "--verify", "--quiet", "HEAD"]);
    return this.#patched(
      { ...facts, head_sha: head.ok ? head.stdout.trim() : w.head_sha },
      patch.stdout,
      untracked.stdout.split("\0").filter((path) => path !== ""),
      () => this.#keep(sessionId, w.id, patch.stdout),
    );
  }

  async #gateDiff(gate: GateRow): Promise<RepoDiff> {
    const facts = gateFacts(gate);
    const path = diffPatchOf(gate);
    if (path === null)
      return unavailable(facts, `gate ${gate.id} has no ${DIFF_PATCH} yet`);
    const { artifactsDir } = this.#deps;
    if (artifactsDir === null)
      return unavailable(
        facts,
        `${DIFF_PATCH} files are not served: set FRM_HOME`,
      );
    if (!PATH_ID.test(gate.id))
      return unavailable(facts, `not a gate id: ${JSON.stringify(gate.id)}`);
    const read = await readWithin(join(artifactsDir, "gates", gate.id), path);
    if (!read.ok) return unavailable(facts, read.error.message);
    return this.#patched(facts, read.value.text, [], () =>
      Promise.resolve(read.value.path),
    );
  }

  async #patched(
    facts: RepoFacts,
    text: string,
    untracked: readonly string[],
    keep: () => Promise<string | null>,
  ): Promise<RepoDiff> {
    const capped = capPatch(text);
    const files = diffFiles(text);
    return {
      ...facts,
      files: files.slice(0, SESSION_DIFF_MAX_FILES),
      files_total: files.length,
      untracked: untracked.slice(0, SESSION_DIFF_MAX_FILES),
      untracked_total: untracked.length,
      patch: { ...capped, full_path: capped.truncated ? await keep() : null },
      unavailable: null,
    };
  }

  /** The whole patch under `<runtime>/sessions/<id>/diffs/`, named by its hash; null if it cannot be kept. */
  async #keep(
    sessionId: string,
    worktreeId: string,
    text: string,
  ): Promise<string | null> {
    const { runtimeDir } = this.#deps;
    if (
      runtimeDir === null ||
      !PATH_ID.test(sessionId) ||
      !PATH_ID.test(worktreeId)
    )
      return null;
    const dir = join(runtimeDir, "sessions", sessionId, "diffs");
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const file = join(dir, `${worktreeId}-${hash}.patch`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(file, text, { mode: 0o600, flag: WRITE_NO_SYMLINK });
      return file;
    } catch (cause) {
      log.warn(
        `cannot keep the full diff of session ${sessionId}, worktree ${worktreeId}, at ${file}: ${String(cause)}`,
      );
      return null;
    }
  }
}
