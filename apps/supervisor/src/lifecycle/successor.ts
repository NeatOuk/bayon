// M2-c (§7.3, §9.2; plan rule 3): a spawn carrying `handoff_id` takes over its
// predecessor's worktrees and branch, one per repo of a multi-repo workspace. Resolve refuses unless
// the hand-off is pending, its predecessor has ended, every worktree is still on disk and the set
// holds the workspace's primary (by role, rootsOf), and re-renders the packet from the row. The
// workspace step moves the rows (reassignWorktrees: all or none), never a second `git worktree add`
// (git refuses one branch in two worktrees), then re-writes `.foreman/handoff-<n>.md` in the
// primary's worktree through the executor. Run 1 carries the packet directly under the mission.
// Owning the ticket stays handoff_accept's. A chain that never had a worktree (its holder died
// before its workspace step) is placed afresh: the ticket's whole workspace, every repo, the packet
// written into the new primary's worktree.
import { join } from "node:path";
import {
  HandoffFacts,
  HandoffQuality,
  err,
  ok,
  rootsOf,
  type ErrorClass,
  type Result,
  type WorkspaceLayout,
} from "@bayon/core";
import {
  ENDED_STATES,
  countHandoffWorktreeRows,
  getHandoff,
  getSession,
  getTicket,
  getWorkspaceRepos,
  listHandoffWorktrees,
  listPendingHandoffs,
  type HandoffRow,
  type HeldWorktree,
  type TicketRow,
} from "@bayon/db";
import { reassignWorktrees } from "@bayon/db/supervisor";
import type { Executor } from "@bayon/executors";
import type { Ctx } from "./context.js";
import { frmError } from "./errors.js";
import { exitedOk, runArgv } from "./exec.js";
import { writePacketFile } from "./packet-file.js";
import { judgementOf, packetNumber, renderRow } from "./packet-render.js";
import type { SessionSpawnPayload } from "./payloads.js";
import type { RunRequest } from "./prompt.js";
import type { InternalWorkspace } from "./resolve.js";
import type { DoctrineSet, Workspace } from "./workspace.js";
import type { CheckedRepo } from "./workspace-plan.js";

/** What a successor takes over, checked at resolve: any refusal fails the spawn command. */
export interface Successor {
  readonly handoff: HandoffRow;
  /** The session that wrote the hand-off. */
  readonly predecessorId: string;
  /**
   * The primary's worktree it takes over (its cwd), from the ended session holding it now. Null:
   * the chain never had one, so the successor is placed as a fresh spawn in the ticket's workspace,
   * every repo of it.
   */
  readonly worktree: HeldWorktree | null;
  /** Every worktree it takes over, one per repo, the primary's among them; none when null. */
  readonly worktrees: readonly HeldWorktree[];
  readonly ticket: TicketRow;
  /** The packet re-rendered from the row: the file's bytes and run 1's `handoff_packet`. */
  readonly packet: string;
}

const refuse = (cls: ErrorClass, message: string): Result<never> =>
  err(frmError(cls, message));

const ended = (state: string): boolean =>
  (ENDED_STATES as readonly string[]).includes(state);

/** The spawn's successor, or null without `handoff_id`. Reads only, git included. */
export async function resolveSuccessor(
  ctx: Ctx,
  p: SessionSpawnPayload,
  workspace: InternalWorkspace | undefined,
): Promise<Result<Successor | null>> {
  const want =
    typeof workspace === "object" && "inherit" in workspace
      ? workspace.inherit
      : undefined;
  if (p.handoff_id === undefined) {
    return want === undefined
      ? ok(null)
      : refuse(
          "validation",
          "an inherited worktree comes with its hand-off: set payload.handoff_id",
        );
  }
  if (workspace === "none") {
    return refuse(
      "validation",
      `hand-off ${p.handoff_id}: a successor works in its predecessor's worktree, not none`,
    );
  }
  const h = await pendingHandoff(ctx, p.handoff_id);
  if (!h.ok) return h;
  const { id, ticket_id, from_session_id: from } = h.value;
  if (p.ticket_id !== ticket_id) {
    return refuse(
      "validation",
      `hand-off ${id} is ticket ${ticket_id}'s, not ${p.ticket_id ?? "no ticket"}'s`,
    );
  }
  if (from === null) {
    return refuse("validation", `hand-off ${id} has no predecessor session`);
  }
  const predecessor = await getSession(ctx.db, from);
  if (!predecessor.ok) return predecessor;
  if (!ended(predecessor.value.state)) {
    return refuse(
      "conflict",
      `predecessor ${from} is still ${predecessor.value.state}: it must end before a successor takes its worktree`,
    );
  }
  const held = await heldWorktrees(ctx, h.value, from, want?.worktreeId);
  if (!held.ok) return held;
  const ticket = await getTicket(ctx.db, ticket_id);
  if (!ticket.ok) return ticket;
  const packet = rerender(ctx, h.value);
  if (!packet.ok) return packet;
  return ok({
    handoff: h.value,
    predecessorId: from,
    worktree: held.value?.primary ?? null,
    worktrees: held.value?.all ?? [],
    ticket: ticket.value,
    packet: packet.value,
  });
}

/** The hand-off, if the one pending predicate (wherePendingHandoff) lists it. */
async function pendingHandoff(
  ctx: Ctx,
  id: string,
): Promise<Result<HandoffRow>> {
  const h = await getHandoff(ctx.db, id);
  if (!h.ok) return h;
  const pending = await listPendingHandoffs(ctx.db, h.value.ticket_id);
  if (!pending.ok) return pending;
  return pending.value.some((row) => row.id === id)
    ? h
    : refuse(
        "conflict",
        `hand-off ${id} is not pending: it was accepted, or is still being written`,
      );
}

/**
 * The worktrees the hand-off's chain holds: one holder, ended; each directory there; at most one
 * per repo; the workspace's primary among them. Null when the chain never
 * had one.
 */
async function heldWorktrees(
  ctx: Ctx,
  h: HandoffRow,
  from: string,
  want: string | undefined,
): Promise<
  Result<{
    readonly primary: HeldWorktree;
    readonly all: HeldWorktree[];
  } | null>
> {
  const rows = await listHandoffWorktrees(ctx.db, {
    id: h.id,
    from_session_id: from,
  });
  if (!rows.ok) return rows;
  const [w] = rows.value;
  if (w === undefined) return neverHadOne(ctx, h, from, want);
  if (new Set(rows.value.map((row) => row.holder_id)).size > 1) {
    return refuse(
      "validation",
      `hand-off ${h.id}'s worktrees are held by more than one session`,
    );
  }
  if (want !== undefined && !rows.value.some((row) => row.id === want)) {
    return refuse(
      "validation",
      `hand-off ${h.id}'s worktree is ${rows.value.map((row) => row.id).join(", ")}, not ${want}`,
    );
  }
  if (!ended(w.holder_state)) {
    return refuse(
      "conflict",
      `worktree ${w.id} is held by ${w.holder_id}, still ${w.holder_state}`,
    );
  }
  for (const row of rows.value) {
    const there = await onDisk(ctx, row);
    if (!there.ok) return there;
  }
  const repos = await getWorkspaceRepos(ctx.db, w.workspace_id);
  if (!repos.ok) return repos;
  const roots = rootsOf(rows.value, repos.value, { pinned: false });
  if (!roots.ok) {
    return refuse("validation", `hand-off ${h.id}: ${roots.error.message}`);
  }
  const primary = rows.value.find((row) => row.path === roots.value?.cwd);
  return primary === undefined
    ? refuse("validation", `hand-off ${h.id} holds no worktree of its primary`)
    : ok({ primary, all: rows.value });
}

/**
 * No worktree to take over: a chain that never had a row is placed afresh (null); one whose rows
 * are only merged or removed still refuses, as does an internal spawn asking for a given one.
 */
async function neverHadOne(
  ctx: Ctx,
  h: HandoffRow,
  from: string,
  want: string | undefined,
): Promise<Result<null>> {
  if (want !== undefined) {
    return refuse(
      "validation",
      `hand-off ${h.id} has no worktree ${want} to inherit`,
    );
  }
  const ever = await countHandoffWorktreeRows(ctx.db, {
    id: h.id,
    from_session_id: from,
  });
  if (!ever.ok) return ever;
  return ever.value === 0
    ? ok(null)
    : refuse(
        "not_found",
        `the predecessor's worktree is missing: ${from} left none for hand-off ${h.id}`,
      );
}

/** Its `.git` link is still there, seen through the executor it lives on (a remote one too). */
async function onDisk(ctx: Ctx, w: HeldWorktree): Promise<Result<void>> {
  const executor = ctx.executors.get(w.holder_executor_id)?.executor;
  if (executor === undefined) {
    return refuse(
      "validation",
      `executor ${w.holder_executor_id}, where worktree ${w.id} lives, is not loaded`,
    );
  }
  const what = `test ${w.path}`;
  const found = exitedOk(
    await runArgv(ctx, executor, ["test", "-e", join(w.path, ".git")], {
      what,
    }),
    what,
  );
  return found.ok
    ? ok(undefined)
    : refuse(
        "not_found",
        `the predecessor's worktree ${w.path} is missing: ${found.error.message}`,
      );
}

/** The row's packet, rendered again: the same row gives the same bytes. */
function rerender(ctx: Ctx, h: HandoffRow): Result<string> {
  const facts = HandoffFacts.safeParse(parseJson(h.facts_json));
  const quality = HandoffQuality.safeParse(h.quality);
  if (!facts.success || !quality.success) {
    return refuse(
      "internal",
      `hand-off ${h.id}: its facts or quality do not parse`,
    );
  }
  const r = renderRow(ctx, {
    id: h.id,
    n: packetNumber(h),
    reason: h.reason,
    phase: h.phase_from,
    quality: quality.data,
    facts: facts.data,
    judgement: judgementOf(h),
    verified: quality.data === "full",
    why: facts.data.why ?? "",
  });
  if (r.packet_hash !== h.packet_hash) {
    ctx.log.warn(
      { handoffId: h.id },
      "the packet does not re-render to its packet_hash (a setting changed since): the file gets the re-render",
    );
  }
  return ok(r.text);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Where a successor runs: its worktree's workspace, on the executor the worktree lives on. */
export function successorPlace(
  p: SessionSpawnPayload,
  s: Successor,
  w: HeldWorktree,
): Result<{ readonly workspaceId: string; readonly executorId: string }> {
  const clash = (what: string, asked: string | undefined, is: string) =>
    asked === undefined || asked === is
      ? null
      : `${what} ${asked} was asked, but the worktree is on ${is}`;
  const why =
    clash("workspace", p.workspace_id, w.workspace_id) ??
    clash("executor", p.executor_id, w.holder_executor_id);
  return why === null
    ? ok({ workspaceId: w.workspace_id, executorId: w.holder_executor_id })
    : refuse("validation", `hand-off ${s.handoff.id}: ${why}`);
}

/**
 * The workspace step of a successor: every worktree row moves to it at once, then the packet file
 * is re-written from the row in the primary's worktree through the executor, so it matches
 * packet_hash even if the worktree was touched. No fetch, no `git worktree add`: each branch stays
 * checked out where it is.
 */
export async function inheritWorktrees(
  ctx: Ctx,
  sessionId: string,
  s: Successor,
  w: HeldWorktree,
  executor: Executor,
  layout: WorkspaceLayout<CheckedRepo>,
): Promise<Result<Workspace>> {
  const moved = await reassignWorktrees(ctx.db, {
    ids: s.worktrees.map((row) => row.id),
    from_session_id: w.holder_id,
    to_session_id: sessionId,
  });
  if (!moved.ok) return moved;
  ctx.log.info(
    {
      sessionId,
      handoffId: s.handoff.id,
      from: w.holder_id,
      paths: s.worktrees.map((row) => row.path),
    },
    "worktrees inherited",
  );
  await writeLogged(ctx, sessionId, s, executor, w.path);
  const repos = [layout.primary, ...layout.extras];
  const roots = rootsOf(s.worktrees, repos, { pinned: false });
  if (!roots.ok) return roots;
  const extraRoots = roots.value?.extraRoots ?? [];
  const doctrine = [w.path, ...extraRoots].flatMap((path): DoctrineSet[] => {
    const row = s.worktrees.find((held) => held.path === path);
    const repo = repos.find((r) => r.id === row?.repo_id);
    return repo === undefined
      ? []
      : [
          {
            prefix: path === w.path ? "" : repo.rel_path,
            root: path,
            paths: repo.doctrine,
          },
        ];
  });
  return ok({ cwd: w.path, extraRoots, baseSha: w.base_sha, doctrine });
}

/**
 * A successor placed afresh (its chain never had a worktree): its packet goes into
 * its own new worktree, where an inherited one would have had it. Run 1 carries it either way.
 */
export async function writeFreshPacket(
  ctx: Ctx,
  sessionId: string,
  s: Successor,
  executor: Executor,
  dir: string,
): Promise<void> {
  ctx.log.info(
    { sessionId, handoffId: s.handoff.id, dir },
    "a successor placed afresh: its chain never had a worktree",
  );
  await writeLogged(ctx, sessionId, s, executor, dir);
}

async function writeLogged(
  ctx: Ctx,
  sessionId: string,
  s: Successor,
  executor: Executor,
  dir: string,
): Promise<void> {
  const written = await writePacketFile(
    ctx,
    executor,
    dir,
    s.handoff.packet_path,
    s.packet,
  );
  if (!written.ok) {
    ctx.log.warn(
      { sessionId, error: written.error },
      "cannot write the packet file; run 1 carries the packet",
    );
  }
}

/** An internal spawn's own run 1, with the packet in its template's handoff_packet section. */
export function withPacket(run: RunRequest, s: Successor): Result<RunRequest> {
  return run.template.sections.some((x) => x.name === "handoff_packet")
    ? ok({ ...run, inputs: { ...run.inputs, handoff_packet: s.packet } })
    : refuse(
        "validation",
        `template ${run.template.name} has no hand-off packet section: a successor's run 1 carries the packet`,
      );
}
