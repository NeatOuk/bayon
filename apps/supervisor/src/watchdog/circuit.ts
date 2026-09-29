// The circuit breaker: a ticket's own failures since its last good work run or
// unblock, storm failures excluded (every burst of each pair, lapsed ones too), trip at
// watchdog.circuit_failed_runs: blockTicket through core's laws, with one human_request per
// incident, both in one transaction. Stateless from the database, so a restart loses nothing.
import {
  HELD_STATUSES,
  STORM_ERROR_CLASS,
  circuitVerdict,
  err,
  isTerminal,
  ok,
  pairKey,
  retryStormHolds,
  type Result,
  type RetryStormSettings,
  type StormHold,
  type TicketStatus,
} from "@bayon/core";
import {
  getTicket,
  listCircuitFacts,
  listPairFailuresSince,
  parseStatus,
  type CircuitTicket,
  type TicketFailureRow,
} from "@bayon/db";
import { blockTicket } from "@bayon/db/supervisor";
import type { WatchdogDeps } from "./ports.js";
import {
  CIRCUIT_OPTIONS,
  CIRCUIT_UNBLOCK,
  circuitContext,
  circuitQuestion,
  circuitReason,
} from "./texts.js";

export type CircuitVerdict =
  | {
      readonly state: "closed";
      readonly failures: number;
      readonly threshold: number;
    }
  | {
      readonly state: "tripped";
      readonly failures: number;
      readonly requestId: string;
      /** False when it had tripped already (the request's key named a row). */
      readonly newly: boolean;
    }
  | { readonly state: "held"; readonly status: TicketStatus };

/** What an earlier change calls after a holder's failed spawn, before it re-staffs (§5.7). */
export interface CircuitBreaker {
  /** Evaluates the ticket now, on the watchdog queue; trips when due. Safe from a session op. */
  check(ticketId: string): Promise<Result<CircuitVerdict>>;
}

export interface CircuitSettings {
  readonly threshold: number;
  readonly storm: RetryStormSettings;
}

/** Each pair's holds over its runner_error failures since `resetAt − windowMs` (§5.3). */
async function holdsFor(
  d: WatchdogDeps,
  failures: readonly TicketFailureRow[],
  resetAt: number,
  storm: RetryStormSettings,
): Promise<Map<string, readonly StormHold[]>> {
  const holds = new Map<string, readonly StormHold[]>();
  for (const f of failures) {
    const key = pairKey(f.runnerId, f.executorId);
    if (f.errorClass !== STORM_ERROR_CLASS || holds.has(key)) continue;
    const pair = await listPairFailuresSince(d.db, {
      runnerId: f.runnerId,
      executorId: f.executorId,
      since: resetAt - storm.windowMs,
    });
    holds.set(key, pair.ok ? retryStormHolds(pair.value, storm) : []);
  }
  return holds;
}

/** One ticket's verdict, and its trip when due. */
async function judge(
  d: WatchdogDeps,
  ticket: CircuitTicket,
  failures: readonly TicketFailureRow[],
  s: CircuitSettings,
): Promise<Result<CircuitVerdict>> {
  const closed: CircuitVerdict = {
    state: "closed",
    failures: failures.filter((f) => f.at > ticket.resetAt).length,
    threshold: s.threshold,
  };
  // The raw count is a superset: below the threshold, no storm read is needed.
  if (closed.failures < s.threshold) return ok(closed);
  const verdict = circuitVerdict({
    failures,
    resetAt: ticket.resetAt,
    threshold: s.threshold,
    holdsByPair: await holdsFor(d, failures, ticket.resetAt, s.storm),
  });
  if (!verdict.tripped) {
    return ok({ ...closed, failures: verdict.counted.length });
  }
  const count = verdict.counted.length;
  const blocked = await blockTicket(d.db, {
    ticketId: ticket.id,
    blockedReason: circuitReason(count, ticket.resetAt),
    unblockCondition: CIRCUIT_UNBLOCK,
    request: {
      rule: "circuit",
      subject: ticket.id,
      window: String(ticket.resetAt),
      question: circuitQuestion(ticket.num, count),
      context_md: circuitContext(verdict.counted, ticket.resetAt),
      options: [...CIRCUIT_OPTIONS],
    },
  });
  if (!blocked.ok) return blocked;
  const outcome = blocked.value;
  if (!outcome.blocked) {
    const status = parseStatus(outcome.status);
    return status === null
      ? err({
          class: "internal",
          message: `ticket ${ticket.id} has an unknown status: ${outcome.status}`,
          retryable: false,
        })
      : ok({ state: "held", status });
  }
  d.log.warn(
    { ticketId: ticket.id, failures: count, request: outcome.request.id },
    "circuit breaker: blocked the ticket and filed a human request",
  );
  return ok({
    state: "tripped",
    failures: count,
    requestId: outcome.request.id,
    newly: outcome.requestCreated,
  });
}

/** Every open, unheld ticket (the sweep), or one (an event, or check). */
export async function evaluateCircuit(
  d: WatchdogDeps,
  s: CircuitSettings,
  ticketId?: string,
): Promise<Result<ReadonlyMap<string, CircuitVerdict>>> {
  const facts = await listCircuitFacts(d.db, ticketId);
  if (!facts.ok) return facts;
  const verdicts = new Map<string, CircuitVerdict>();
  for (const ticket of facts.value.tickets) {
    const mine = facts.value.failures.filter((f) => f.ticketId === ticket.id);
    const verdict = await judge(d, ticket, mine, s);
    if (!verdict.ok) {
      d.log.error({ ticketId: ticket.id, error: verdict.error }, "circuit");
      continue;
    }
    verdicts.set(ticket.id, verdict.value);
  }
  return ok(verdicts);
}

/** check(): a held or closed ticket answers `held`; any other is judged now. */
export async function checkCircuit(
  d: WatchdogDeps,
  s: CircuitSettings,
  ticketId: string,
): Promise<Result<CircuitVerdict>> {
  const ticket = await getTicket(d.db, ticketId);
  if (!ticket.ok) return ticket;
  const status = parseStatus(ticket.value.status);
  if (status === null) {
    return err({
      class: "internal",
      message: `ticket ${ticketId} has an unknown status: ${ticket.value.status}`,
      retryable: false,
    });
  }
  if (isTerminal(status) || HELD_STATUSES.includes(status)) {
    return ok({ state: "held", status });
  }
  const verdicts = await evaluateCircuit(d, s, ticketId);
  if (!verdicts.ok) return verdicts;
  return ok(
    verdicts.value.get(ticketId) ?? {
      state: "closed",
      failures: 0,
      threshold: s.threshold,
    },
  );
}
