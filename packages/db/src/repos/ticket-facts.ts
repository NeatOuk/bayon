import {
  all,
  first,
  qb,
  read,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { orNotFound } from "../errors.js";
import type {
  SessionRow,
  TicketRow,
  WorktreeRow,
  WorktreeState,
} from "../schema.js";
import type { GateRow } from "../schema-work.js";
import { qaGateOpens, type MergeFacts, type QaMode } from "@bayon/core";
import { latestQaRunIn } from "./qa-runs.js";

// What the transition laws consult (§3.2, M1 contract 2). transitionTicket reads these inside its
// write transaction; getTicketFacts reads the same set as one snapshot outside it, for the
// allowed-transitions view and the pre-read a transition plans from.

export interface TransitionFacts {
  readonly ticket: TicketRow;
  /** The ticket's gates, by kind then attempt. */
  gates(): GateRow[];
  /** Tickets split from it (parent_ticket_id), by num. */
  children(): TicketRow[];
  /** Worktrees recorded for it, oldest first. */
  worktrees(): WorktreeRow[];
  /** Its owner session, or null. */
  ownerSession(): SessionRow | null;
  /** Any session by id (the acting one, for the own-ticket law), or null. */
  session(id: string): SessionRow | null;
  /** Sessions whose ticket_id is this ticket, oldest first. */
  ticketSessions(): SessionRow[];
  /** The from_status of the latest transition into the current status, or null. */
  priorStatus(): string | null;
  /** Its `ticket_repos`, by id: each needs its gate (§3.1); none means one repo-less gate. */
  repos(): string[];
  /**
   * `workspaces.kind` through `tickets.workspace_id`, or null when the ticket has no workspace.
   * What `when: "multi_repo"` is judged on: `ticket_repos` is no substitute, because a
   * **submodule** workspace has one entry there and is exactly the case parity_check exists for.
   */
  workspaceKind(): string | null;
  /**
   * The repos a `lint_check` opens for: what `when: "lint_configured"` is judged on (   *). Each entry is a repo of `ticket_repos` that declares a non-blank `repos.lint_cmd`;
   * a ticket with no `ticket_repos` yields `[null]` — the one repo-less gate, pinned to the
   * workspace's primary by `subjectWorktree` — when that primary declares one, and `[]` otherwise.
   *
   * Per repo, not the primary's command for all of them: the gate runs *that repo's* command in
   * *that repo's* worktree, so a dep that declares none is an explicit skip. Reading one repo's
   * column for a per-repo gate is what an earlier change found — harmless only while `ticket_repos` had no
   * writer and the list was therefore always `[null]`.
   */
  lintRepos(): (string | null)[];
  /**
   * Whether `when: "qa_configured"` holds: the ticket's project has
   * `workspaces.qa_mode = 'command'`, so there is a harness for a `qa_harness` gate to run — or,
   *, `'ci'`, so there are pull request checks for it to wait on. `none` and
   * `pending` are both false, and a ticket with no workspace has no project to ask.
   */
  qaConfigured(): boolean;
  /**
   * The project's QA is its CI (`qa_mode = 'ci'`): a `qa_harness` gate opened now opens
   * with the `pull_request` subject. Read from the same column as `qaConfigured`.
   */
  qaCi(): boolean;
  /** The newest `qa_runs.state` for the ticket, or null: what `qa_passed` reads (§10.4). */
  qaLatest(): string | null;
  /**
   * Its `deliveries` rows and its project's `close_on_merge`: what `prs_merged` reads.
   * A ticket with no project closes on nothing: there is no switch to have turned on.
   */
  merge(): MergeFacts;
  /** The open findings on any of its gates, every attempt (M3: they block until resolved). */
  openFindings(): OpenFinding[];
}

/** A finding still open, as the gate laws read it. */
export interface OpenFinding {
  readonly gate_id: string;
  readonly severity: string;
}

const sessionById = (ix: Internals, id: string): SessionRow | null =>
  first(ix, qb.selectFrom("sessions").selectAll().where("id", "=", id)) ?? null;

/**
 * Whitespace is not a command: a column set to `" "` counts as unset rather than as a job that
 * would fail the moment it ran (`lintArgv` refuses the same value on the other side).
 */
const hasCommand = (cmd: string | null): boolean => (cmd ?? "").trim() !== "";

/** `ticket_repos`, by id (§3.1): empty means one repo-less gate. */
const ticketRepoIds = (ix: Internals, ticketId: string): string[] =>
  all(
    ix,
    qb
      .selectFrom("ticket_repos")
      .select("repo_id")
      .where("ticket_id", "=", ticketId)
      .orderBy("repo_id"),
  ).map((r) => r.repo_id);

/** Which of `repoIds` declare a `repos.lint_cmd`. */
const lintDeclaring = (
  ix: Internals,
  repoIds: readonly string[],
): ReadonlySet<string> =>
  repoIds.length === 0
    ? new Set<string>()
    : new Set(
        all(
          ix,
          qb
            .selectFrom("repos")
            .select(["id", "lint_cmd"])
            .where("id", "in", [...repoIds]),
        )
          .filter((r) => hasCommand(r.lint_cmd))
          .map((r) => r.id),
      );

/** The `repos.lint_cmd` of `workspaceId`'s primary repo, or null. */
const primaryLintCommand = (
  ix: Internals,
  workspaceId: string | null,
): string | null =>
  workspaceId === null
    ? null
    : (first(
        ix,
        qb
          .selectFrom("workspace_repos as wr")
          .innerJoin("repos as r", "r.id", "wr.repo_id")
          .select("r.lint_cmd as lint_cmd")
          .where("wr.workspace_id", "=", workspaceId)
          .where("wr.role", "=", "primary")
          .orderBy("r.id"),
      )?.lint_cmd ?? null);

/** The ticket's project's `qa_mode`, or null when it has no project (or an unknown mode). */
function qaModeOf(ix: Internals, ticket: TicketRow): QaMode | null {
  if (ticket.workspace_id === null) return null;
  const mode = first(
    ix,
    qb
      .selectFrom("workspaces")
      .select("qa_mode")
      .where("id", "=", ticket.workspace_id),
  )?.qa_mode;
  return mode ?? null;
}

/** `prs_merged`'s facts: every `deliveries` row of the ticket, by repo, and the project's switch. */
function mergeFactsIn(ix: Internals, ticket: TicketRow): MergeFacts {
  const closeOnMerge =
    ticket.workspace_id !== null &&
    first(
      ix,
      qb
        .selectFrom("workspaces")
        .select("close_on_merge")
        .where("id", "=", ticket.workspace_id),
    )?.close_on_merge === 1;
  const deliveries = all(
    ix,
    qb
      .selectFrom("deliveries")
      .select(["repo_id", "state", "pr_url", "head_sha"])
      .where("ticket_id", "=", ticket.id)
      .orderBy("repo_id"),
  ).map((d) => ({
    repoId: d.repo_id,
    state: d.state,
    prUrl: d.pr_url,
    headSha: d.head_sha,
  }));
  return { closeOnMerge, deliveries };
}

/** The facts of `ticket`, each read when called, on `ix`. */
export function factsOf(ix: Internals, ticket: TicketRow): TransitionFacts {
  return {
    ticket,
    gates: () =>
      all(
        ix,
        qb
          .selectFrom("gates")
          .selectAll()
          .where("ticket_id", "=", ticket.id)
          .orderBy("kind")
          .orderBy("attempt")
          .orderBy("id"),
      ),
    children: () =>
      all(
        ix,
        qb
          .selectFrom("tickets")
          .selectAll()
          .where("parent_ticket_id", "=", ticket.id)
          .orderBy("num"),
      ),
    worktrees: () =>
      all(
        ix,
        qb
          .selectFrom("worktrees")
          .selectAll()
          .where("ticket_id", "=", ticket.id)
          .orderBy("created_at")
          .orderBy("id"),
      ),
    ownerSession: () =>
      ticket.owner_session_id === null
        ? null
        : sessionById(ix, ticket.owner_session_id),
    session: (id) => sessionById(ix, id),
    ticketSessions: () =>
      all(
        ix,
        qb
          .selectFrom("sessions")
          .selectAll()
          .where("ticket_id", "=", ticket.id)
          .orderBy("created_at")
          .orderBy("id"),
      ),
    priorStatus: () =>
      first(
        ix,
        qb
          .selectFrom("ticket_events")
          .select("from_status")
          .where("ticket_id", "=", ticket.id)
          .where("kind", "=", "transition")
          .where("to_status", "=", ticket.status)
          .orderBy("id", "desc")
          .limit(1),
      )?.from_status ?? null,
    repos: () => ticketRepoIds(ix, ticket.id),
    workspaceKind: () =>
      ticket.workspace_id === null
        ? null
        : (first(
            ix,
            qb
              .selectFrom("workspaces")
              .select("kind")
              .where("id", "=", ticket.workspace_id),
          )?.kind ?? null),
    qaConfigured: () => {
      const mode = qaModeOf(ix, ticket);
      return mode !== null && qaGateOpens(mode);
    },
    qaCi: () => qaModeOf(ix, ticket) === "ci",
    qaLatest: () => latestQaRunIn(ix, ticket.id)?.state ?? null,
    merge: () => mergeFactsIn(ix, ticket),
    lintRepos: () => {
      const repos = ticketRepoIds(ix, ticket.id);
      if (repos.length === 0) {
        return hasCommand(primaryLintCommand(ix, ticket.workspace_id))
          ? [null]
          : [];
      }
      const declaring = lintDeclaring(ix, repos);
      return repos.filter((id) => declaring.has(id));
    },
    openFindings: () =>
      all(
        ix,
        qb
          .selectFrom("findings")
          .innerJoin("gates", "gates.id", "findings.gate_id")
          .select([
            "findings.gate_id as gate_id",
            "findings.severity as severity",
          ])
          .where("gates.ticket_id", "=", ticket.id)
          .where("findings.status", "=", "open")
          .orderBy("findings.id"),
      ),
  };
}

/** The facts a law reads, taken at once. */
export interface TicketFactsSnapshot {
  readonly ticket: TicketRow;
  readonly children: TicketRow[];
  readonly worktrees: WorktreeRow[];
  readonly ticketSessions: SessionRow[];
  /** The session named as the actor, or null (the operator, or an unknown id). */
  readonly actorSession: SessionRow | null;
  readonly priorStatus: string | null;
  /** M3: the gate facts, as transitionTicket reads them in its transaction. */
  readonly gates: GateRow[];
  readonly repos: string[];
  /** `workspaces.kind`, or null: what `when: "multi_repo"` is judged on. */
  readonly workspaceKind: string | null;
  /** The repos a `lint_check` opens for: what `when: "lint_configured"` is judged on. */
  readonly lintRepos: (string | null)[];
  /** The project runs a QA harness: what `when: "qa_configured"` is judged on. */
  readonly qaConfigured: boolean;
  /** The project's QA is its CI: a QA gate opens as a CI gate. */
  readonly qaCi: boolean;
  /** The newest `qa_runs.state` for the ticket, or null: what `qa_passed` reads. */
  readonly qaLatest: string | null;
  /** Its deliveries and its project's close_on_merge: what `prs_merged` reads. */
  readonly merge: MergeFacts;
  readonly openFindings: OpenFinding[];
}

/**
 * A ticket's facts in one read transaction (a consistent WAL snapshot), for `actorSessionId`
 * when a session acts. A missing ticket is `not_found`.
 */
export async function getTicketFacts(
  db: Db,
  id: string,
  actorSessionId: string | null,
): R<TicketFactsSnapshot> {
  const found = await read(db, (ix) =>
    ix.raw.transaction((): TicketFactsSnapshot | undefined => {
      const ticket = first(
        ix,
        qb.selectFrom("tickets").selectAll().where("id", "=", id),
      );
      if (ticket === undefined) return undefined;
      const facts = factsOf(ix, ticket);
      return {
        ticket,
        children: facts.children(),
        worktrees: facts.worktrees(),
        ticketSessions: facts.ticketSessions(),
        actorSession:
          actorSessionId === null ? null : facts.session(actorSessionId),
        priorStatus: facts.priorStatus(),
        gates: facts.gates(),
        repos: facts.repos(),
        workspaceKind: facts.workspaceKind(),
        lintRepos: facts.lintRepos(),
        qaConfigured: facts.qaConfigured(),
        qaCi: facts.qaCi(),
        qaLatest: facts.qaLatest(),
        merge: facts.merge(),
        openFindings: facts.openFindings(),
      };
    })(),
  );
  return orNotFound(found, `ticket ${id}`);
}

/** A worktree of a ticket, with what the no_source_changes check needs to reach it. */
export interface TicketWorktree {
  readonly id: string;
  readonly path: string;
  readonly branch: string;
  /** Where it sits: the gate engine pins a subject from it. */
  readonly workspace_id: string;
  readonly repo_id: string;
  readonly base_sha: string;
  /**
   * The head last recorded for it (the worktree facts pass writes it); null while it has never
   * been read. The parity gate checks this commit is in the repo's mirror, falling back to
   * `base_sha`.
   */
  readonly head_sha: string | null;
  readonly state: WorktreeState;
  readonly session_id: string | null;
  /** The executor of the session that owns it; null without one. */
  readonly executor_kind: string | null;
  /**
   * That executor's id: a gate reads the worktree through it, since a container's is not on this
   * host. Null without a session, where the path is this host's.
   */
  readonly executor_id: string | null;
}

/**
 * A ticket's worktrees, oldest first, each with its session's executor. A reviewer's detached
 * worktree (its session has a `gate_id`) is its gate's, never the ticket's work: it is left out, so
 * the gate engine never pins it or takes its reviewer for the builder, and no_source_changes never
 * diffs it.
 */
export function listTicketWorktrees(
  db: Db,
  ticketId: string,
): R<TicketWorktree[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("worktrees")
        .leftJoin("sessions", "sessions.id", "worktrees.session_id")
        .leftJoin("executors", "executors.id", "sessions.executor_id")
        .select([
          "worktrees.id as id",
          "worktrees.path as path",
          "worktrees.branch as branch",
          "worktrees.workspace_id as workspace_id",
          "worktrees.repo_id as repo_id",
          "worktrees.base_sha as base_sha",
          "worktrees.head_sha as head_sha",
          "worktrees.state as state",
          "worktrees.session_id as session_id",
          "executors.kind as executor_kind",
          "executors.id as executor_id",
        ])
        .where("worktrees.ticket_id", "=", ticketId)
        .where("sessions.gate_id", "is", null)
        .orderBy("worktrees.created_at")
        .orderBy("worktrees.id"),
    ),
  );
}
