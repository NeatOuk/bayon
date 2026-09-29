import { HARNESS_OPENS, err, harnessOwed, ok, type Result } from "@bayon/core";
import {
  first,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { GateRow } from "../schema-work.js";
import {
  GATE_ENGINE_ACTOR_ID,
  lawFactsIn,
  openRoundIn,
} from "./advance-ticket.js";
import { insertAudit } from "./audit.js";
import { lawTicket } from "./law-facts.js";
import { SUPERVISOR_ACTOR } from "./system-requests.js";
import type { TicketActor } from "./ticket-common.js";
import { factsOf } from "./ticket-facts.js";

// openOwedHarness (§9.5 amendment, a supervisor gate write beside decideGate and
// advanceTicket): the QA gate a ticket already at `qa_harness` is owed. `pass_review` opens that gate
// as the ticket enters the status, so a ticket that crossed it while its project ran no QA has none,
// and `harnessStep` would wait on it for ever. Core's `harnessOwed` says when one is owed; this opens
// the round `pass_review` would have opened — the table's own `opens`, through advanceTicket's
// `openRoundIn` — `running`, with its `gate` ticket_event, one audit row and **no command** (§9.5:
// commands are the API's; the gate engine's poll starts a gate that never started). One
// BEGIN IMMEDIATE, the facts read inside it, so a repeat finds the gate and writes nothing.

export const OPEN_HARNESS_ACTION = "supervisor.open_harness";

export interface HarnessOpened {
  /** The gates opened: one repo-less `qa_harness`, or none. */
  readonly opened: readonly GateRow[];
  /** Why nothing opened; absent when a gate did. */
  readonly why?: string;
}

const BY: TicketActor = {
  actor_kind: SUPERVISOR_ACTOR,
  actor_id: GATE_ENGINE_ACTOR_ID,
};

/** openOwedHarness inside the caller's write transaction. */
export function openOwedHarnessIn(
  ix: Internals,
  ticketId: string,
): Result<HarnessOpened> {
  const ticket = first(
    ix,
    qb.selectFrom("tickets").selectAll().where("id", "=", ticketId),
  );
  if (ticket === undefined) {
    return err(failure("not_found", `ticket ${ticketId}`));
  }
  const law = lawTicket(ticket);
  if (!law.ok) return ok({ opened: [], why: law.error.message });
  const laws = lawFactsIn(ix, ticket);
  if (laws.gates.state === "unavailable") {
    return ok({ opened: [], why: `gate facts: ${laws.gates.detail}` });
  }
  const owed = harnessOwed({
    ticket: law.value,
    gates: laws.gates.value,
    merge: laws.merge,
    qaCi: factsOf(ix, ticket).qaCi(),
  });
  if (!owed.owed) return ok({ opened: [], why: owed.why });
  const opened = openRoundIn(ix, ticket, HARNESS_OPENS, BY);
  if (!opened.ok) return opened;
  if (opened.value.length === 0) {
    return ok({ opened: [], why: "the round planned no qa_harness gate" });
  }
  const audit = insertAudit(ix, {
    actor: SUPERVISOR_ACTOR,
    action: OPEN_HARNESS_ACTION,
    target_kind: "ticket",
    target_id: ticket.id,
    payload: { gate_ids: opened.value.map((g) => g.id) },
  });
  if (!audit.ok) return audit;
  return ok({ opened: opened.value });
}

/**
 * The QA gate the ticket is owed, in its own BEGIN IMMEDIATE: what the reconciler's machine sweep
 * calls for a ticket resting at `qa_harness`. A second call finds the gate and writes nothing.
 */
export async function openOwedHarness(
  db: Db,
  ticketId: string,
): R<HarnessOpened> {
  if (ticketId.trim() === "") {
    return err(failure("validation", "openOwedHarness: ticketId is empty"));
  }
  return write(db, (ix) => openOwedHarnessIn(ix, ticketId));
}
