import {
  decidePatch,
  err,
  lawRefused,
  ok,
  phaseBoundary,
  planGateEffects,
  type Actor,
  type EdgeGates,
  type FrmError,
  type GateSettings,
  type Result,
} from "@bayon/core";
import type { AuditEntry, PlanGates, PlanHandoff } from "@bayon/db/api";
import type { StaffRequest } from "@bayon/proto";
import {
  actorSessionId,
  isMultiRepo,
  lintGateRepos,
  parseStatus,
} from "./law-facts.js";
import type { TransitionSet } from "./law-decider.js";

// What a transition or a staffing plans beside its law (moved out of ticket-service.ts):
// the set columns' PATCH law, an edge's gate effects, its phase-boundary hand-off, staffing's audit
// entry, and the refusal a transition whose gate settings could not be read writes nothing with.

/** A transition's set columns, under the PATCH laws: a worker sets them on its own ticket only. */
export function setLaw(
  actor: Actor,
  own: boolean,
  set: TransitionSet,
): Result<void> {
  const fields = Object.keys(set);
  if (fields.length === 0) return ok(undefined);
  const decision = decidePatch({ actor, own, fields });
  return decision.allowed ? ok(undefined) : err(lawRefused(decision));
}

/**
 * An edge's gate effects (M3 amendment h), planned by core over the gates the writer reads in its
 * transaction; undefined for an edge that touches no gate.
 */
export function gatePlan(
  edge: EdgeGates,
  settings: Result<GateSettings>,
): PlanGates | undefined {
  if (edge.opens.length === 0 && edge.supersede.length === 0) return undefined;
  return (facts) =>
    !settings.ok
      ? err(lawFactsUnavailable(settings.error.message))
      : ok(
          planGateEffects({
            edge,
            ticket: {
              non_trivial: facts.ticket.non_trivial === 1,
              plan_path: facts.ticket.plan_path,
            },
            gates: facts.gates(),
            repos: facts.repos(),
            // Read in the same transaction as the gates, from the same one fact the requirement
            // reads: a round opens parity_check and lint_check exactly when
            // an edge asks for them.
            multiRepo: isMultiRepo(facts.workspaceKind(), settings.value),
            lintRepos: lintGateRepos(facts.lintRepos(), settings.value),
            // And pass_review opens the QA gate exactly when pass_harness would read one
            //: the project's own `qa_mode`, no fleet switch over it.
            qaConfigured: facts.qaConfigured(),
            // A CI project's QA gate opens waiting on its pull request.
            qaCi: facts.qaCi(),
          }),
        );
}

/**
 * The edge's phase-boundary effect (§7.1 row four): the ticket's holder has finished its
 * phase when the run class `landed` now asks for is not the one that session carries. `landed` is
 * where the move actually lands (`advanceTo ?? to`), never the edge's nominal target — an earlier change
 * carries a trivial ticket's `submit_plan` past `plan_review` to `planned`, and judging the target
 * would strand exactly that ticket. Undefined for a status the laws do not know.
 */
export function handoffPlan(
  landed: string,
  tier: string,
): PlanHandoff | undefined {
  const status = parseStatus(landed);
  if (status === null) return undefined;
  return (holder) => phaseBoundary(holder.run_class, status, tier);
}

/**
 * Staffing's own audit entry, for a caller that brought none — the operator's REST door
 * (`POST /tickets/:ref/staff`), where nothing else names who asked. The ticket's id is resolved
 * here rather than at the door, which is why this lives beside the call and not in the controller.
 *
 * It matters more since an earlier change: a staffing call that meets a holder silent past
 * `watchdog.silent_ms` queues that session's hand-off, and a wedged one is then killed. Commands
 * carry no actor column, so this row is the only record of who asked for it. An MCP caller's own
 * entry (`mcp.ticket_staff`) always wins.
 */
export const staffAudit = (
  actor: Actor,
  ticketId: string,
  request: StaffRequest,
): AuditEntry => {
  const sessionId = actorSessionId(actor);
  return {
    actor: sessionId === null ? actor.kind : `session:${sessionId}`,
    action: "rest.ticket_staff",
    target_kind: "ticket",
    target_id: ticketId,
    payload: { ...request },
  };
};

/** A transition whose gate settings could not be read writes nothing, rather than guessing. */
export const lawFactsUnavailable = (detail: string): FrmError => ({
  class: "law_refused",
  message: `the gate settings could not be read: ${detail}`,
  retryable: false,
  cause: { rule: "gates", reason: "facts_unavailable", detail },
});
