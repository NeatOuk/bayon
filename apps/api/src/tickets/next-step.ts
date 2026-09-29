import {
  allowedTransitions,
  nextStep,
  ok,
  type Actor,
  type LawFacts,
  type LawTicket,
  type NextStep,
  type Result,
} from "@bayon/core";
import {
  getNextStepFacts,
  type Db,
  type NextStepDbFacts,
  type TicketRow,
} from "@bayon/db";
import type { TicketHolder, TicketReviewing } from "@bayon/proto";

// A ticket's next step: core's nextStep over the laws' own facts — the ones the detail
// view already reads — and the few getNextStepFacts adds. The action is the operator's, so the
// transitions it reads are always the operator's, whoever asked for the detail.

const OPERATOR: Actor = { kind: "operator" };

export interface NextStepRead {
  readonly step: NextStep;
  /** Who holds the ticket, from the same read: the page's holder line and Staff. */
  readonly holder: TicketHolder | null;
  /** A live reviewer on it: staffing refuses while one is. */
  readonly reviewing: TicketReviewing | null;
}

function holderOf(facts: NextStepDbFacts): TicketHolder | null {
  const { holder, starting } = facts;
  if (holder !== null) {
    return {
      kind: "session",
      agent: holder.agent,
      session_id: holder.session_id,
      state: holder.state,
    };
  }
  return starting === null ? null : { kind: "queued", agent: starting.agent };
}

export async function nextStepOf(
  db: Db,
  row: TicketRow,
  ticket: LawTicket,
  facts: LawFacts,
): Promise<Result<NextStepRead>> {
  const more = await getNextStepFacts(db, row.id);
  if (!more.ok) return more;
  const step = nextStep({
    ...more.value,
    ticket: {
      ...ticket,
      needs_human: row.needs_human === 1,
      blocked_reason: row.blocked_reason,
      unblock_condition: row.unblock_condition,
    },
    gates: facts.gates,
    merge: facts.merge,
    transitions: allowedTransitions({ ticket, actor: OPERATOR, facts }),
  });
  return ok({
    step,
    holder: holderOf(more.value),
    reviewing: more.value.reviewing,
  });
}
