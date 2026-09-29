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
import { getNextStepFacts, type Db, type TicketRow } from "@bayon/db";

// A ticket's next step: core's nextStep over the laws' own facts — the ones the detail
// view already reads — and the few getNextStepFacts adds. The action is the operator's, so the
// transitions it reads are always the operator's, whoever asked for the detail.

const OPERATOR: Actor = { kind: "operator" };

export async function nextStepOf(
  db: Db,
  row: TicketRow,
  ticket: LawTicket,
  facts: LawFacts,
): Promise<Result<NextStep>> {
  const more = await getNextStepFacts(db, row.id);
  if (!more.ok) return more;
  return ok(
    nextStep({
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
    }),
  );
}
