import {
  STAFF_APPROVAL_KIND,
  type Actor,
  type Result,
  type StaffDecision,
} from "@bayon/core";
import type { Db } from "@bayon/db";
import { answerStaffProposal, type StaffProposalAnswered } from "@bayon/db/api";
import { lawDecider } from "./law-decider.js";
import { actorRef, loadGateSettings } from "./law-facts.js";

// The operator's answer to an orchestrator's staffing proposal, from the inbox. An
// approval staffs the proposed agent as the operator, under the same `staff` law REST staffing
// meets, in the answer's own transaction; a rejection records the answer.

const OPERATOR: Actor = { kind: "operator" };

export async function answerProposal(
  db: Db,
  id: string,
  decision: StaffDecision,
): Promise<Result<StaffProposalAnswered>> {
  const gateSettings = await loadGateSettings(db);
  return answerStaffProposal(
    db,
    { id, decision, answered_by: OPERATOR.kind, by: actorRef(OPERATOR) },
    lawDecider(OPERATOR, { to: "staffed" }, "staff", undefined, gateSettings),
    {
      actor: OPERATOR.kind,
      action: "rest.inbox_answer",
      target_kind: "human_request",
      target_id: id,
      payload: { kind: STAFF_APPROVAL_KIND, decision },
    },
  );
}
