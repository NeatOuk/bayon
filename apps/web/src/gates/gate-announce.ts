import { gateName, stateLabel, type GateFacts } from "@/gates/gate-model";

// What a screen reader hears when the `gates` topic moves a gate: one line per
// gate slot (ticket, kind, repo), compared frame to frame. A rerun is a new row at the next attempt
// in the same slot, so it reads as that slot's change, not as one gate leaving and another arriving.

/** One gate slot as it reads now. */
export interface GateLine {
  readonly key: string;
  readonly subject: string;
  readonly state: string;
}

/** The ticket a queue row names; a ticket's own strip needs none. */
export interface LineTicket {
  readonly id: string;
  readonly key: string;
}

export function gateLine(
  gate: Pick<GateFacts, "kind" | "repo_id" | "attempt" | "state" | "reason">,
  ticket?: LineTicket,
): GateLine {
  return {
    key: [ticket?.id ?? "", gate.kind, gate.repo_id ?? ""].join("|"),
    subject:
      ticket === undefined
        ? gateName(gate)
        : `${gateName(gate)} on ${ticket.key}`,
    state: `#${gate.attempt} ${stateLabel(gate)}`,
  };
}

/** Every slot's state in one string: equal signatures mean nothing to announce. */
export const lineSignature = (lines: readonly GateLine[]): string =>
  lines.map((line) => `${line.key}=${line.state}`).join("\n");

/**
 * What changed from `before` to `after`, as one sentence per slot: a new or moved slot reads with
 * its state, a slot that is gone reads as having left. Empty when nothing changed.
 */
export function gateChanges(
  before: readonly GateLine[],
  after: readonly GateLine[],
): string {
  const was = new Map(before.map((line) => [line.key, line.state]));
  const now = new Set(after.map((line) => line.key));
  const moved = after
    .filter((line) => was.get(line.key) !== line.state)
    .map((line) => `${line.subject}: ${line.state}.`);
  const left = before
    .filter((line) => !now.has(line.key))
    .map((line) => `${line.subject}: left the list.`);
  return [...moved, ...left].join(" ");
}
