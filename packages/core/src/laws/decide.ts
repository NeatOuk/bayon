import { noEdge } from "./refusal.js";
import { checkRequirement } from "./requirements.js";
import type { RefusalReason } from "./statuses.js";
import { resolveEdge } from "./table.js";
import type { Decision, LawInput, Refusal } from "./types.js";

/**
 * The law for one transition, pure and total. The order is fixed and the first failure is the
 * one reported: the edge exists, the actor may take it, a worker owns the ticket, then each
 * requirement in row order.
 */
export function decide(i: LawInput): Decision {
  const edge = resolveEdge(
    i.ticket.status,
    i.to,
    i.facts.priorStatus,
    i.actor.kind,
  );
  if (edge === undefined) return noEdge(i.ticket.status, i.to);
  const refuse = (reason: RefusalReason, detail: string): Refusal => ({
    allowed: false,
    rule: edge.rule,
    reason,
    detail,
  });
  const actor = i.actor;
  if (!edge.actors.includes(actor.kind)) {
    return refuse(
      "actor_not_allowed",
      `${edge.rule} is for ${edge.actors.join(" or ")}, not ${actor.kind}`,
    );
  }
  if (
    edge.ownOnly &&
    actor.kind === "worker" &&
    i.facts.actorSession?.ticketId !== i.ticket.id
  ) {
    return refuse(
      "cross_ticket_write",
      `session ${actor.sessionId} does not hold ticket ${i.ticket.id}`,
    );
  }
  for (const requirement of edge.requires) {
    const failed = checkRequirement(requirement, i);
    if (failed !== null) return refuse(failed.reason, failed.detail);
  }
  return { allowed: true, rule: edge.rule };
}
