import {
  TICKET_STATUSES,
  advanceStatus,
  allowedTransitions,
  complexityColumns,
  decidePatch,
  err,
  lawRefused,
  ok,
  planGateEffects,
  planTransition,
  requiredFacts,
  type Actor,
  type Clock,
  type FrmError,
  type PreFact,
  type Result,
  type NextStep,
  type StaffDecision,
  type TicketSettings,
} from "@bayon/core";
import {
  findTicketByFingerprint,
  getTicket,
  getTicketByNum,
  getTicketEconomics,
  getTicketFacts,
  listGateSessions,
  listTicketEvents,
  listTicketExports,
  listTicketFindings,
  listTicketGates,
  listTicketHandoffs,
  listTicketLinks,
  listTicketWorktrees,
  listTickets,
  type Db,
  type TicketRow,
} from "@bayon/db";
import {
  appendTicketEvent,
  createTicket,
  linkTicket,
  staffTicket,
  transitionTicket,
  updateTicketCas,
  type AuditEntry,
  type StaffProposalAnswered,
  type TicketPatch,
} from "@bayon/db/api";
import {
  TicketRef,
  type CommentRequest,
  type CreateTicketRequest,
  type LinkRequest,
  type PatchTicketRequest,
  type StaffRequest,
  type TicketDetail,
  type TicketEventView,
  type TicketEventsPage,
  type TicketEventsQuery,
  type TicketExtras,
  type TicketLinkView,
  type TicketView,
  type TicketsPage,
  type TicketsQuery,
  type TransitionRequest,
} from "@bayon/proto";
import {
  gatherGitFacts,
  runGit,
  type GitFacts,
  type GitRunner,
} from "./git-facts.js";
import {
  actorRef,
  actorSessionId,
  isMultiRepo,
  lawFacts,
  lawTicket,
  lintGateRepos,
  loadGateSettings,
  parseStatus,
} from "./law-facts.js";
import { gitLaw, lawDecider, type TransitionSet } from "./law-decider.js";
import { nextStepOf } from "./next-step.js";
import { gatePlan, handoffPlan, setLaw, staffAudit } from "./ticket-plans.js";
import { answerProposal } from "./staff-proposals.js";
import { staffResult, type StaffResult } from "./staffing.js";
import { loadTicketSettings } from "./ticket-settings.js";
import {
  toEconomics,
  toEventView,
  toEventViews,
  toExportViews,
  toGateViews,
  toHandoffViews,
  toLinkViews,
  summariesOf,
  ticketViewOf,
} from "./ticket-views.js";
import { touchedRepos } from "./touched-repos.js";

// The tickets module (§3.2, §12.1; M1 contracts 1–3, 8): REST (the operator) and MCP (sessions,
//) both call this. Every write goes through @bayon/db/api's writers; every status move
// through the §3.2 law table in core, decided inside the writer's transaction.

export interface TicketServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  /** `<FRM_HOME>/work`, where local worktrees live; null leaves no_source_changes unverifiable. */
  readonly workRoot: string | null;
  readonly git?: GitRunner;
  /** Test seam: runs after a write has read its ticket and gathered its facts, before it writes. */
  readonly hooks?: { readonly afterFacts?: () => Promise<void> };
}

const EVENTS_IN_DETAIL = 100;

const conflict = (row: TicketRow, version: number): FrmError => ({
  class: "conflict",
  message: `ticket ${row.id} is at version ${row.version}, not ${version}`,
  retryable: false,
  cause: { current_version: row.version },
});

export class TicketService {
  readonly #deps: TicketServiceDeps;

  constructor(deps: TicketServiceDeps) {
    this.#deps = deps;
  }

  /** A page of summaries by num; `q` searches titles and bodies. */
  async list(q: TicketsQuery): Promise<Result<TicketsPage>> {
    const settings = await loadTicketSettings(this.#deps.db);
    if (!settings.ok) return settings;
    const page = await listTickets(this.#deps.db, {
      status: q.status,
      needs_human: q.needs_human,
      complexity_tier: q.tier,
      workspace_id: q.workspace_id,
      q: q.q,
      after_num: q.cursor,
      limit: q.limit,
    });
    if (!page.ok) return page;
    const items = await summariesOf(
      this.#deps.db,
      page.value.rows,
      settings.value["tickets.key_prefix"],
    );
    if (!items.ok) return items;
    return ok({
      items: items.value,
      next_cursor: page.value.nextCursor,
      has_more: page.value.hasMore,
    });
  }

  /** The detail view (contract 8), with the transitions the laws allow `actor`. */
  async get(ref: string, actor: Actor): Promise<Result<TicketDetail>> {
    const row = await this.#resolve(ref);
    if (!row.ok) return row;
    const settings = await loadTicketSettings(this.#deps.db);
    if (!settings.ok) return settings;
    const snapshot = await getTicketFacts(
      this.#deps.db,
      row.value.id,
      actorSessionId(actor),
    );
    if (!snapshot.ok) return snapshot;
    const ticket = lawTicket(snapshot.value.ticket);
    if (!ticket.ok) return ticket;
    const prior = parseStatus(snapshot.value.priorStatus);
    const planNeeded = TICKET_STATUSES.some((to) =>
      requiredFacts(ticket.value.status, to, prior).has("plan"),
    );
    const git = planNeeded
      ? await this.#gitFacts(
          snapshot.value.ticket,
          new Set(["plan"]),
          settings.value,
        )
      : ok(undefined);
    if (!git.ok) return git;
    const gateSettings = await loadGateSettings(this.#deps.db);
    const facts = {
      ...lawFacts(snapshot.value, gateSettings),
      ...gitLaw(git.value),
      diff: { state: "deferred" } as const,
    };
    const view = await ticketViewOf(
      this.#deps.db,
      snapshot.value.ticket,
      settings.value["tickets.key_prefix"],
    );
    if (!view.ok) return view;
    const events = await this.#events(row.value.id, {
      since: 0,
      limit: EVENTS_IN_DETAIL,
    });
    if (!events.ok) return events;
    const extras = await this.#extras(row.value.id);
    if (!extras.ok) return extras;
    const next = await nextStepOf(
      this.#deps.db,
      snapshot.value.ticket,
      ticket.value,
      facts,
    );
    if (!next.ok) return next;
    return ok({
      ticket: view.value,
      transitions: allowedTransitions({ ticket: ticket.value, actor, facts }),
      next_step: next.value,
      events: events.value,
      ...extras.value,
    });
  }

  /**
   * `GET /tickets/:ref/next`: who the ticket waits on, why, and the operator's way on.
   * No git: none of the moves a next step offers needs the plan file or the diff.
   */
  async next(ref: string): Promise<Result<NextStep>> {
    const row = await this.#resolve(ref);
    if (!row.ok) return row;
    const snapshot = await getTicketFacts(this.#deps.db, row.value.id, null);
    if (!snapshot.ok) return snapshot;
    const ticket = lawTicket(snapshot.value.ticket);
    if (!ticket.ok) return ticket;
    const facts = {
      ...lawFacts(snapshot.value, await loadGateSettings(this.#deps.db)),
      diff: { state: "deferred" } as const,
    };
    return nextStepOf(
      this.#deps.db,
      snapshot.value.ticket,
      ticket.value,
      facts,
    );
  }

  async events(
    ref: string,
    q: TicketEventsQuery,
  ): Promise<Result<TicketEventsPage>> {
    const row = await this.#resolve(ref);
    return row.ok ? this.#events(row.value.id, q) : row;
  }

  /** Files a backlog ticket, scored from its declared facts (§8.8). */
  create(
    body: CreateTicketRequest,
    actor: Actor,
    /** The caller's audit entry, committed with the write (MCP). */
    audit?: AuditEntry,
  ): Promise<Result<TicketView>> {
    return this.#file(body, actor, audit, {
      origin: actor.kind === "operator" ? "operator" : "agent",
      fingerprint: null,
    });
  }

  /**
   * Files the ticket for a probe finding (§10.2): origin `probe`, waiting for a human (amendment
   * g). A fingerprint files one ticket ever (tickets_origin_fp_idx): a repeat, even a concurrent
   * one, returns the ticket the first call filed, with `created: false`, instead of a conflict.
   */
  async createFromProbe(
    body: CreateTicketRequest,
    fingerprint: string,
    actor: Actor,
    audit?: AuditEntry,
  ): Promise<
    Result<{ readonly ticket: TicketView; readonly created: boolean }>
  > {
    // The pulse's orchestrator reads the probe findings; a worker could otherwise squat a
    // fingerprint and hide the finding's real ticket.
    if (actor.kind !== "orchestrator") {
      return err({
        class: "validation",
        message: "only the orchestrator files a probe finding's ticket",
        retryable: false,
      });
    }
    if (fingerprint.length === 0 || fingerprint.length > 64) {
      return err({
        class: "validation",
        message: "a fingerprint is 1-64 characters",
        retryable: false,
      });
    }
    const filed = await this.#file(
      { ...body, needs_human: true },
      actor,
      audit,
      {
        origin: "probe",
        fingerprint,
      },
    );
    if (filed.ok) return ok({ ticket: filed.value, created: true });
    if (filed.error.class !== "conflict") return filed;
    const existing = await findTicketByFingerprint(this.#deps.db, fingerprint);
    if (!existing.ok) return existing;
    if (existing.value === null) return filed;
    const settings = await loadTicketSettings(this.#deps.db);
    if (!settings.ok) return settings;
    const view = await ticketViewOf(
      this.#deps.db,
      existing.value,
      settings.value["tickets.key_prefix"],
    );
    return view.ok ? ok({ ticket: view.value, created: false }) : view;
  }

  async #file(
    body: CreateTicketRequest,
    actor: Actor,
    audit: AuditEntry | undefined,
    o: { readonly origin: string; readonly fingerprint: string | null },
  ): Promise<Result<TicketView>> {
    const settings = await loadTicketSettings(this.#deps.db);
    if (!settings.ok) return settings;
    const complexity = await complexityColumns(
      body.complexity_facts ?? {},
      settings.value["complexity.rubric"],
    );
    if (!complexity.ok) return complexity;
    // §11.1: a ticket from a session that is not the orchestrator waits for a human.
    const needsHuman = actor.kind === "worker" || body.needs_human === true;
    const row = await createTicket(
      this.#deps.db,
      {
        title: body.title,
        type: body.type,
        status: "backlog",
        origin: o.origin,
        origin_ref: actorSessionId(actor),
        origin_fingerprint: o.fingerprint,
        body_md: body.body_md ?? "",
        acceptance_md: body.acceptance_md ?? "",
        priority: body.priority ?? 3,
        workspace_id: body.workspace_id ?? null,
        epic_id: body.epic_id ?? null,
        parent_ticket_id: body.parent_ticket_id ?? null,
        plan_path: body.plan_path ?? null,
        needs_human: needsHuman ? 1 : 0,
        ...complexity.value,
      },
      actorRef(actor),
      audit,
    );
    return row.ok
      ? await ticketViewOf(
          this.#deps.db,
          row.value,
          settings.value["tickets.key_prefix"],
        )
      : row;
  }

  /** A compare-and-set edit at `version` (If-Match), under the PATCH laws. */
  async update(
    ref: string,
    version: number,
    body: PatchTicketRequest,
    actor: Actor,
    /** The caller's audit entry, committed with the write (MCP). */
    audit?: AuditEntry,
  ): Promise<Result<TicketView>> {
    const row = await this.#resolve(ref);
    if (!row.ok) return row;
    const settings = await loadTicketSettings(this.#deps.db);
    if (!settings.ok) return settings;
    const own = await this.#owns(row.value, actor);
    if (!own.ok) return own;
    const decision = decidePatch({
      actor,
      own: own.value,
      fields: Object.keys(body),
      ...(body.needs_human === undefined
        ? {}
        : { needsHuman: body.needs_human }),
    });
    if (!decision.allowed) return err(lawRefused(decision));
    const { complexity_facts, needs_human, ...columns } = body;
    const complexity =
      complexity_facts === undefined
        ? ok({})
        : await complexityColumns(
            complexity_facts,
            settings.value["complexity.rubric"],
          );
    if (!complexity.ok) return complexity;
    const patch: TicketPatch = {
      ...columns,
      ...(needs_human === undefined
        ? {}
        : { needs_human: needs_human ? 1 : 0 }),
      ...complexity.value,
    };
    await this.#deps.hooks?.afterFacts?.();
    const updated = await updateTicketCas(
      this.#deps.db,
      {
        id: row.value.id,
        version,
        patch,
        by: actorRef(actor),
      },
      audit,
    );
    return updated.ok
      ? await ticketViewOf(
          this.#deps.db,
          updated.value,
          settings.value["tickets.key_prefix"],
        )
      : updated;
  }

  /**
   * Moves the ticket at `version` (If-Match) to `body.to`. Git facts are gathered first; the laws
   * are decided again inside the writer's transaction, which writes the status and its event.
   * `set` columns move with the status, under the PATCH laws, and every law judges the row as the
   * move leaves it: a plan_path set with submit_plan is the one its checks see.
   */
  async transition(
    ref: string,
    version: number,
    body: TransitionRequest,
    actor: Actor,
    /** The caller's audit entry, committed with the write (MCP). */
    audit?: AuditEntry,
    set: TransitionSet = {},
  ): Promise<Result<TicketView>> {
    const { db, clock } = this.#deps;
    const row = await this.#resolve(ref);
    if (!row.ok) return row;
    const settings = await loadTicketSettings(db);
    if (!settings.ok) return settings;
    const snapshot = await getTicketFacts(
      db,
      row.value.id,
      actorSessionId(actor),
    );
    if (!snapshot.ok) return snapshot;
    const read = snapshot.value.ticket;
    if (read.version !== version) return err(conflict(read, version));
    const own = snapshot.value.actorSession?.ticket_id === read.id;
    const settable = setLaw(actor, own, set);
    if (!settable.ok) return settable;
    const current: TicketRow = { ...read, ...set };
    const ticket = lawTicket(current);
    if (!ticket.ok) return ticket;
    const prior = parseStatus(snapshot.value.priorStatus);
    const need = requiredFacts(ticket.value.status, body.to, prior);
    const git =
      need.size === 0
        ? ok(undefined)
        : await this.#gitFacts(current, need, settings.value);
    if (!git.ok) return git;
    const plan = planTransition({
      ticket: ticket.value,
      priorStatus: prior,
      to: body.to,
      input: body,
      now: clock.now(),
      ...(git.value === undefined ? {} : { evidence: git.value.evidence }),
    });
    if ("allowed" in plan) return err(lawRefused(plan));
    // §3.1: an edge that opens a code_review round is the moment the server learns
    // which repos the ticket touches, so it records them — in the writer's own transaction, before
    // the round reads `ticket_repos` — and the round opens a gate for each. Gathered here, outside
    // that transaction, because it reads the worktrees' git.
    const touched = plan.gates.opens.some((g) => g.gate === "code_review")
      ? await this.#touchedRepos(current.id, settings.value)
      : ok<readonly string[]>([]);
    if (!touched.ok) return touched;
    // Where the move lands once its gates are known: a plan that opens no review is approved as it
    // is submitted rather than resting in a status only that review could leave.
    // Planning it from the snapshot is safe — a plan_review gate is opened only by a transition,
    // which bumps the version this write compare-and-sets on, or by a rerun, which needs the
    // ticket to be in plan_review already.
    const gateSettings = await loadGateSettings(db);
    const advanceTo =
      plan.advance === undefined || !gateSettings.ok
        ? null
        : advanceStatus(
            plan.advance,
            planGateEffects({
              edge: plan.gates,
              ticket: {
                non_trivial: current.non_trivial === 1,
                plan_path: current.plan_path,
              },
              gates: snapshot.value.gates,
              repos: snapshot.value.repos,
              multiRepo: isMultiRepo(
                snapshot.value.workspaceKind,
                gateSettings.value,
              ),
              lintRepos: lintGateRepos(
                snapshot.value.lintRepos,
                gateSettings.value,
              ),
              qaConfigured: snapshot.value.qaConfigured,
              qaCi: snapshot.value.qaCi,
            }).open,
          );
    await this.#deps.hooks?.afterFacts?.();
    const moved = await transitionTicket(
      db,
      {
        id: current.id,
        version,
        to: body.to,
        ...(advanceTo === null ? {} : { advanceTo }),
        by: actorRef(actor, body.reason),
        patch: { ...plan.patch, ...set },
        payload: plan.payload,
        touchedRepos: touched.value,
      },
      lawDecider(actor, body, plan.rule, git.value, gateSettings, set),
      audit,
      gatePlan(plan.gates, gateSettings),
      handoffPlan(advanceTo ?? body.to, current.complexity_tier),
    );
    return moved.ok
      ? await ticketViewOf(
          this.#deps.db,
          moved.value,
          settings.value["tickets.key_prefix"],
        )
      : moved;
  }

  /** A note in the ticket's history (§11.1 ticket.comment): any actor, no version change. */
  async comment(
    ref: string,
    body: CommentRequest,
    actor: Actor,
    /** The caller's audit entry, committed with the write (MCP). */
    audit?: AuditEntry,
  ): Promise<Result<TicketEventView>> {
    const row = await this.#resolve(ref);
    if (!row.ok) return row;
    const event = await appendTicketEvent(
      this.#deps.db,
      {
        ticket_id: row.value.id,
        kind: "comment",
        ...actorRef(actor),
        payload: { body_md: body.body_md },
      },
      audit,
    );
    return event.ok ? toEventView(event.value) : event;
  }

  /** Links the ticket to a url or another ticket (§11.1 ticket.link). */
  async link(
    ref: string,
    body: LinkRequest,
    actor: Actor,
    /** The caller's audit entry, committed with the write (MCP). */
    audit?: AuditEntry,
  ): Promise<Result<TicketLinkView>> {
    const row = await this.#resolve(ref);
    if (!row.ok) return row;
    const target =
      body.target === undefined
        ? ok(undefined)
        : await this.#resolve(body.target);
    if (!target.ok) return target;
    const link = await linkTicket(
      this.#deps.db,
      {
        ticket_id: row.value.id,
        kind: body.kind,
        ...(body.url === undefined ? {} : { url: body.url }),
        ...(target.value === undefined
          ? {}
          : { target_ticket_id: target.value.id }),
      },
      actorRef(actor),
      audit,
    );
    if (!link.ok) return link;
    const views = toLinkViews([link.value]);
    return views.ok ? ok(views.value[0] as TicketLinkView) : views;
  }

  /**
   * Staffs the ticket (§11.1 ticket.staff; M2 amendment h). One transaction moves a prioritized
   * ticket to staffed under the laws (`staff`) and queues its session.spawn; the run class comes
   * from the status, the agent from the selection rule over the ticket's project's agents, or the
   * request names one. A refusal is data, not an error.
   */
  async staff(
    ref: string,
    request: StaffRequest,
    actor: Actor,
    /** A repeat returns the first command and moves nothing. */
    idempotencyKey?: string,
    /** The caller's audit entry, committed with the write (MCP). */
    audit?: AuditEntry,
  ): Promise<Result<StaffResult>> {
    const row = await this.#resolve(ref);
    if (!row.ok) return row;
    const gateSettings = await loadGateSettings(this.#deps.db);
    const outcome = await staffTicket(
      this.#deps.db,
      {
        ticket_id: row.value.id,
        role: request.role,
        by: actorRef(actor),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(request.agent === undefined ? {} : { agent: request.agent }),
      },
      lawDecider(actor, { to: "staffed" }, "staff", undefined, gateSettings),
      audit ?? staffAudit(actor, row.value.id, request),
    );
    return outcome.ok ? staffResult(outcome.value) : outcome;
  }

  /**
   * The operator's answer to a staffing proposal: `approve` staffs the proposed agent,
   * or is refused (a conflict naming why) with the request left open; `reject` records it.
   */
  answerStaffProposal(
    id: string,
    decision: StaffDecision,
  ): Promise<Result<StaffProposalAnswered>> {
    return answerProposal(this.#deps.db, id, decision);
  }

  /** A ULID or a number, as a ticket row. */
  async #resolve(ref: string): Promise<Result<TicketRow>> {
    if (!TicketRef.safeParse(ref).success) {
      return err({
        class: "validation",
        message: `not a ticket id or number: ${ref}`,
        retryable: false,
      });
    }
    return /^\d+$/.test(ref)
      ? getTicketByNum(this.#deps.db, Number(ref))
      : getTicket(this.#deps.db, ref);
  }

  /** Whether a worker's session holds `row`; the operator and orchestrators need not. */
  async #owns(row: TicketRow, actor: Actor): Promise<Result<boolean>> {
    if (actor.kind !== "worker") return ok(true);
    const facts = await getTicketFacts(this.#deps.db, row.id, actor.sessionId);
    return facts.ok
      ? ok(facts.value.actorSession?.ticket_id === row.id)
      : facts;
  }

  async #gitFacts(
    row: TicketRow,
    need: ReadonlySet<PreFact>,
    settings: TicketSettings,
  ): Promise<Result<GitFacts>> {
    const worktrees = await listTicketWorktrees(this.#deps.db, row.id);
    if (!worktrees.ok) return worktrees;
    return ok(
      await gatherGitFacts(
        {
          worktrees: worktrees.value,
          planPath: row.plan_path,
          need,
          planPaths: settings["laws.plan_paths"],
          timeoutMs: settings["laws.git_timeout_ms"],
          workRoot: this.#deps.workRoot,
        },
        this.#deps.git ?? runGit(),
      ),
    );
  }

  /** The repos a code_review round must cover (§3.1); `[]` for a single-repo ticket. */
  async #touchedRepos(
    ticketId: string,
    settings: TicketSettings,
  ): Promise<Result<readonly string[]>> {
    const worktrees = await listTicketWorktrees(this.#deps.db, ticketId);
    if (!worktrees.ok) return worktrees;
    return ok(
      await touchedRepos(
        {
          worktrees: worktrees.value,
          timeoutMs: settings["laws.git_timeout_ms"],
          workRoot: this.#deps.workRoot,
        },
        this.#deps.git ?? runGit(),
      ),
    );
  }

  async #events(
    ticketId: string,
    q: TicketEventsQuery,
  ): Promise<Result<TicketEventsPage>> {
    const page = await listTicketEvents(this.#deps.db, {
      ticket_id: ticketId,
      ...q,
    });
    if (!page.ok) return page;
    const items = toEventViews(page.value.rows);
    return items.ok
      ? ok({
          items: items.value,
          next_cursor: page.value.nextCursor,
          has_more: page.value.hasMore,
        })
      : items;
  }

  async #extras(ticketId: string): Promise<Result<TicketExtras>> {
    const { db } = this.#deps;
    const [links, gates, findings, handoffs, exports, economics] =
      await Promise.all([
        listTicketLinks(db, ticketId),
        listTicketGates(db, ticketId),
        listTicketFindings(db, ticketId),
        listTicketHandoffs(db, ticketId),
        listTicketExports(db, ticketId),
        getTicketEconomics(db, ticketId),
      ]);
    if (!links.ok) return links;
    if (!gates.ok) return gates;
    if (!findings.ok) return findings;
    if (!handoffs.ok) return handoffs;
    if (!exports.ok) return exports;
    if (!economics.ok) return economics;
    const sessions = await listGateSessions(
      db,
      gates.value.map((g) => g.id),
    );
    if (!sessions.ok) return sessions;
    const linkViews = toLinkViews(links.value);
    if (!linkViews.ok) return linkViews;
    const gateViews = toGateViews(gates.value, findings.value, sessions.value);
    if (!gateViews.ok) return gateViews;
    const handoffViews = toHandoffViews(handoffs.value);
    if (!handoffViews.ok) return handoffViews;
    const exportViews = toExportViews(exports.value);
    if (!exportViews.ok) return exportViews;
    const economicsView = toEconomics(economics.value);
    if (!economicsView.ok) return economicsView;
    return ok({
      links: linkViews.value,
      gates: gateViews.value,
      handoffs: handoffViews.value,
      exports: exportViews.value,
      economics: economicsView.value,
    });
  }
}
