// The ticket tools. Every one goes through TicketService and its
// §3.2 laws; none re-implements one. A write is scoped first: writeScope refuses a cross-ticket
// write before the service is called. The service's refusals map onto the closed MCP reasons in one
// table (refusals.ts). Each write hands its audit entry to the service's writer transaction (§6).
import {
  LawRefusalCause,
  type Actor,
  type FrmError,
  type Result,
} from "@bayon/core";
import {
  CommentRequest,
  CreateTicketRequest,
  LinkRequest,
  MCP_INPUTS,
  MCP_PAGE_ROWS,
  PatchTicketRequest,
  TicketsQuery,
  TransitionRequest,
  type TicketDetail,
  type TicketView,
} from "@bayon/proto";
import { z } from "zod";
import type { TicketService } from "../tickets/ticket-service.js";
import { findingResolve } from "./finding-tools.js";
import { MCP_REASON_OF_LAW } from "./refusals.js";
import { heldProject, outsideProject, writeScope } from "./scope.js";
import { resolveTicket, type Resolved } from "./ticket-ref.js";
import {
  done,
  excerpt,
  failed,
  invalid,
  refused,
  type Handler,
  type ToolCtx,
  type ToolOutcome,
} from "./tool-kit.js";

/** ticket_get's default body window: the body, recent events and answers stay under the cap. */
const TICKET_BODY_WINDOW = 2048;
const EVENTS_SHOWN = 10;
const ANSWERS_SHOWN = 4;
/** ticket_get's open findings: the most severe first, the rest counted. */
const FINDINGS_SHOWN = 10;
const SEVERITY_RANK: Readonly<Record<string, number>> = {
  blocker: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

/** The latest attempt of each (kind, repo), as ticket_get lists gates. */
function latestGates(gates: TicketDetail["gates"]): TicketDetail["gates"] {
  const latest = new Map<string, TicketDetail["gates"][number]>();
  for (const g of gates) {
    const key = `${g.kind}\u0000${g.repo_id ?? ""}`;
    const seen = latest.get(key);
    if (seen === undefined || g.attempt > seen.attempt) latest.set(key, g);
  }
  return [...latest.values()];
}

/** Every open finding on any attempt (they block until resolved, §10.3), most severe first. */
const openFindings = (gates: TicketDetail["gates"]) =>
  gates
    .flatMap((g) => g.findings.filter((f) => f.status === "open"))
    .toSorted(
      (a, b) =>
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
    );

/** §3.2's actor for a session: the orchestrator by role, every other role a worker. */
const lawActor = (ctx: ToolCtx): Actor =>
  ctx.session.role === "orchestrator"
    ? { kind: "orchestrator", sessionId: ctx.session.id }
    : { kind: "worker", sessionId: ctx.session.id };

const StaleWrite = z.object({ current_version: z.int().nonnegative() });

/** A service error as a tool outcome: its refusals as MCP refusals, the rest as failures. */
export function fromService(e: FrmError): ToolOutcome {
  if (e.class === "law_refused") {
    const cause = LawRefusalCause.safeParse(e.cause);
    if (cause.success) {
      return refused({
        reason: MCP_REASON_OF_LAW[cause.data.reason],
        rule: cause.data.rule,
        detail: `${cause.data.reason}: ${cause.data.detail}`,
      });
    }
  }
  if (e.class === "conflict") {
    const stale = StaleWrite.safeParse(e.cause);
    return refused({
      reason: "version_conflict",
      detail: e.message,
      ...(stale.success ? { current_version: stale.data.current_version } : {}),
    });
  }
  if (e.class === "not_found") {
    return refused({ reason: "not_found", detail: e.message });
  }
  return failed(e);
}

/** As `resolveTicket`, and only a ticket this session may write (§11.1 "own"). */
async function scoped(ctx: ToolCtx, ref: string): Promise<Resolved> {
  const resolved = await resolveTicket(ctx, ref);
  if (!resolved.ok) return resolved;
  const scope = writeScope(ctx.actor, resolved.target.id);
  return scope.allowed
    ? resolved
    : { ok: false, outcome: refused({ reason: scope.reason }) };
}

const noTickets = (): ToolOutcome =>
  failed({
    class: "internal",
    message: "the tickets module is not mounted",
    retryable: false,
  });

/** Runs `body` with the tickets module, or fails when the API mounts none. */
const withTickets =
  (
    body: (
      ctx: ToolCtx,
      tickets: TicketService,
      raw: unknown,
    ) => Promise<ToolOutcome>,
  ): Handler =>
  (ctx, raw) =>
    ctx.tickets === undefined
      ? Promise.resolve(noTickets())
      : body(ctx, ctx.tickets, raw);

const parsed = <T>(
  result: z.ZodSafeParseResult<T>,
):
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly outcome: ToolOutcome } =>
  result.success
    ? { ok: true, value: result.data }
    : { ok: false, outcome: invalid(z.prettifyError(result.error)) };

/** A project's orchestrator searches only its project; anyone else, the fleet. */
const ticketSearch = withTickets(async (ctx, tickets, raw) => {
  const input = MCP_INPUTS.ticket_search.parse(raw);
  const project = heldProject(ctx.actor);
  const query = parsed(
    TicketsQuery.safeParse({
      q: input.q,
      limit: MCP_PAGE_ROWS,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(project === null ? {} : { workspace_id: project }),
    }),
  );
  if (!query.ok) return query.outcome;
  const found = await tickets.list(query.value);
  if (!found.ok) return fromService(found.error);
  return done({
    rows: found.value.items.map((t) => ({
      id: t.id,
      key: t.key,
      num: t.num,
      title: t.title,
      status: t.status,
      priority: t.priority,
      needs_human: t.needs_human,
      version: t.version,
    })),
    next_cursor: found.value.has_more ? String(found.value.next_cursor) : null,
  });
});

const ticketGet = withTickets(async (ctx, tickets, raw) => {
  const input = MCP_INPUTS.ticket_get.parse(raw);
  const target = await resolveTicket(ctx, input.ticket);
  if (!target.ok) return target.outcome;
  const detail = await tickets.get(String(target.target.num), lawActor(ctx));
  if (!detail.ok) return fromService(detail.error);
  const { ticket: t, transitions, events, links, gates } = detail.value;
  const open = openFindings(gates);
  const answers = await ctx.store.humanRequests(t.id, ANSWERS_SHOWN);
  if (!answers.ok) return failed(answers.error);
  const offset = input.offset ?? 0;
  const body = t.body_md.slice(
    offset,
    offset + (input.limit ?? TICKET_BODY_WINDOW),
  );
  const end = offset + body.length;
  return done({
    ticket: {
      id: t.id,
      key: t.key,
      num: t.num,
      title: t.title,
      type: t.type,
      status: t.status,
      priority: t.priority,
      version: t.version,
      needs_human: t.needs_human,
      owner_session_id: t.owner_session_id,
      parent_ticket_id: t.parent_ticket_id,
      plan_path: t.plan_path,
      pr_url: t.pr_url,
      blocked_reason: t.blocked_reason,
      unblock_condition: t.unblock_condition,
    },
    body_md: body,
    body_offset: offset,
    body_total: t.body_md.length,
    next_offset: end < t.body_md.length ? end : null,
    acceptance_md: excerpt(t.acceptance_md, 500),
    transitions: transitions
      .filter((o) => o.allowed)
      .map((o) => ({
        to: o.to,
        rule: o.rule,
        ...(o.input === undefined ? {} : { input: [...o.input] }),
      })),
    events: events.items.slice(-EVENTS_SHOWN).map((e) => ({
      id: e.id,
      ts: e.ts,
      kind: e.kind,
      actor: `${e.actor_kind}:${e.actor_id ?? ""}`,
      from: e.from_status,
      to: e.to_status,
      reason: e.reason,
    })),
    links: links.map((l) => ({
      kind: l.kind,
      target: l.target_ticket_id,
      url: l.url,
    })),
    gates: latestGates(gates).map((g) => ({
      id: g.id,
      kind: g.kind,
      repo_id: g.repo_id,
      attempt: g.attempt,
      state: g.state,
      reason: g.reason,
    })),
    open_findings: open.slice(0, FINDINGS_SHOWN).map((f) => ({
      id: f.id,
      severity: f.severity,
      file: f.file,
      line: f.line,
      summary: excerpt(f.summary, 200),
    })),
    open_findings_total: open.length,
    human_requests: answers.value.map((h) => ({
      id: h.id,
      kind: h.kind,
      asked_at: h.asked_at,
      question: excerpt(h.question),
      status: h.status,
      answer: h.answer_json,
      answered_at: h.answered_at,
    })),
  });
});

/**
 * Files a backlog ticket. A project's orchestrator files into its project, and a probe
 * fingerprint another project (or none) already filed is refused rather than shown to it.
 */
const ticketCreate = withTickets(async (ctx, tickets, raw) => {
  const input = MCP_INPUTS.ticket_create.parse(raw);
  const parent =
    input.parent === undefined
      ? undefined
      : await resolveTicket(ctx, input.parent);
  if (parent !== undefined && !parent.ok) return parent.outcome;
  const project = heldProject(ctx.actor);
  const body = parsed(
    CreateTicketRequest.safeParse({
      title: input.title,
      type: input.type,
      ...(input.body_md === undefined ? {} : { body_md: input.body_md }),
      ...(parent === undefined ? {} : { parent_ticket_id: parent.target.id }),
      ...(project === null ? {} : { workspace_id: project }),
    }),
  );
  if (!body.ok) return body.outcome;
  if (input.fingerprint !== undefined && ctx.session.role !== "orchestrator") {
    return refused({
      reason: "actor_not_allowed",
      detail: "only the orchestrator files a probe finding's ticket",
    });
  }
  const audit = ctx.audit("ticket", null); // the writer names the new ticket as the target
  const filed =
    input.fingerprint === undefined
      ? await tickets.create(body.value, lawActor(ctx), audit)
      : await tickets.createFromProbe(
          body.value,
          input.fingerprint,
          lawActor(ctx),
          audit,
        );
  if (!filed.ok) return fromService(filed.error);
  const [t, duplicate] =
    "created" in filed.value
      ? [filed.value.ticket, !filed.value.created]
      : [filed.value, false];
  const outside = duplicate ? outsideProject(ctx.actor, t.workspace_id) : null;
  if (outside !== null) {
    return refused({
      reason: "cross_project",
      detail: `that fingerprint is already filed: ${outside}`,
    });
  }
  return done({
    id: t.id,
    key: t.key,
    num: t.num,
    status: t.status,
    needs_human: t.needs_human,
    version: t.version,
    // A fingerprint already filed: this is the first call's ticket, and nothing was written.
    ...(duplicate ? { duplicate: true } : {}),
  });
});

type UpdateInput = z.infer<typeof MCP_INPUTS.ticket_update>;
type Target = Extract<Resolved, { readonly ok: true }>["target"];

/** A service write's result as ticket_update's answer. */
function updated(result: Result<TicketView>): ToolOutcome {
  if (!result.ok) return fromService(result.error);
  const t = result.value;
  return done({ id: t.id, key: t.key, status: t.status, version: t.version });
}

/**
 * A status move under the laws. A plan_path rides only with plan_review: one
 * transaction sets it and submits the plan, and submit_plan's checks judge the row with it set.
 */
async function ticketMove(
  ctx: ToolCtx,
  tickets: TicketService,
  input: UpdateInput & { readonly status: string },
  target: Target,
): Promise<ToolOutcome> {
  if (input.title !== undefined || input.body_md !== undefined) {
    return invalid("move the status or edit fields, not both in one call");
  }
  if (input.plan_path !== undefined && input.status !== "plan_review") {
    return invalid(
      "plan_path moves only with status plan_review (submitting the plan), or alone",
    );
  }
  const body = parsed(
    TransitionRequest.safeParse({
      to: input.status,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.blocked_reason === undefined
        ? {}
        : { blocked_reason: input.blocked_reason }),
      ...(input.unblock_condition === undefined
        ? {}
        : { unblock_condition: input.unblock_condition }),
    }),
  );
  if (!body.ok) return body.outcome;
  return updated(
    await tickets.transition(
      String(target.num),
      input.version,
      body.value,
      lawActor(ctx),
      ctx.audit("ticket", target.id),
      input.plan_path === undefined ? {} : { plan_path: input.plan_path },
    ),
  );
}

/** A field edit under the PATCH laws: title, body_md, plan_path. */
async function ticketEdit(
  ctx: ToolCtx,
  tickets: TicketService,
  input: UpdateInput,
  target: Target,
): Promise<ToolOutcome> {
  const body = parsed(
    PatchTicketRequest.safeParse({
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.body_md === undefined ? {} : { body_md: input.body_md }),
      ...(input.plan_path === undefined ? {} : { plan_path: input.plan_path }),
    }),
  );
  if (!body.ok) return body.outcome;
  return updated(
    await tickets.update(
      String(target.num),
      input.version,
      body.value,
      lawActor(ctx),
      ctx.audit("ticket", target.id),
    ),
  );
}

/**
 * A status in the input moves the ticket (the laws decide); other fields edit it (PATCH laws). A
 * plan_path is the holder's alone: the orchestrator writes any ticket, but never a worker's plan.
 */
const ticketUpdate = withTickets(async (ctx, tickets, raw) => {
  const input = MCP_INPUTS.ticket_update.parse(raw);
  const target = await scoped(ctx, input.ticket);
  if (!target.ok) return target.outcome;
  if (
    input.plan_path !== undefined &&
    ctx.session.ticketId !== target.target.id
  ) {
    return refused({
      reason: "cross_ticket_write",
      detail: "only the session holding a ticket sets its plan_path",
    });
  }
  const { status } = input;
  return status === undefined
    ? ticketEdit(ctx, tickets, input, target.target)
    : ticketMove(ctx, tickets, { ...input, status }, target.target);
});

const ticketComment = withTickets(async (ctx, tickets, raw) => {
  const input = MCP_INPUTS.ticket_comment.parse(raw);
  const target = await scoped(ctx, input.ticket);
  if (!target.ok) return target.outcome;
  const body = parsed(CommentRequest.safeParse({ body_md: input.body_md }));
  if (!body.ok) return body.outcome;
  const event = await tickets.comment(
    String(target.target.num),
    body.value,
    lawActor(ctx),
    ctx.audit("ticket", target.target.id),
  );
  if (!event.ok) return fromService(event.error);
  return done({
    event_id: event.value.id,
    ts: event.value.ts,
  });
});

const ticketLink = withTickets(async (ctx, tickets, raw) => {
  const input = MCP_INPUTS.ticket_link.parse(raw);
  const source = await scoped(ctx, input.ticket);
  if (!source.ok) return source.outcome;
  const to = await resolveTicket(ctx, input.to);
  if (!to.ok) return to.outcome;
  const body = parsed(
    LinkRequest.safeParse({
      kind: input.kind,
      target: String(to.target.num),
    }),
  );
  if (!body.ok) return body.outcome;
  const link = await tickets.link(
    String(source.target.num),
    body.value,
    lawActor(ctx),
    ctx.audit("ticket", source.target.id),
  );
  if (!link.ok) return fromService(link.error);
  return done({
    kind: link.value.kind,
    target_ticket_id: link.value.target_ticket_id,
  });
});

/** A PR url or doc path on the session's own ticket: a url is a link, a path a comment. */
const artifactAttach = withTickets(async (ctx, tickets, raw) => {
  const input = MCP_INPUTS.artifact_attach.parse(raw);
  if (ctx.session.ticketId === null) {
    return refused({
      reason: "cross_ticket_write",
      detail: "this session holds no ticket",
    });
  }
  const own = await resolveTicket(ctx, ctx.session.ticketId);
  if (!own.ok) return own.outcome;
  const ref = String(own.target.num);
  const note = input.note === undefined ? "" : ` — ${input.note}`;
  const isUrl = z.url().safeParse(input.ref).success;
  const written = isUrl
    ? await tickets.link(
        ref,
        { kind: `artifact_${input.kind}`, url: input.ref },
        lawActor(ctx),
        ctx.audit("ticket", own.target.id),
      )
    : await tickets.comment(
        ref,
        { body_md: `Artifact (${input.kind}): ${input.ref}${note}` },
        lawActor(ctx),
        ctx.audit("ticket", own.target.id),
      );
  if (!written.ok) return fromService(written.error);
  return done({ attached: input.kind, ref: input.ref });
});

export const TICKET_HANDLERS: Readonly<Partial<Record<string, Handler>>> = {
  ticket_search: ticketSearch,
  ticket_get: ticketGet,
  ticket_create: ticketCreate,
  ticket_update: ticketUpdate,
  ticket_comment: ticketComment,
  ticket_link: ticketLink,
  artifact_attach: artifactAttach,
  finding_resolve: findingResolve,
};
