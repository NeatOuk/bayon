import type { AuditRow, HumanRequestRow, TicketEventRow } from "@bayon/db";
import type { EventItem } from "@bayon/proto";
import { z } from "zod";

// The M1 smoke's pure checks (plan "Verification (M1 close)"). Each returns what is wrong, as
// sentences; an empty list passes. Inputs are the few columns each check reads.

/** One MCP call the script makes, as its `mcp_call` event must record it. */
export interface ExpectedCall {
  readonly tool: string;
  readonly outcome: "ok" | "refused";
  readonly reason?: string;
}

/** One audit row the session must leave; `target_id` is checked only where given. */
export interface ExpectedAudit {
  readonly action: string;
  readonly outcome: string;
  readonly target_id?: string;
}

const CallPayload = z.looseObject({
  outcome: z.string(),
  reason: z.string().optional(),
});
const AuditPayload = z.looseObject({ outcome: z.string() });

const list = (texts: readonly string[]): string =>
  texts.length === 0 ? "none" : texts.join(", ");
const callText = (tool: string, outcome: string, reason?: string): string =>
  `${tool} ${outcome}${reason === undefined ? "" : `:${reason}`}`;

/** The session's `mcp_call` events, in order, each with its outcome and refusal reason. */
export function mcpCallProblems(
  items: readonly EventItem[],
  expected: readonly ExpectedCall[],
): string[] {
  const seen = items.flatMap((item) => {
    if (item.kind !== "mcp_call") return [];
    const p = CallPayload.safeParse(item.payload);
    return p.success
      ? [callText(item.tool_name, p.data.outcome, p.data.reason)]
      : [callText(item.tool_name, "?")];
  });
  const want = expected.map((c) => callText(c.tool, c.outcome, c.reason));
  return seen.join("\n") === want.join("\n")
    ? []
    : [`the mcp calls were ${list(seen)}; expected ${list(want)}`];
}

/** Ticket A's events: at least one the session itself wrote (attributable, §6). */
export function ticketEventProblems(
  rows: readonly Pick<TicketEventRow, "actor_kind" | "actor_id" | "kind">[],
  sessionId: string,
): string[] {
  if (rows.some((r) => r.actor_kind === "session" && r.actor_id === sessionId))
    return [];
  const seen = rows.map(
    (r) => `${r.kind} by ${r.actor_kind}:${r.actor_id ?? ""}`,
  );
  return [`no ticket event by session ${sessionId} (seen: ${list(seen)})`];
}

/** The columns of a filed ticket the follow-up check reads; a TicketRow is one. */
export interface FiledTicket {
  readonly num: number;
  readonly title: string;
  readonly type: string;
  readonly status: string;
  readonly needs_human: number;
}

/** Ticket B: the one ticket the session filed, a follow-up waiting for a human, not retitled. */
export function followupProblems(
  filed: readonly FiledTicket[],
  title: string,
): string[] {
  const b = filed[0];
  if (b === undefined) return ["the session filed no ticket"];
  if (filed.length > 1)
    return [
      `the session filed ${filed.length} tickets (${filed.map((t) => `#${t.num}`).join(", ")}), expected 1`,
    ];
  const at = `#${b.num}`;
  return [
    ...(b.needs_human === 1
      ? []
      : [`${at} is not waiting for a human (needs_human ${b.needs_human})`]),
    ...(b.type === "followup"
      ? []
      : [`${at} is a ${b.type}, expected a followup`]),
    ...(b.title === title
      ? []
      : [
          `${at} is titled "${b.title}", expected "${title}": the refused write landed`,
        ]),
  ];
}

function auditOutcome(payloadJson: string | null): string {
  if (payloadJson === null) return "?";
  try {
    const p = AuditPayload.safeParse(JSON.parse(payloadJson));
    return p.success ? p.data.outcome : "?";
  } catch {
    return "?";
  }
}

const auditText = (
  action: string,
  outcome: string,
  target: string | null | undefined,
): string =>
  target === null || target === undefined
    ? `${action} ${outcome}`
    : `${action} ${outcome} ${target}`;

/** The session's audit rows hold `expected` in order: each landed write and each refused one. */
export function auditProblems(
  rows: readonly Pick<AuditRow, "action" | "target_id" | "payload_json">[],
  expected: readonly ExpectedAudit[],
): string[] {
  let from = 0;
  for (const want of expected) {
    const at = rows.findIndex(
      (r, i) =>
        i >= from &&
        r.action === want.action &&
        auditOutcome(r.payload_json) === want.outcome &&
        (want.target_id === undefined || r.target_id === want.target_id),
    );
    if (at === -1) {
      const seen = rows.map((r) =>
        auditText(r.action, auditOutcome(r.payload_json), r.target_id),
      );
      return [
        `no audit row ${auditText(want.action, want.outcome, want.target_id)} after the ones ` +
          `before it (the session's rows: ${list(seen)})`,
      ];
    }
    from = at + 1;
  }
  return [];
}

/** At the gate, after human_ask returned: exactly one question, open, on ticket A. */
export function askProblems(
  rows: readonly Pick<HumanRequestRow, "question" | "status" | "ticket_id">[],
  ticketId: string,
): string[] {
  const q = rows[0];
  if (q === undefined) return ["the session asked no question"];
  if (rows.length > 1)
    return [`the session asked ${rows.length} questions, expected 1`];
  return [
    ...(q.status === "open"
      ? []
      : [`the question is "${q.status}", expected open`]),
    ...(q.ticket_id === ticketId
      ? []
      : [
          `the question is on ticket ${q.ticket_id ?? "none"}, expected ${ticketId}`,
        ]),
  ];
}
