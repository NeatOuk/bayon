import {
  DELIVERABLE_STATUSES,
  DELIVERY_MOMENTS,
  DELIVERY_STATUSES,
  deliveryDue,
  err,
  ok,
  ticketKey,
  type DeliveryConfigFields,
  type Result,
} from "@bayon/core";
import { z } from "zod";
import {
  all,
  first,
  qb,
  read,
  readSnapshot,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { DeliveryRow } from "../schema-work.js";
import { deliveryConfigOf } from "./project-settings.js";
import { keyPrefix } from "./ticket-key.js";

// What the supervisor's delivery sweep reads (spike §1.2–§1.3). Two queries: the tickets
// that might be due, keyset-paged exactly as the machine sweep's candidates are, and everything one
// ticket's delivery needs — its project's switches, its repos in the order they must be pushed, the
// branch each is on, and what a previous run already reached.
//
// Nothing here writes, and nothing here decides: `deliveryDue` and the forge rules are core's.
//
// Both reads share one rule for "due" (the design §3): a ticket is due only
// if it reached its project's moment at or after the project's `delivery_since` — when delivery was
// last turned on (047). Turning delivery on used to make every finished ticket of the project's
// history due at once: a push and a pull request each. When it reached the moment is the time it
// entered the moment's set of statuses, read from `ticket_events` (every status write records one,
// in its own transaction) and never from `tickets.updated_at`, which any edit bumps. A ticket whose
// delivery began under the current mark (a `deliveries` row started at or after it) stays due, so
// its rows decide what is left to do; a row from before the mark — delivery since turned off and
// on again — resurrects nothing. 047 backfills a delivering project's mark to its oldest
// unfinished delivery, so what was in flight when it ran is not stranded.

/** Where the previous page ended: the last ticket it returned. */
export interface DeliveryCursor {
  readonly updated_at: number;
  readonly id: string;
}

export interface DeliveryCandidate extends DeliveryCursor {
  readonly status: string;
}

const Query = z.object({
  limit: z.int().min(1).max(1_000),
  after: z.object({ updated_at: z.int(), id: z.string().min(1) }).nullable(),
});

/**
 * Tickets joined to their projects (`t`, `w`), narrowed to the ones whose delivery is due: the
 * project delivers, the ticket is at a status of the project's moment, and it entered that moment's
 * set — from outside it, or filed straight into it — at or after the project's `delivery_since`, or
 * its delivery began at or after that mark (`deliveries.started_at`, which every attempt rewrites).
 * A NULL mark compares true with nothing, so a delivering project no writer marked delivers nothing
 * new: the safe side of this bug.
 */
function dueTickets() {
  return qb
    .selectFrom("tickets as t")
    .innerJoin("workspaces as w", "w.id", "t.workspace_id")
    .where("w.delivery_mode", "!=", "none")
    .where("t.status", "in", [...DELIVERABLE_STATUSES])
    .where((eb) =>
      eb.or(
        DELIVERY_MOMENTS.map((when) => {
          const statuses = [...DELIVERY_STATUSES[when]];
          return eb.and([
            eb("w.delivery_when", "=", when),
            eb("t.status", "in", statuses),
            eb.or([
              eb.exists(
                eb
                  .selectFrom("deliveries as d")
                  .select("d.id")
                  .whereRef("d.ticket_id", "=", "t.id")
                  .whereRef("d.started_at", ">=", "w.delivery_since"),
              ),
              eb.exists(
                eb
                  .selectFrom("ticket_events as e")
                  .select("e.id")
                  .whereRef("e.ticket_id", "=", "t.id")
                  .whereRef("e.ts", ">=", "w.delivery_since")
                  .where("e.to_status", "in", statuses)
                  .where((x) =>
                    x.or([
                      x("e.from_status", "is", null),
                      x("e.from_status", "not in", statuses),
                    ]),
                  ),
              ),
            ]),
          ]);
        }),
      ),
    );
}

/**
 * Up to `limit` tickets after `after` whose delivery is due (`dueTickets`), by updated_at then id.
 * `deliveryPlan` asks the same of each ticket again, in the snapshot it delivers from.
 */
export async function listDeliveryCandidates(
  db: Db,
  q: { readonly limit: number; readonly after: DeliveryCursor | null },
): R<DeliveryCandidate[]> {
  const parsed = Query.safeParse(q);
  if (!parsed.success) {
    return err(
      failure(
        "validation",
        `listDeliveryCandidates: ${z.prettifyError(parsed.error)}`,
      ),
    );
  }
  const { limit, after } = parsed.data;
  return read(db, (ix) =>
    all(
      ix,
      dueTickets()
        .select(["t.id", "t.status", "t.updated_at"])
        .$call((b) =>
          after === null
            ? b
            : b.where((eb) =>
                eb.or([
                  eb("t.updated_at", ">", after.updated_at),
                  eb.and([
                    eb("t.updated_at", "=", after.updated_at),
                    eb("t.id", ">", after.id),
                  ]),
                ]),
              ),
        )
        .orderBy("t.updated_at")
        .orderBy("t.id")
        .limit(limit),
    ),
  );
}

/** One repo of a ticket, as the delivery job needs it. */
export interface DeliveryRepo {
  readonly repo_id: string;
  readonly mirror_path: string;
  /** The remote recorded when the project was created: what the mirror fetches from. */
  readonly origin_url: string | null;
  /**
   * Where delivered work goes when that is not `origin_url` (039): a folder project's own remote.
   * The job pushes to `push_url ?? origin_url` (core `pushTargetOf`); null for both: nowhere.
   */
  readonly push_url: string | null;
  readonly default_base_branch: string;
  /** Its path in the superproject; null for the primary or a lone repo. */
  readonly submodule_path: string | null;
  /** The branch the ticket's work is on, from its newest worktree for this repo. */
  readonly branch: string;
  /** What was delivered for this (ticket, repo) already, or null. */
  readonly delivered: DeliveryRow | null;
}

export interface DeliveryPlan {
  readonly ticket_id: string;
  readonly ticket_num: number;
  /** Its key, as every other door spells one: what a pull request's title carries. */
  readonly ticket_key: string;
  readonly title: string;
  readonly acceptance_md: string;
  readonly status: string;
  readonly workspace_id: string;
  readonly config: DeliveryConfigFields;
  /**
   * True when the project delivers and the ticket has reached its moment since delivery was turned
   * on, or its delivery began since then (`dueTickets`).
   */
  readonly due: boolean;
  /** Submodules first, then the parent (spike §1.3); empty when nothing is deliverable. */
  readonly repos: readonly DeliveryRepo[];
}

/**
 * The branch each of `ticketId`'s repos is on: its newest worktree for that repo whose branch is a
 * session's `frm/…` one. A reviewer's detached worktree (`detached@<sha>`) is never a branch, and a
 * removed worktree's row still names the branch, which lives on in the repo's mirror (§9.2: a
 * worktree's directory may go, its work never does).
 */
function branchesOf(
  ix: Internals,
  ticketId: string,
): ReadonlyMap<string, string> {
  const rows = all(
    ix,
    qb
      .selectFrom("worktrees")
      .select(["repo_id", "branch", "created_at", "id"])
      .where("ticket_id", "=", ticketId)
      .orderBy("created_at")
      .orderBy("id"),
  );
  const found = new Map<string, string>();
  for (const row of rows) {
    if (row.branch.startsWith("frm/")) found.set(row.repo_id, row.branch);
  }
  return found;
}

/** Submodules before the parent: a parent's gitlinks must already be on the remote (spike §1.3). */
const pushOrder = (a: DeliveryRepo, b: DeliveryRepo): number => {
  const depth = (r: DeliveryRepo) => (r.submodule_path === null ? 1 : 0);
  return depth(a) - depth(b) || a.repo_id.localeCompare(b.repo_id);
};

/**
 * Everything one ticket's delivery needs, read in a single snapshot: its project's switches, and
 * one entry per repo of its workspace that the ticket has a branch for, submodules first.
 *
 * `due: false` (and no repos) for a ticket whose project delivers nothing, or which has not reached
 * its project's moment since delivery was turned on — the caller then does nothing at all, which is
 * what `delivery_mode='none'` has to mean, and what turning it on must not undo for older work.
 */
export async function deliveryPlan(db: Db, ticketId: string): R<DeliveryPlan> {
  // One snapshot: the project's switches, the ticket's status, its worktrees and what was already
  // delivered have to agree, or a re-run could push a branch a later row says is finished.
  const found = await readSnapshot(db, (ix) => planIn(ix, ticketId));
  return found.ok ? found.value : found;
}

function planIn(ix: Internals, ticketId: string): Result<DeliveryPlan> {
  const ticket = first(
    ix,
    qb
      .selectFrom("tickets")
      .select(["id", "num", "title", "acceptance_md", "status", "workspace_id"])
      .where("id", "=", ticketId),
  );
  if (ticket === undefined) {
    return err(failure("not_found", `ticket ${ticketId}`));
  }
  const workspaceId = ticket.workspace_id;
  if (workspaceId === null) {
    return err(
      failure("validation", `ticket ${ticketId} belongs to no project`),
    );
  }
  const workspace = first(
    ix,
    qb
      .selectFrom("workspaces")
      .select(["delivery_mode", "delivery_when", "close_on_merge"])
      .where("id", "=", workspaceId),
  );
  if (workspace === undefined) {
    return err(failure("not_found", `project ${workspaceId}`));
  }
  const config = deliveryConfigOf(workspace);
  const head: Omit<DeliveryPlan, "due" | "repos"> = {
    ticket_id: ticket.id,
    ticket_num: ticket.num,
    ticket_key: ticketKey(keyPrefix(ix), ticket.num),
    title: ticket.title,
    acceptance_md: ticket.acceptance_md,
    status: ticket.status,
    workspace_id: workspaceId,
    config,
  };
  // Core says whether the status is the moment; the mark says whether it was reached since delivery
  // was turned on — asked here too, so a toggle between the sweep's page and this read cannot
  // deliver the project's history either.
  const due =
    config.mode !== "none" &&
    deliveryDue(config.when, ticket.status) &&
    first(ix, dueTickets().select("t.id").where("t.id", "=", ticketId)) !==
      undefined;
  if (!due) return ok({ ...head, due: false, repos: [] });
  return ok({
    ...head,
    due: true,
    repos: deliveryReposIn(ix, ticketId, workspaceId),
  });
}

/**
 * One entry per repo of `workspaceId` that ticket `ticketId` has a branch for, with what was
 * already delivered for it, submodules first. What a delivery pushes, and — whatever the ticket's
 * status, since a CI gate keeps waiting while its ticket is blocked — what the CI sweep reads
 *.
 */
export function deliveryReposIn(
  ix: Internals,
  ticketId: string,
  workspaceId: string,
): DeliveryRepo[] {
  const branches = branchesOf(ix, ticketId);
  const delivered = new Map(
    all(
      ix,
      qb.selectFrom("deliveries").selectAll().where("ticket_id", "=", ticketId),
    ).map((row) => [row.repo_id, row]),
  );
  const rows = all(
    ix,
    qb
      .selectFrom("workspace_repos as wr")
      .innerJoin("repos as r", "r.id", "wr.repo_id")
      .select([
        "r.id as repo_id",
        "r.mirror_path as mirror_path",
        "r.origin_url as origin_url",
        "r.push_url as push_url",
        "r.default_base_branch as default_base_branch",
        "wr.submodule_path as submodule_path",
      ])
      .where("wr.workspace_id", "=", workspaceId),
  );
  return rows
    .flatMap((row) => {
      const branch = branches.get(row.repo_id);
      return branch === undefined
        ? []
        : [{ ...row, branch, delivered: delivered.get(row.repo_id) ?? null }];
    })
    .toSorted(pushOrder);
}
