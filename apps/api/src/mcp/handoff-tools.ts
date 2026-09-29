// The hand-off tools (§7, §11.1, §8). The row and the ticket are the caller's
// own, found by its session, never named by the model: handoff_write fills the judgement half of
// its writing row, handoff_accept takes its pending hand-off (or claims its unowned ticket) and moves
// the owner, handoff_request inserts session.handoff for it. handoff_read returns a packet as data,
// capped by the server like every result (§8.5).
import { HandoffFacts, renderFacts, sha256Hex } from "@bayon/core";
import type { HandoffRow } from "@bayon/db";
import type { HandoffJudgement } from "@bayon/db/api";
import { MCP_INPUTS } from "@bayon/proto";
import { z } from "zod";
import { resolveTicket } from "./ticket-ref.js";
import {
  done,
  failed,
  invalid,
  refused,
  type Handler,
  type ToolCtx,
  type ToolOutcome,
} from "./tool-kit.js";

type WriteInput = z.infer<typeof MCP_INPUTS.handoff_write>;

const bullets = (items: readonly string[]): string | null =>
  items.length === 0 ? null : items.map((item) => `- ${item}`).join("\n");

/** The tool's lists as the packet's sections (§7.2): bullets, and the next steps numbered. */
export const judgementOf = (input: WriteInput): HandoffJudgement => ({
  goal_line: input.goal_line,
  decisions_md: bullets(input.decisions),
  traps_md: bullets(input.traps),
  next_steps_md: input.next_steps
    .map((step, i) => `${i + 1}. ${step}`)
    .join("\n"),
  open_questions_md: bullets(input.open_questions ?? []),
  pointers: input.pointers ?? [],
});

/** A write's audit target: the caller's ticket, else the caller. */
const auditOf = (ctx: ToolCtx) =>
  ctx.session.ticketId === null
    ? ctx.audit("session", ctx.session.id)
    : ctx.audit("ticket", ctx.session.ticketId);

const handoffWrite: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.handoff_write.parse(raw);
  const written = await ctx.store.writeHandoff(
    ctx.session.id,
    judgementOf(input),
    auditOf(ctx),
  );
  if (written.ok) {
    return done({
      handoff_id: written.value.id,
      ticket_id: written.value.ticket_id,
    });
  }
  // An edge out of handoff_writing sealed the row, or no hand-off was requested.
  return written.error.class === "conflict"
    ? refused({
        reason: "not_writable",
        rule: "handoff_write",
        detail: `${written.error.message}; handoff_request starts one`,
      })
    : failed(written.error);
};

const handoffAccept: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.handoff_accept.parse(raw);
  const accepted = await ctx.store.acceptHandoff(
    ctx.session.id,
    input.id,
    auditOf(ctx),
  );
  if (!accepted.ok) return failed(accepted.error);
  const a = accepted.value;
  if (a.kind === "refused") {
    return refused({
      reason: a.reason,
      rule: "handoff_accept",
      detail: a.detail,
    });
  }
  return done({
    ticket_id: a.ticket_id,
    owner_session_id: ctx.session.id,
    handoff_id: a.handoff?.id ?? null,
    accepted_at: a.handoff?.accepted_at ?? null,
    created: a.created,
  });
};

/** One session.handoff per session and note: a retried call returns the first command. */
const handoffRequest: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.handoff_request.parse(raw);
  if (ctx.session.ticketId === null) {
    return refused({
      reason: "not_found",
      detail: "this session holds no ticket: there is nothing to hand off",
    });
  }
  const note = input.note?.trim() ?? "";
  const digest = (await sha256Hex(note)).slice(0, 16);
  const inserted = await ctx.store.insertCommand(
    {
      type: "session.handoff",
      payload: {
        session_id: ctx.session.id,
        reason: "agent_request",
        ...(note === "" ? {} : { note }),
      },
    },
    ctx.audit("session", ctx.session.id),
    `mcp.handoff_request:${ctx.session.id}:${digest}`,
  );
  return inserted.ok
    ? done({
        command_id: inserted.value.id,
        session_id: ctx.session.id,
        created: inserted.value.created,
      })
    : failed(inserted.error);
};

const Pointers = z.array(z.string());

/** A JSON column's value; undefined when it is not JSON, and the packet then shows none of it. */
function parsed(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

/** The packet as data: its facts as the packet renders them (§7.2), its judgement as written. */
function packetOf(row: HandoffRow) {
  const facts = HandoffFacts.safeParse(parsed(row.facts_json));
  const pointers = Pointers.safeParse(
    row.pointers_json === null ? [] : parsed(row.pointers_json),
  );
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    reason: row.reason,
    quality: row.quality,
    from_session_id: row.from_session_id,
    to_session_id: row.to_session_id,
    accepted_at: row.accepted_at,
    created_at: row.created_at,
    packet_path: row.packet_path,
    facts: facts.success ? renderFacts(facts.data) : null,
    goal_line: row.goal_line,
    decisions_md: row.decisions_md,
    traps_md: row.traps_md,
    next_steps_md: row.next_steps_md,
    open_questions_md: row.open_questions_md,
    pointers: pointers.success ? pointers.data : [],
  };
}

type ToRead =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly outcome: ToolOutcome };

/** The ticket whose latest hand-off to read: the one named, else the caller's. */
async function ticketToRead(
  ctx: ToolCtx,
  ref: string | undefined,
): Promise<ToRead> {
  if (ref !== undefined) {
    const resolved = await resolveTicket(ctx, ref);
    return resolved.ok ? { ok: true, id: resolved.target.id } : resolved;
  }
  return ctx.session.ticketId === null
    ? {
        ok: false,
        outcome: refused({
          reason: "not_found",
          detail: "this session holds no ticket",
        }),
      }
    : { ok: true, id: ctx.session.ticketId };
}

const handoffRead: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.handoff_read.parse(raw);
  if (input.id !== undefined && input.ticket !== undefined) {
    return invalid("name a hand-off id or a ticket, not both");
  }
  if (input.id !== undefined) {
    const row = await ctx.store.handoff(input.id);
    if (!row.ok) return failed(row.error);
    if (row.value === null) {
      return refused({
        reason: "not_found",
        detail: `no hand-off ${input.id}`,
      });
    }
    // By id too, a project's orchestrator reads only its project's packets.
    const own = await resolveTicket(ctx, row.value.ticket_id);
    return own.ok ? done(packetOf(row.value)) : own.outcome;
  }
  const ticket = await ticketToRead(ctx, input.ticket);
  if (!ticket.ok) return ticket.outcome;
  const chain = await ctx.store.ticketHandoffs(ticket.id);
  if (!chain.ok) return failed(chain.error);
  const latest = chain.value.at(-1);
  return latest === undefined
    ? refused({
        reason: "not_found",
        detail: `ticket ${ticket.id} has no hand-off`,
      })
    : done(packetOf(latest));
};

export const HANDOFF_HANDLERS: Readonly<Partial<Record<string, Handler>>> = {
  handoff_write: handoffWrite,
  handoff_read: handoffRead,
  handoff_accept: handoffAccept,
  handoff_request: handoffRequest,
};
