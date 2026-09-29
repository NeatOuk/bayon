// The Jira mirror's writers, the API's (§9.5: the API writes tickets), exported from
// @bayon/db/api only. One page of issues is one transaction; so is one sync's parking. Every ticket
// write goes through the ticket writers' in-transaction forms, so each carries its ticket_event and
// its version bump exactly as REST's would, as the operator with actor_id `jira:<host>`.
//
// Bayon owns a ticket once work on it begins: only a `backlog` or `prioritized` ticket is updated
// or parked here, and nothing is ever deleted. And once begun it stays Bayon's (the loop
// guard): a ticket that ever reached a started status is never parked, even back in `prioritized`
// (ask_human) or `backlog` (unpark) — Bayon's own status push is what took its issue out of the
// query, and parking it for that would be the mirror undoing Bayon's work.
import {
  WORK_STARTED_STATUSES,
  err,
  jiraActorId,
  jiraFingerprintPrefix,
  ok,
  type ComplexityColumns,
  type JiraMirrorItem,
  type Result,
} from "@bayon/core";
import {
  all,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { TicketRow } from "../schema.js";
import type { TicketActor } from "./ticket-common.js";
import { moveTicket, type Decide } from "./ticket-transition.js";
import { createTicketIn, updateTicketIn } from "./ticket-writes.js";

/** The statuses the mirror may still write: Bayon has not started the ticket. */
export const UNSTARTED = ["backlog", "prioritized"] as const;
const isUnstarted = (status: string): boolean =>
  (UNSTARTED as readonly string[]).includes(status);

export const JIRA_ORIGIN = "jira";

export interface JiraMirrorPage {
  /** The project: its workspace's id. */
  readonly workspaceId: string;
  /** The site's host, e.g. `acme.atlassian.net`: every fingerprint is `jira:<host>:<id>`. */
  readonly host: string;
  readonly items: readonly JiraMirrorItem[];
  /** A new ticket's complexity columns: an empty fact set, scored as POST /tickets scores one. */
  readonly complexity: ComplexityColumns;
}

/** An issue already mirrored into another project: fingerprints are unique fleet-wide. */
export interface JiraSkipped {
  readonly key: string;
  readonly project: string | null;
}

export interface JiraMirrored {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly skipped: readonly JiraSkipped[];
}

const actorOf = (host: string, reason?: string): TicketActor => ({
  actor_kind: "operator",
  actor_id: jiraActorId(host),
  ...(reason === undefined ? {} : { reason }),
});

function checkFingerprints(
  host: string,
  fingerprints: readonly string[],
): Result<void> {
  const prefix = jiraFingerprintPrefix(host);
  const stray = fingerprints.find((f) => !f.startsWith(prefix));
  return stray === undefined
    ? ok(undefined)
    : err(failure("validation", `${stray} is not a fingerprint of ${host}`));
}

const byFingerprint = (
  ix: Internals,
  fingerprints: readonly string[],
): ReadonlyMap<string, TicketRow> =>
  new Map(
    fingerprints.length === 0
      ? []
      : all(
          ix,
          qb
            .selectFrom("tickets")
            .selectAll()
            .where("origin_fingerprint", "in", fingerprints),
        ).map((t) => [t.origin_fingerprint ?? "", t]),
  );

/** The mirrored columns that differ from the ticket's, as a patch; empty when none do. */
function drift(ticket: TicketRow, item: JiraMirrorItem) {
  return {
    ...(ticket.title === item.title ? {} : { title: item.title }),
    ...(ticket.body_md === item.body_md ? {} : { body_md: item.body_md }),
    ...(ticket.type === item.type ? {} : { type: item.type }),
    ...(ticket.priority === item.priority ? {} : { priority: item.priority }),
  };
}

type Outcome = "created" | "updated" | "unchanged" | JiraSkipped;

function mirrorOne(
  ix: Internals,
  page: JiraMirrorPage,
  item: JiraMirrorItem,
  ticket: TicketRow | undefined,
  begun: ReadonlySet<string>,
): Result<Outcome> {
  const by = actorOf(page.host);
  if (ticket === undefined) {
    const created = createTicketIn(
      ix,
      {
        title: item.title,
        type: item.type,
        status: "backlog",
        origin: JIRA_ORIGIN,
        origin_ref: item.origin_ref,
        origin_fingerprint: item.fingerprint,
        body_md: item.body_md,
        priority: item.priority,
        workspace_id: page.workspaceId,
        ...page.complexity,
      },
      by,
    );
    return created.ok ? ok("created") : created;
  }
  if (ticket.workspace_id !== page.workspaceId) {
    return ok({ key: item.origin_ref, project: ticket.workspace_id });
  }
  // Begun in Bayon, even if back among the unstarted since: Bayon's, never overwritten.
  if (!isUnstarted(ticket.status) || begun.has(ticket.id))
    return ok("unchanged");
  const patch = drift(ticket, item);
  if (Object.keys(patch).length === 0) return ok("unchanged");
  const updated = updateTicketIn(ix, {
    id: ticket.id,
    version: ticket.version,
    patch,
    by,
  });
  return updated.ok ? ok("updated") : updated;
}

/**
 * Mirrors one page of To Do issues into project `workspaceId`'s tickets, in one transaction: an
 * unknown fingerprint files a backlog ticket (origin `jira`, its key as origin_ref); one filed for
 * another project is skipped, naming that project; an unstarted ticket of this project takes the
 * page's title, body, type and priority when any differ, and nothing is written when none do; a
 * started one — or one Bayon ever began, back in backlog or prioritized since — is Bayon's and is
 * left alone (counted unchanged). A fingerprint not of `host` is
 * refused (validation), writing nothing.
 */
export function mirrorJiraPage(db: Db, page: JiraMirrorPage): R<JiraMirrored> {
  const checked = checkFingerprints(
    page.host,
    page.items.map((i) => i.fingerprint),
  );
  if (!checked.ok) return Promise.resolve(checked);
  return write(db, (ix) => {
    const known = byFingerprint(
      ix,
      page.items.map((i) => i.fingerprint),
    );
    const begun = startedByBayon(
      ix,
      [...known.values()].map((t) => t.id),
    );
    const tally = { created: 0, updated: 0, unchanged: 0 };
    const skipped: JiraSkipped[] = [];
    // An issue twice in one page is mirrored once: `known` was read before either.
    const once = [
      ...new Map(page.items.map((i) => [i.fingerprint, i])).values(),
    ];
    for (const item of once) {
      const outcome = mirrorOne(
        ix,
        page,
        item,
        known.get(item.fingerprint),
        begun,
      );
      if (!outcome.ok) return outcome;
      if (typeof outcome.value === "string") tally[outcome.value] += 1;
      else skipped.push(outcome.value);
    }
    return ok({ ...tally, skipped });
  });
}

/**
 * Of `ticketIds`, those Bayon has ever begun: a ticket_event moved each into a started status
 * (core WORK_STARTED_STATUSES). The mirror never parks or updates one of them (the loop guard).
 */
export function startedByBayon(
  ix: Internals,
  ticketIds: readonly string[],
): ReadonlySet<string> {
  const wanted = [...new Set(ticketIds)];
  if (wanted.length === 0) return new Set();
  return new Set(
    all(
      ix,
      qb
        .selectFrom("ticket_events")
        .select("ticket_id")
        .distinct()
        .where("ticket_id", "in", wanted)
        .where("to_status", "in", WORK_STARTED_STATUSES),
    ).map((r) => r.ticket_id),
  );
}

export interface JiraDeparted {
  readonly fingerprint: string;
  /** The park's note, e.g. "moved to In Progress in Jira". */
  readonly reason: string;
}

export interface JiraParkRequest {
  readonly workspaceId: string;
  readonly host: string;
  readonly departed: readonly JiraDeparted[];
  /** The `park` edge's laws: the caller's, as for every transition (transitionTicket). */
  readonly decide: Decide;
}

/**
 * Parks each departed issue's ticket that is still unstarted — and never begun by Bayon, the loop
 * guard — in project `workspaceId`, through the
 * `park` edge, its reason as the event's note, all in one transaction. A ticket of another project,
 * already parked, or in any other status is left alone; none is ever deleted. Returns how many
 * were parked. A law refusal rolls every park back and comes back unchanged.
 */
export function parkDepartedJira(
  db: Db,
  req: JiraParkRequest,
): R<{ readonly parked: number }> {
  const checked = checkFingerprints(
    req.host,
    req.departed.map((d) => d.fingerprint),
  );
  if (!checked.ok) return Promise.resolve(checked);
  return write(db, (ix) => {
    const known = byFingerprint(
      ix,
      req.departed.map((d) => d.fingerprint),
    );
    const begun = startedByBayon(
      ix,
      [...known.values()].map((t) => t.id),
    );
    let parked = 0;
    for (const d of req.departed) {
      const ticket = known.get(d.fingerprint);
      if (
        ticket === undefined ||
        ticket.workspace_id !== req.workspaceId ||
        !isUnstarted(ticket.status) ||
        begun.has(ticket.id)
      )
        continue;
      const moved = moveTicket(
        ix,
        ticket,
        {
          id: ticket.id,
          version: ticket.version,
          to: "parked",
          by: actorOf(req.host, d.reason),
        },
        null,
        req.decide,
      );
      if (!moved.ok) return moved;
      parked += 1;
    }
    return ok({ parked });
  });
}
