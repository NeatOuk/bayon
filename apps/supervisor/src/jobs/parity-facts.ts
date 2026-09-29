// The parity_check job's facts: the workspace's rows out of the database, and the
// commits its mirrors hold out of git. Read-only throughout -- it never fetches, never writes a
// row, and never touches a worktree's contents: what a mirror does not already hold is a finding,
// not something to go and get. `packages/core`'s `parityFindings` does every judgement; this file
// only gathers, so the rules stay table-testable and this stays a walk.
//
// It runs on `local` (the supervisor's own host): the mirrors and the database are here, and a
// container cannot see either.
import { spawn } from "node:child_process";
import {
  err,
  joinRel,
  ok,
  workspaceLayout,
  type ParityFacts,
  type ParityGitlink,
  type ParityWorktree,
  type Result,
  type ReviewFinding,
} from "@bayon/core";
import {
  getSession,
  getTicket,
  getWorkspace,
  getWorkspaceRepos,
  listTicketWorktrees,
  type Db,
  type TicketWorktree,
  type WorkspaceRepo,
} from "@bayon/db";
import { GIT_ENV_FLOOR, safeGitArgs } from "@bayon/executors";
import type { Exited } from "../lifecycle/exec.js";
import { frmError } from "../lifecycle/errors.js";
import { readNode, type MirrorGit } from "../lifecycle/workspace-plan.js";

/** A worktree the gate looks at: work in progress, not one that has been cleaned up (§9.2). */
const PINNABLE = ["active", "idle"];

/**
 * The deepest submodule tree the walk descends. A declared repo may legitimately appear at more
 * than one path, so the bound is on nodes visited, not on repos; past it the walk stops and says
 * so rather than running the mirrors for an unbounded time on a hostile tree.
 */
export const MAX_PARITY_NODES = 256;

/** The most stdout one git read may print before it is killed: a hostile tree can be large. */
export const MAX_GIT_STDOUT = 4_000_000;

/**
 * git against one of this host's mirrors, to its exit whatever its code. The flags and the env
 * floor are packages/executors', the same ones every other git in the daemon runs with.
 * The job runs on the supervisor's own host, so it spawns git directly rather than going through an
 * executor: there is no other host in the picture.
 */
export const hostMirrorGit = (): MirrorGit => (gitDir, args, signal) =>
  new Promise((resolve) => {
    const child = spawn("git", safeGitArgs(["-C", gitDir, ...args]), {
      env: { ...process.env, ...GIT_ENV_FLOOR },
      signal,
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const done = (exited: Exited): void => {
      resolve({ ok: true, value: exited });
    };
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length > MAX_GIT_STDOUT) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (e: Error) => {
      done({ code: null, stdout, stderr: `${stderr}${e.message}` });
    });
    child.on("close", (code) => {
      done({ code, stdout, stderr, ...(overflow ? { overflow: true } : {}) });
    });
  });

export interface ParityGathered {
  readonly facts: ParityFacts;
  /** Findings the walk itself produced: a node that could not be read at all. */
  readonly findings: readonly ReviewFinding[];
  /** The ticket and workspace the facts are of, for the job's log line. */
  readonly ticketId: string;
  readonly workspaceId: string;
}

export interface GatherInput {
  readonly db: Db;
  /** git on the supervisor's own mirrors, to its exit whatever its code. */
  readonly git: MirrorGit;
  /** The job's own session: its ticket is what is checked. */
  readonly sessionId: string;
  /**
   * The commit the gate pinned, and the repo it is of (H1). This is the subject: the
   * ticket's work, as `pinSubject` read it out of the builder's worktree and as `fetchedBack` put
   * it into this host's mirror. It is passed in rather than read back off `worktrees` because
   * `worktrees.head_sha` has **no writer** anywhere in this repo — `001_spine.sql` declares it
   * nullable, `schema-columns.ts` types it for inserts, and every `insertWorktree` call site sets
   * `base_sha` alone — so a walk from the rows would describe the tree the ticket started from and
   * certify it as the ticket's work.
   *
   * Every other repo of a multi workspace still falls back to its `base_sha`: nothing records
   * their heads either, and the pin holds one repo. A finding names which it looked at (`which`),
   * so a base-only answer says so rather than passing itself off as the head.
   */
  readonly pinned: { readonly repoId: string; readonly sha: string };
  readonly signal: AbortSignal;
}

const problem = (summary: string, detail: string): ReviewFinding => ({
  severity: "blocker",
  summary,
  file: null,
  line: null,
  category: "parity",
  detail_md: detail,
});

/** Whether `mirror` already holds `sha` as a commit. Never fetches (Invariant: read-only). */
async function holds(
  i: GatherInput,
  mirror: string,
  sha: string,
): Promise<boolean> {
  const ran = await i.git(
    mirror,
    ["cat-file", "-e", `${sha}^{commit}`],
    i.signal,
  );
  return ran.ok && ran.value.code === 0;
}

/** The newest pinnable worktree of each repo, by repo id. */
function newestByRepo(
  rows: readonly TicketWorktree[],
): ReadonlyMap<string, TicketWorktree> {
  const byRepo = new Map<string, TicketWorktree>();
  for (const w of rows) {
    if (PINNABLE.includes(w.state)) byRepo.set(w.repo_id, w);
  }
  return byRepo;
}

/** Rule 1's facts: each repo's worktree commit, and whether its mirror holds it. */
async function worktreeFacts(
  i: GatherInput,
  repos: readonly WorkspaceRepo[],
  rows: readonly TicketWorktree[],
): Promise<ParityWorktree[]> {
  const byRepo = newestByRepo(rows);
  const facts: ParityWorktree[] = [];
  for (const repo of repos) {
    const wt = byRepo.get(repo.id);
    if (wt === undefined) continue; // rule 1 reports the absence; there is nothing to read
    // The gate's pin for the repo it pinned; the row's own head only if something ever wrote one.
    const pinned = repo.id === i.pinned.repoId;
    const sha = pinned ? i.pinned.sha : (wt.head_sha ?? wt.base_sha);
    facts.push({
      repoId: repo.id,
      sha,
      which: pinned || wt.head_sha !== null ? "head" : "base",
      inMirror: await holds(i, repo.mirror_path, sha),
    });
  }
  return facts;
}

interface Node {
  readonly mirror: string;
  readonly repoId: string;
  readonly sha: string;
  /** From the superproject's root; "" for the superproject itself. */
  readonly prefix: string;
}

interface Walked {
  readonly gitmodulePaths: string[];
  readonly gitlinks: ParityGitlink[];
  readonly findings: ReviewFinding[];
  /**
   * Every node the workspace declares was read. False when one could not be (its mirror lacks the
   * commit, its `.gitmodules` is malformed, or the walk hit its bound): rule 3 then compares
   * nothing, because half a tree's `.gitmodules` against the whole declaration would report every
   * unread submodule as a drifted declaration — a finding about this job's own blind spot rather
   * than about the workspace. The gitlink findings still stand: those are what was actually seen.
   */
  complete: boolean;
}

/**
 * The submodule tree from the superproject's commit down, read from the mirrors alone (§3.3): every
 * `.gitmodules` path and every gitlink, each resolved against `workspace_repos.submodule_path`.
 *
 * Paths grow strictly as it descends, so the walk terminates; MAX_PARITY_NODES bounds it anyway. A
 * node that cannot be read becomes a blocker finding and is not descended into, so one bad node
 * never hides the rest of the tree. A gitlink no repo declares is a finding, not an incompleteness:
 * there is no mirror to descend into, and rule 3 is exactly what names it.
 */
async function walk(
  i: GatherInput,
  root: Node,
  repos: readonly WorkspaceRepo[],
): Promise<Walked> {
  const out: Walked = {
    gitmodulePaths: [],
    gitlinks: [],
    findings: [],
    complete: true,
  };
  const queue: Node[] = [root];
  let visited = 0;
  for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
    visited += 1;
    if (visited > MAX_PARITY_NODES) {
      out.complete = false;
      out.findings.push(
        problem(
          `the submodule tree is deeper than ${String(MAX_PARITY_NODES)} repositories`,
          "The walk stopped: a workspace this deep is a configuration mistake, and reading it all would hold the mirrors open indefinitely (§3.3).",
        ),
      );
      return out;
    }
    const read = await readNode(
      i.git,
      node.mirror,
      node.repoId,
      node.sha,
      node.prefix,
      i.signal,
    );
    if (!read.ok) {
      out.complete = false;
      out.findings.push(
        problem(
          `repo ${node.repoId} at ${node.sha.slice(0, 12)} could not be read from its mirror`,
          `${read.error.message}\n\nThe submodules below ${JSON.stringify(node.prefix)} were not checked.`,
        ),
      );
      continue;
    }
    for (const entry of read.value.entries) {
      out.gitmodulePaths.push(joinRel(node.prefix, entry.path));
    }
    for (const [rel, sha] of read.value.gitlinks) {
      const path = joinRel(node.prefix, rel);
      const child = repos.find((r) => r.submodule_path === path);
      const inMirror =
        child !== undefined && (await holds(i, child.mirror_path, sha));
      out.gitlinks.push({
        path,
        sha,
        repoId: child?.id ?? null,
        inMirror,
      });
      if (child === undefined) continue; // a finding, and no mirror to descend into
      if (!inMirror) {
        out.complete = false; // the tree below it was never read
        continue;
      }
      queue.push({
        mirror: child.mirror_path,
        repoId: child.id,
        sha,
        prefix: path,
      });
    }
  }
  return out;
}

/**
 * Every fact `parityFindings` reads, for the ticket of `sessionId`. A session with no ticket, a
 * ticket with no workspace or a workspace whose rows are not a valid layout is an error, not a
 * finding: the gate then fails `reviewer_error` and the operator sees why, rather than the ticket
 * collecting a blocker it cannot act on.
 */
export async function gatherParity(
  i: GatherInput,
): Promise<Result<ParityGathered>> {
  const session = await getSession(i.db, i.sessionId);
  if (!session.ok) return session;
  const ticketId = session.value.ticket_id;
  if (ticketId === null) {
    return err(
      frmError("validation", `session ${i.sessionId} works no ticket`),
    );
  }
  const ticket = await getTicket(i.db, ticketId);
  if (!ticket.ok) return ticket;
  const workspaceId = ticket.value.workspace_id;
  if (workspaceId === null) {
    return err(
      frmError("validation", `ticket ${ticketId} has no workspace to check`),
    );
  }
  const workspace = await getWorkspace(i.db, workspaceId);
  if (!workspace.ok) return workspace;
  const repos = await getWorkspaceRepos(i.db, workspaceId);
  if (!repos.ok) return repos;
  const layout = workspaceLayout(workspace.value.kind, repos.value);
  if (!layout.ok) return layout;
  const rows = await listTicketWorktrees(i.db, ticketId);
  if (!rows.ok) return rows;

  const worktrees = await worktreeFacts(i, repos.value, rows.value);
  const primary = worktrees.find((w) => w.repoId === layout.value.primary.id);
  // Only a submodule workspace has a tree to walk, and only from a commit the mirror holds.
  const walked =
    layout.value.kind === "submodule" &&
    primary !== undefined &&
    primary.inMirror
      ? await walk(
          i,
          {
            mirror: layout.value.primary.mirror_path,
            repoId: layout.value.primary.id,
            sha: primary.sha,
            prefix: "",
          },
          repos.value,
        )
      : null;
  return ok({
    ticketId,
    workspaceId,
    findings: walked?.findings ?? [],
    facts: {
      kind: layout.value.kind,
      repos: repos.value.map((r) => ({
        repoId: r.id,
        submodulePath: r.submodule_path,
      })),
      worktrees,
      gitmodulePaths:
        walked === null || !walked.complete ? null : walked.gitmodulePaths,
      gitlinks: walked?.gitlinks ?? [],
    },
  });
}
