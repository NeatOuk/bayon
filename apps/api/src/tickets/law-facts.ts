import {
  GATE_SETTING_KEYS,
  readGateSettings,
  type Actor,
  type GateSettings,
  type Result,
} from "@bayon/core";
import {
  gateFacts,
  getSettings,
  lintGateRepos,
  isMultiRepo,
  lawFacts,
  lawTicket,
  parseStatus,
  type Db,
  type TicketFactsSnapshot,
} from "@bayon/db";
import type { TicketActor, TransitionFacts } from "@bayon/db/api";

// The API's side of the laws. The pure row → law mappers live in @bayon/db, shared with the
// supervisor's blockTicket; re-exported here for the API's callers. What
// stays is what knows the API's actors, and the per-request settings read.

export {
  gateFacts,
  lintGateRepos,
  isMultiRepo,
  lawFacts,
  lawTicket,
  parseStatus,
};

/** The gate settings (gates.*), read per request; an invalid row makes the gate facts unavailable. */
export async function loadGateSettings(db: Db): Promise<Result<GateSettings>> {
  const rows = await getSettings(db, Object.values(GATE_SETTING_KEYS));
  return rows.ok ? readGateSettings(rows.value) : rows;
}

/** The acting session's id, or null for the operator (and the supervisor, which no API door yields). */
export const actorSessionId = (actor: Actor): string | null =>
  actor.kind === "orchestrator" || actor.kind === "worker"
    ? actor.sessionId
    : null;

/** Who a write records in ticket_events (contract 4: sessions as `session` + their id). */
export const actorRef = (actor: Actor, reason?: string): TicketActor => ({
  ...(actor.kind === "orchestrator" || actor.kind === "worker"
    ? { actor_kind: "session", actor_id: actor.sessionId }
    : { actor_kind: actor.kind, actor_id: actor.kind }),
  ...(reason === undefined ? {} : { reason }),
});

/** The in-transaction facts, taken for one actor. */
export const snapshotOf = (
  facts: TransitionFacts,
  actor: Actor,
): TicketFactsSnapshot => {
  const sessionId = actorSessionId(actor);
  return {
    ticket: facts.ticket,
    children: facts.children(),
    worktrees: facts.worktrees(),
    ticketSessions: facts.ticketSessions(),
    actorSession: sessionId === null ? null : facts.session(sessionId),
    priorStatus: facts.priorStatus(),
    gates: facts.gates(),
    repos: facts.repos(),
    lintRepos: facts.lintRepos(),
    qaConfigured: facts.qaConfigured(),
    qaCi: facts.qaCi(),
    qaLatest: facts.qaLatest(),
    merge: facts.merge(),
    workspaceKind: facts.workspaceKind(),
    openFindings: facts.openFindings(),
  };
};
