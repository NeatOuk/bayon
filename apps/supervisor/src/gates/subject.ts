// Pinning a gate's subject: the builder's worktree of the gate's
// repo, its head, the base branch's tip fetched under the mirror's queue, base = merge-base(tip,
// head): exactly the PR's diff. A repo-less diff gate whose ticket's worktrees span repos is refused
// (H3); a submodule workspace's gitlinks at head must be in their mirrors (H1). The diff goes to the
// gate's artifacts before any reviewer starts. Drift is judged by the caller.
//
// The worktree is read through its own executor: a builder on a container has its
// worktree there, not on this host, and its commits live only in that clone — so the pinned head is
// fetched back into the supervisor's mirror under the gate's pin ref before anything is described.
// Everything after that point runs on the supervisor's own mirror, whatever the builder ran on, so
// a container subject's evidence is the same evidence a local one's is.
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { childrenOf, err, ok, type Result } from "@bayon/core";
import {
  getWorkspaceRepos,
  listTicketWorktrees,
  type Db,
  type TicketRow,
  type TicketWorktree,
} from "@bayon/db";
import { LOCAL_EXECUTOR_ID } from "../boot.js";
import { originGitAuth } from "../forge/credential.js";
import { asFrmError, frmError } from "../lifecycle/errors.js";
import { mirrorKey } from "../lifecycle/mirror.js";
import { publishSubmodules } from "../lifecycle/publish-submodules.js";
import type { KeyedQueue } from "../lifecycle/session-queue.js";
import { executorMirrorGit } from "../lifecycle/workspace.js";
import {
  baseRefOf,
  ensureCommit,
  fetchBase,
  loadLayout,
  readNode,
  withGitAuth,
  type MirrorGit,
} from "../lifecycle/workspace-plan.js";
import type { SecretStore } from "../lifecycle/secrets.js";
import { git, gitRaw, type GitCtx } from "./git.js";

export interface Pin {
  readonly repoId: string;
  readonly workspaceId: string;
  readonly mirror: string;
  /** The base branch as the mirror names it: refs/remotes/origin/<b>, or refs/heads/<b>. */
  readonly baseRef: string;
  readonly base: string;
  readonly head: string;
  /** The base branch's tip at pin: base ≠ tip is drift (§13.2). */
  readonly tip: string;
  readonly files: readonly string[];
  /** `git diff --stat`, at most STAT_LINES lines: the review prompt's summary of the change. */
  readonly stat: string;
  /** plan_review: the plan at head; null otherwise or when it cannot be read. */
  readonly planText: string | null;
  readonly diffPath: string;
  /** plan_review (N2): the ticket's other repos' changed files, each against its worktree's base. */
  readonly others: readonly {
    readonly repoId: string;
    readonly files: readonly string[];
  }[];
  /** The executor the subject was built on: where its reviewer goes unless a binding says otherwise
   *. */
  readonly executorId: string;
}

export interface PinInput {
  readonly db: Db;
  /** git on the supervisor's own host: the mirrors, the diff, the log. */
  readonly git: GitCtx;
  /** git on the executor holding a worktree, for the reads that must happen where it lives. */
  readonly gitOn: (executorId: string) => Result<GitCtx>;
  readonly ticket: TicketRow;
  readonly gateId: string;
  readonly kind: string;
  /** The gate's repo; null for a repo-less gate. */
  readonly repoId: string | null;
  /** gates.subject_kind: a `diff` gate is held to one repo (H3). */
  readonly subjectKind: string;
  readonly artifactsDir: string;
  readonly mirrors: KeyedQueue;
  /** The host secret store, for a private origin's forge token. Omitting it silently
   * means no forge token for private-origin fetches, not an error. */
  readonly secrets?: SecretStore;
}

/** Git on the supervisor's mirrors, offering `originUrl` its forge token when the rule allows one. */
const originMirrorGit = async (
  i: PinInput,
  originUrl: string | null,
): Promise<MirrorGit> =>
  withGitAuth(
    executorMirrorGit(i.git.exec, i.git.executor),
    await originGitAuth(i.secrets, originUrl),
  );

const STAT_LINES = 200;
const REF_NAME = /^(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const PINNABLE = ["active", "idle"];
/** M1: a .gitmodules `ignore=` never hides a gitlink change. */
const SEE_SUBMODULES = "--ignore-submodules=none";

const unpinnable = (message: string): Result<never> =>
  err(frmError("validation", message));

/**
 * The ticket's active or idle worktrees (as the API's git-facts), wherever they sit: a builder on a
 * container is the normal case on a server deployment, where the local executor's trust refuses
 * every work role, and holding this to `local` refused every diff gate there.
 */
const pinnable = (rows: readonly TicketWorktree[]): TicketWorktree[] =>
  rows.filter((w) => PINNABLE.includes(w.state));

/** Where a worktree is read: its session's executor, or this host for a row without one. */
const executorOf = (w: TicketWorktree): string =>
  w.executor_id ?? LOCAL_EXECUTOR_ID;

/**
 * The worktree a gate pins: its repo's newest, or for a repo-less gate the primary's (by role).
 * A repo-less diff gate on a ticket whose worktrees span repos is refused (H3): each repo would
 * otherwise pass unreviewed on the primary's diff.
 *
 * Normally unreachable since an earlier change: the `code_review` transition records the repos the ticket
 * touches in `ticket_repos`, so its round opens a gate per repo and each names its own. What is
 * left here is the case no round can cover — worktrees spanning repos with nothing recorded, which
 * is a ticket whose repos have no commits at all, or a gate opened before that writer existed.
 */
async function subjectWorktree(
  i: PinInput,
  rows: readonly TicketWorktree[],
): Promise<Result<TicketWorktree>> {
  const live = pinnable(rows);
  const newest = live.at(-1);
  if (newest === undefined) {
    return unpinnable(`ticket ${i.ticket.id} has no active or idle worktree`);
  }
  if (i.repoId !== null) {
    const own = live.findLast((w) => w.repo_id === i.repoId);
    return own === undefined
      ? unpinnable(
          `ticket ${i.ticket.id} has no active or idle worktree of repo ${i.repoId}`,
        )
      : ok(own);
  }
  const repos = new Set(live.map((w) => w.repo_id));
  if (repos.size > 1 && i.subjectKind === "diff") {
    return unpinnable(
      `ticket ${i.ticket.id} has worktrees in ${repos.size} repos and no ticket_repos`,
    );
  }
  const declared = await getWorkspaceRepos(i.db, newest.workspace_id);
  if (!declared.ok) return declared;
  const primary = declared.value.find((r) => r.role === "primary")?.id;
  return ok(live.findLast((w) => w.repo_id === primary) ?? newest);
}

const insideRepo = (rel: string): boolean =>
  !isAbsolute(rel) && !rel.split(/[\\/]/).includes("..");

/**
 * An attribution trailer, by shape rather than by runner (Invariant 1: every harness spells its own
 * differently): a co-author line, or a trailer linking back to the agent's session. Anchored to the
 * start of a line — a trailer is `Key: value` — so a message that merely talks about one ("drop the
 * co-author trailer") is not itself a violation.
 */
const ATTRIBUTION = /^[ \t]*(?:co-authored-by|[\w-]*session)[ \t]*:/i;

/**
 * One `git log` record per commit: the sha, then its whole message, then a record separator. `%x1e`
 * is expanded by git into the 0x1E byte in its output — the separator can never be passed in argv
 * itself, since an argument may not contain a NUL and a message may contain any other byte.
 */
const LOG_FORMAT = "%H%n%B%x1e";
const RECORD = "";

/**
 * The commits in a `git log --format=LOG_FORMAT+RECORD` whose message carries an attribution
 * trailer, newest first, as `<short sha> <subject>`. Exported for its test: the parsing is the part
 * worth pinning.
 */
export function offendingCommits(log: string): readonly string[] {
  return log
    .split(RECORD)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .flatMap((record) => {
      const [sha = "", subject = "", ...rest] = record.split("\n");
      const carries = [subject, ...rest].some((line) => ATTRIBUTION.test(line));
      return carries ? [`${sha.slice(0, 12)} ${subject.trim()}`] : [];
    });
}

/**
 * a branch whose own commits attribute the work to the agent or its harness is refused
 * here, before any reviewer spawns — the same point a stale submodule gitlink is refused, and the
 * same rule the operator's merge script applies to a branch. The build, spike and fix prompts all
 * state the rule (WORKER_RULES), but a prompt only asks: a spawned runner is separately told by its
 * own harness to add a trailer, and that contest is what this ticket exists to settle.
 *
 * Takes the git context and the range rather than the whole pin: the argv it builds is the part that
 * has regressed before (a separator that cannot survive argv), so a test wants this seam against a
 * real repository, not a mocked one.
 */
export async function noAttributionTrailers(
  g: GitCtx,
  mirror: string,
  base: string,
  head: string,
): Promise<Result<void>> {
  const log = await gitRaw(g, mirror, [
    "log",
    `--format=${LOG_FORMAT}`,
    `${base}..${head}`,
  ]);
  if (!log.ok) return log;
  const offenders = offendingCommits(log.value);
  if (offenders.length === 0) return ok(undefined);
  return unpinnable(
    `${String(offenders.length)} commit(s) carry an attribution trailer, which this repository's doctrine forbids (Conventions): ${offenders.join("; ")}. Reword them and request review again.`,
  );
}

export async function pinSubject(i: PinInput): Promise<Result<Pin>> {
  const rows = await listTicketWorktrees(i.db, i.ticket.id);
  if (!rows.ok) return rows;
  const wt = await subjectWorktree(i, rows.value);
  if (!wt.ok) return wt;
  const repos = await getWorkspaceRepos(i.db, wt.value.workspace_id);
  if (!repos.ok) return repos;
  const repo = repos.value.find((r) => r.id === wt.value.repo_id);
  if (repo === undefined || !REF_NAME.test(repo.default_base_branch)) {
    return unpinnable(
      `repo ${wt.value.repo_id} is unknown or has an unsafe base branch`,
    );
  }
  const on = i.gitOn(executorOf(wt.value));
  if (!on.ok) return on;
  // The worktree is also the cwd: that is what routes the read into the session holding it.
  const head = await git(
    on.value,
    wt.value.path,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    wt.value.path,
  );
  if (!head.ok) return head;
  const baseRef = baseRefOf(repo);
  const tip = await i.mirrors.run(mirrorKey(repo.mirror_path), async () => {
    // `+refs/heads/<branch>:<baseRef>`, offering a private origin its forge token.
    const fetched = await fetchBase(
      await originMirrorGit(i, repo.origin_url),
      repo,
      new AbortController().signal,
    );
    // A failed fetch stays `internal` on the gate path, as it was before an earlier change.
    if (!fetched.ok) {
      // Its plain words are kept; the class is the gate path's own.
      return fetched.error.class === "spawn_failed" ||
        fetched.error.class === "repo_unreachable"
        ? err({ ...fetched.error, class: "internal" as const })
        : fetched;
    }
    return git(i.git, repo.mirror_path, [
      "rev-parse",
      "--verify",
      `${baseRef}^{commit}`,
    ]);
  });
  if (!tip.ok) return tip;
  const here = await fetchedBack(i, on.value, wt.value, repo, head.value);
  if (!here.ok) return here;
  // H1: after the superproject's queue is released, one child mirror's mutex at a time.
  const published = await submodulesPublished(
    i,
    on.value,
    wt.value,
    head.value,
  );
  if (!published.ok) return published;
  const others = await otherRepos(i, rows.value, wt.value);
  if (!others.ok) return others;
  return describe(i, {
    repoId: repo.id,
    workspaceId: wt.value.workspace_id,
    mirror: repo.mirror_path,
    baseRef,
    head: head.value,
    tip: tip.value,
    others: others.value,
    executorId: executorOf(wt.value),
  });
}

/**
 * The pinned head in the supervisor's own mirror. A worktree on this host is a linked
 * worktree of that mirror and its commits are already there; a worktree on an executor that keeps
 * its own mirrors is not on this host at all, so the commit is fetched out of that session's clone
 * under the gate's pin ref — which is also what keeps it from gc until the gate is done, and what
 * the reviewer's own clone is then pushed from.
 */
async function fetchedBack(
  i: PinInput,
  on: GitCtx,
  wt: TicketWorktree,
  repo: { readonly id: string; readonly mirror_path: string },
  head: string,
): Promise<Result<void>> {
  const { mirrors } = on.executor;
  if (mirrors === undefined) return ok(undefined);
  if (wt.session_id === null) {
    return unpinnable(
      `worktree ${wt.id} is on ${on.executor.id} and has no session: its commits cannot be fetched back`,
    );
  }
  const signal = AbortSignal.timeout(
    i.git.exec.settings["workspace.git_timeout_ms"],
  );
  const ref = `refs/frm/gate/${i.gateId}`;
  try {
    await i.mirrors.run(mirrorKey(repo.mirror_path), () =>
      mirrors.fetchFromSession({
        localMirror: repo.mirror_path,
        sessionId: wt.session_id ?? "",
        dir: wt.path,
        refspecs: [`+${head}:${ref}`],
        signal,
      }),
    );
  } catch (e) {
    // The executor rejects with FrmError *data*, which String() flattens to "[object Object]":
    // asFrmError keeps its class and message (the idiom in lifecycle/errors.js).
    const cause = asFrmError(
      e,
      "internal",
      `cannot fetch ${head} of repo ${repo.id} back from ${on.executor.id}`,
    );
    return err(
      frmError(
        "internal",
        `cannot fetch ${head} of repo ${repo.id} back from ${on.executor.id}: ${cause.message}`,
        cause,
      ),
    );
  }
  return ok(undefined);
}

/**
 * H1: every gitlink at `head` of a submodule workspace's superproject is a commit in its child's
 * mirror, fetched first as §3.3 does (the base, then every head, no --prune) under that mirror's
 * mutex. A builder's commit inside a submodule lives only in the worktree's modules/, so the
 * worktree's own frm/* branches are published into their mirrors first; what this still
 * refuses is a gitlink no repository here holds — and it refuses it before any reviewer spawns.
 *
 * `on` is git where the worktree lives: publishing runs there, and reads the mirrors here. A
 * submodule workspace built on a container publishes nothing (leaves that to the
 * sync-back), so its gitlinks are refused here rather than reviewed unreadable.
 *
 * A `workspace` subject publishes as usual but is never refused: the gate whose subject
 * is the workspace exists to *report* an unpublished gitlink as a finding an operator can read and
 * act on, and refusing its pin would turn that into `reviewer_error` — the gate's own answer lost
 * to the check that was meant to produce it.
 */
async function submodulesPublished(
  i: PinInput,
  on: GitCtx,
  wt: TicketWorktree,
  head: string,
): Promise<Result<void>> {
  const layout = await loadLayout(i.db, wt.workspace_id);
  if (!layout.ok) return layout;
  const { kind, primary, submodules } = layout.value;
  if (kind !== "submodule" || wt.repo_id !== primary.id) return ok(undefined);
  const up = await publishSubmodules(
    {
      db: i.db,
      exec: on.exec,
      executor: on.executor,
      mirrors: i.mirrors,
    },
    wt,
  );
  if (!up.ok) return up;
  if (i.subjectKind === "workspace") return ok(undefined);
  const g: MirrorGit = executorMirrorGit(i.git.exec, i.git.executor);
  const signal = new AbortController().signal;
  const declared = submodules.map((s) => ({
    repoId: s.id,
    path: s.submodule_path ?? "",
  }));
  const root = await readNode(
    g,
    primary.mirror_path,
    primary.id,
    head,
    "",
    signal,
  );
  if (!root.ok) return root;
  const first = childrenOf(root.value, declared);
  if (!first.ok) return first;
  const queue = [...first.value];
  for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
    const current = entry;
    const repo = submodules.find((s) => s.id === current.repoId);
    if (repo === undefined) {
      return unpinnable(
        `submodule ${current.path}: repo ${current.repoId} is gone`,
      );
    }
    const node = await i.mirrors.run(mirrorKey(repo.mirror_path), async () => {
      const origin = withGitAuth(
        g,
        await originGitAuth(i.secrets, repo.origin_url),
      );
      const present = await ensureCommit(origin, repo, current.sha, signal, {
        fetchBaseFirst: true,
      });
      if (!present.ok) return present;
      if (!present.value) {
        return unpinnable(
          `submodule commit ${current.sha} not published to mirror ${repo.mirror_path} (submodule ${current.path})`,
        );
      }
      return readNode(
        g,
        repo.mirror_path,
        repo.id,
        current.sha,
        current.path,
        signal,
      );
    });
    if (!node.ok) return node;
    const more = childrenOf(node.value, declared);
    if (!more.ok) return more;
    queue.push(...more.value);
  }
  return ok(undefined);
}

/**
 * plan_review (N2): the files each other repo's newest pinnable worktree changed against its
 * base, working tree included, for the no_source_changes re-check across every repo. Each is read
 * through its own executor — a working tree is only ever readable where it lives.
 */
async function otherRepos(
  i: PinInput,
  rows: readonly TicketWorktree[],
  wt: TicketWorktree,
): Promise<Result<Pin["others"]>> {
  if (i.kind !== "plan_review") return ok([]);
  const byRepo = new Map<string, TicketWorktree>();
  for (const w of pinnable(rows)) {
    if (w.repo_id !== wt.repo_id) byRepo.set(w.repo_id, w);
  }
  const others: { repoId: string; files: string[] }[] = [];
  for (const w of byRepo.values()) {
    const on = i.gitOn(executorOf(w));
    if (!on.ok) return on;
    const names = await gitRaw(
      on.value,
      w.path,
      ["diff", "--name-only", "--no-renames", SEE_SUBMODULES, w.base_sha],
      w.path,
    );
    if (!names.ok) return names;
    others.push({
      repoId: w.repo_id,
      files: names.value.split("\n").filter((line) => line.length > 0),
    });
  }
  return ok(others);
}

type Pinned = Pick<
  Pin,
  | "repoId"
  | "workspaceId"
  | "mirror"
  | "baseRef"
  | "head"
  | "tip"
  | "others"
  | "executorId"
>;

/** The merge base, the files, the stat, the plan, and diff.patch in the artifacts. */
async function describe(i: PinInput, p: Pinned): Promise<Result<Pin>> {
  const base = await git(i.git, p.mirror, ["merge-base", p.tip, p.head]);
  if (!base.ok) return base;
  const clean = await noAttributionTrailers(
    i.git,
    p.mirror,
    base.value,
    p.head,
  );
  if (!clean.ok) return clean;
  const range = [base.value, p.head];
  const names = await gitRaw(i.git, p.mirror, [
    "diff",
    "--name-only",
    "--no-renames",
    SEE_SUBMODULES,
    ...range,
  ]);
  if (!names.ok) return names;
  const stat = await gitRaw(i.git, p.mirror, [
    "diff",
    "--stat=120",
    SEE_SUBMODULES,
    ...range,
  ]);
  if (!stat.ok) return stat;
  const diff = await gitRaw(i.git, p.mirror, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    SEE_SUBMODULES,
    ...range,
  ]);
  if (!diff.ok) return diff;
  const diffPath = join(i.artifactsDir, "diff.patch");
  try {
    await mkdir(i.artifactsDir, { recursive: true, mode: 0o700 });
    await writeFile(diffPath, diff.value, { mode: 0o600 });
  } catch (e) {
    return err(frmError("internal", `cannot write ${diffPath}`, String(e)));
  }
  return ok({
    ...p,
    base: base.value,
    files: names.value.split("\n").filter((line) => line.length > 0),
    stat: stat.value.split("\n").slice(0, STAT_LINES).join("\n").trimEnd(),
    planText: await planAt(i, p),
    diffPath,
  });
}

/** plan_review's plan as committed at head, or null. */
async function planAt(i: PinInput, p: Pinned): Promise<string | null> {
  const path = i.ticket.plan_path;
  if (i.kind !== "plan_review" || path === null || !insideRepo(path))
    return null;
  const shown = await gitRaw(i.git, p.mirror, ["show", `${p.head}:${path}`]);
  return shown.ok ? shown.value : null;
}
