import { z } from "zod";

// The hand-off vocabulary the supervisor and the API share.

/**
 * `handoffs.quality`: `writing` while the session is writing its hand-off (never takeable), then
 * `full` or `degraded` once the supervisor finalized the packet (§7.4).
 */
export const HandoffQuality = z.enum(["writing", "full", "degraded"]);
export type HandoffQuality = z.infer<typeof HandoffQuality>;

/** The session roles that may hold a ticket: a reviewer or an orchestrator never does. */
export const HOLDING_ROLES: readonly string[] = ["builder", "investigator"];

/** Ticket statuses no session holds (§3.2's exit law: done or blocked; closed, parked, split). */
export const UNHELD_STATUSES: readonly string[] = [
  "done",
  "blocked",
  "rejected",
  "parked",
  "split",
];

export interface HoldingSession {
  readonly id: string;
  readonly role: string;
  readonly ticket_id: string | null;
  readonly handoff_in_id: string | null;
}

export interface HoldingTicket {
  readonly id: string;
  readonly status: string;
  readonly owner_session_id: string | null;
}

/**
 * Whether session `s` holds ticket `t`. A successor (its `handoff_in_id`
 * set) holds it only once it accepted, i.e. owns it; any other session holds the open ticket it
 * carries when its role is a holding role. A held ticket must end in a hand-off row.
 */
export function holdsTicket(
  s: HoldingSession,
  t: HoldingTicket | null,
): boolean {
  if (t === null || s.ticket_id !== t.id) return false;
  if (UNHELD_STATUSES.includes(t.status)) return false;
  if (s.handoff_in_id !== null) return t.owner_session_id === s.id;
  return HOLDING_ROLES.includes(s.role);
}
