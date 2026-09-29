// The non-ticket tools: mission, mailbox, memory and human_ask. Lists
// page at 20 rows and bodies are windowed. The ticket tools live in ticket-tools.ts.
import { MCP_BODY_WINDOW, MCP_INPUTS, MCP_PAGE_ROWS } from "@bayon/proto";
import { CONFORMANCE_HANDLERS } from "./conformance-tools.js";
import { DOCS_HANDLERS } from "./docs-tools.js";
import { HANDOFF_HANDLERS } from "./handoff-tools.js";
import { ORCHESTRATOR_HANDLERS } from "./orchestrator-tools.js";
import { writeScope } from "./scope.js";
import { resolveTicket } from "./ticket-ref.js";
import { TICKET_HANDLERS } from "./ticket-tools.js";
import {
  EXCERPT,
  badCursor,
  done,
  excerpt,
  failed,
  offsetOf,
  page,
  refused,
  type Handler,
} from "./tool-kit.js";

export type { ToolCtx, ToolOutcome } from "./tool-kit.js";

/** The widest inbox a page can reach: listInbox's own limit. */
const INBOX_MAX = 1000;
/** The widest knowledge search a page can reach: searchKnowledge's own limit. */
const SEARCH_MAX = 100;

const missionRead: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.mission_read.parse(raw);
  const mission = await ctx.store.mission(ctx.session.agentId);
  if (!mission.ok) return failed(mission.error);
  if (mission.value === null) return done({ mission: null });
  const { version, text: full } = mission.value;
  const offset = input.offset ?? 0;
  const text = full.slice(offset, offset + (input.limit ?? MCP_BODY_WINDOW));
  const end = offset + text.length;
  return done({
    version,
    total_chars: full.length,
    offset,
    text,
    next_offset: end < full.length ? end : null,
  });
};

const mailboxSend: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.mailbox_send.parse(raw);
  const sent = await ctx.store.sendMessage(
    {
      from_kind: "session",
      from_id: ctx.session.id,
      to_kind: "agent",
      to_id: input.to,
      kind: "note",
      subject: input.subject,
      body_md: input.body_md,
      ...(ctx.session.ticketId === null
        ? {}
        : { ticket_id: ctx.session.ticketId }),
    },
    ctx.audit("agent", input.to),
  );
  return sent.ok
    ? done({ id: sent.value.id, ts: sent.value.ts })
    : failed(sent.error);
};

/**
 * The rows it returns are read from now on; `read` says whether one was before this
 * call. Those rows leave an unread-only listing, so its next page starts where this one did.
 */
const mailboxInbox: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.mailbox_inbox.parse(raw);
  const unreadOnly = input.unread_only === true;
  const offset = offsetOf(input.cursor, INBOX_MAX);
  if (offset === null) return badCursor();
  const rows = await ctx.store.inbox(ctx.session.agentName, {
    unreadOnly,
    limit: offset + MCP_PAGE_ROWS + 1,
  });
  if (!rows.ok) return failed(rows.error);
  const p = page(rows.value, offset);
  const marked = await ctx.store.markRead(
    ctx.session.agentName,
    p.rows.filter((m) => m.read_at === null).map((m) => m.id),
  );
  if (!marked.ok) return failed(marked.error);
  const next =
    unreadOnly && p.next_cursor !== null ? String(offset) : p.next_cursor;
  return done({
    rows: p.rows.map((m) => ({
      id: m.id,
      ts: m.ts,
      from: `${m.from_kind}:${m.from_id}`,
      subject: m.subject,
      body_md: excerpt(m.body_md),
      body_truncated: m.body_md.length > EXCERPT,
      read: m.read_at !== null,
    })),
    next_cursor: next,
  });
};

const memorySearch: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.memory_search.parse(raw);
  const offset = offsetOf(input.cursor, SEARCH_MAX);
  if (offset === null) return badCursor();
  const rows = await ctx.store.searchKnowledge(
    input.q,
    offset + MCP_PAGE_ROWS + 1,
  );
  if (!rows.ok) return failed(rows.error);
  const p = page(rows.value, offset);
  return done({
    rows: p.rows.map((k) => ({
      id: k.id,
      kind: k.kind,
      title: k.title,
      status: k.status,
      body_md: excerpt(k.body_md),
    })),
    next_cursor: p.next_cursor,
  });
};

const memoryAppend: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.memory_append.parse(raw);
  const entry = await ctx.store.appendKnowledge(
    {
      scope: "global",
      kind: input.kind,
      title: input.title,
      body_md: input.body_md,
      source_session_id: ctx.session.id,
      ...(ctx.session.ticketId === null
        ? {}
        : { source_ticket_id: ctx.session.ticketId }),
    },
    ctx.audit("session", ctx.session.id),
  );
  return entry.ok
    ? done({ id: entry.value.id, status: entry.value.status })
    : failed(entry.error);
};

/**
 * Contract 5: opens the requests and returns at once; the session's state never changes. The ticket
 * waits instead: it is not staffed again until the operator answers. A question still
 * open on the ticket is not asked twice: its request comes back under `already_open`.
 */
const humanAsk: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.human_ask.parse(raw);
  const target =
    input.ticket === undefined
      ? undefined
      : await resolveTicket(ctx, input.ticket);
  if (target !== undefined && !target.ok) return target.outcome;
  const named = target?.ok === true ? target.target.id : null;
  const ticket = named ?? ctx.session.ticketId;
  const scope = writeScope(ctx.actor, named);
  if (!scope.allowed) return refused({ reason: scope.reason });
  const opened = await ctx.store.askHuman(
    input.questions.map((q) => ({
      session_id: ctx.session.id,
      ...(ticket === null ? {} : { ticket_id: ticket }),
      kind: "decision",
      question: q.question,
      options: q.options,
      ...(q.recommendation === undefined
        ? {}
        : { context_md: `Recommendation: ${q.recommendation}` }),
    })),
    ctx.audit(ticket === null ? "session" : "ticket", ticket ?? ctx.session.id),
  );
  if (!opened.ok) return failed(opened.error);
  const ids = opened.value.rows.map((r) => r.id);
  const { reused } = opened.value;
  return done({
    request_id: ids[0] ?? null,
    request_ids: ids,
    status: "open",
    ...(reused.length === 0 ? {} : { already_open: [...reused] }),
  });
};

export const HANDLERS: Readonly<Partial<Record<string, Handler>>> = {
  ...TICKET_HANDLERS,
  ...ORCHESTRATOR_HANDLERS,
  ...DOCS_HANDLERS,
  ...HANDOFF_HANDLERS,
  ...CONFORMANCE_HANDLERS,
  mission_read: missionRead,
  mailbox_send: mailboxSend,
  mailbox_inbox: mailboxInbox,
  memory_search: memorySearch,
  memory_append: memoryAppend,
  human_ask: humanAsk,
};
