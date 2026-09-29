import type { RefusalReason } from "./statuses.js";
import type { Actor, Decision, Refusal } from "./types.js";

// PATCH laws (§3.2, §11.1): the orchestrator and the operator edit any ticket; a worker edits its
// own, may raise needs_human but not clear it, and never reprioritizes or reassigns.

export interface PatchLawInput {
  readonly actor: Actor;
  /** The worker's session holds this ticket. */
  readonly own: boolean;
  /** The patch's field names. */
  readonly fields: readonly string[];
  /** The patch's needs_human value, if it sets one. */
  readonly needsHuman?: boolean;
}

const WORKER_LOCKED: readonly string[] = ["priority", "owner_session_id"];

export function decidePatch(p: PatchLawInput): Decision {
  const refuse = (reason: RefusalReason, detail: string): Refusal => ({
    allowed: false,
    rule: "patch",
    reason,
    detail,
  });
  const actor = p.actor;
  if (actor.kind !== "worker") return { allowed: true, rule: "patch" };
  if (!p.own) {
    return refuse(
      "cross_ticket_write",
      `session ${actor.sessionId} does not hold this ticket`,
    );
  }
  const locked = p.fields.filter((field) => WORKER_LOCKED.includes(field));
  if (locked.length > 0) {
    return refuse(
      "actor_not_allowed",
      `a worker may not set ${locked.join(", ")}`,
    );
  }
  if (p.needsHuman === false) {
    return refuse(
      "actor_not_allowed",
      "only the operator or an orchestrator clears needs_human",
    );
  }
  return { allowed: true, rule: "patch" };
}

/**
 * The flag follows the questions: needs_human is not cleared while the ticket has an
 * open question, by anyone. Answering the last one clears it. Judged by the PATCH writer inside its
 * transaction, over the count it reads there, so no question asked mid-PATCH slips past. Null: the
 * clear may go ahead.
 */
export function needsHumanHeld(openQuestions: number): Refusal | null {
  if (openQuestions <= 0) return null;
  const n =
    openQuestions === 1 ? "1 open question" : `${openQuestions} open questions`;
  return {
    allowed: false,
    rule: "patch",
    reason: "questions_open",
    detail: `the ticket has ${n} to the operator: answer ${openQuestions === 1 ? "it" : "them"} in the Inbox, and the last answer clears needs_human`,
  };
}
