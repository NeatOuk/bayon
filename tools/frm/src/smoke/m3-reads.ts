import { join } from "node:path";
import { err, newId, ok, type Result } from "@bayon/core";
import {
  getSession,
  getTicket,
  listRuns,
  listTicketEvents,
  listTicketHandoffs,
  type HandoffRow,
  type TicketRow,
} from "@bayon/db";
import type {
  GateView,
  TicketDetail,
  TicketView,
  TransitionRequest,
} from "@bayon/proto";
import {
  COMMAND_TIMEOUT_MS,
  EVENTS_TIMEOUT_MS,
  M3_GATE_TIMEOUT_MS,
} from "./budget.js";
import { SMOKE } from "./config.js";
import { git } from "./fixture-repo.js";
import { terminalOf } from "./follow.js";
import { refuse, verdict } from "./harness.js";
import { mcpCallProblems, type ExpectedCall } from "./m1-assertions.js";
import { waitFor } from "./m2-reads.js";
import { builderSpawn } from "./m3-config.js";
import { commandDone, sessionIn, type World } from "./phases.js";

// What the M3 smoke does and reads at its checkpoints: builder steps, conformance, and the gates
// as GET /tickets/:ref shows them to the operator.

/** The ticket as the operator sees it; each reviewer session it names is tracked for teardown. */
export async function detailOf(
  w: World,
  ticketId: string,
): Promise<Result<TicketDetail>> {
  const d = await w.api.ticket(ticketId);
  if (d.ok)
    for (const g of d.value.gates)
      if (g.session_id !== null) w.h.track(g.session_id);
  return d;
}

/** Polls the ticket until `done` holds for its gates; the detail it saw then. */
export const gatesUntil = (
  w: World,
  ticketId: string,
  what: string,
  done: (gates: readonly GateView[]) => boolean,
): Promise<Result<TicketDetail>> =>
  waitFor(w, what, M3_GATE_TIMEOUT_MS, async () => {
    const d = await detailOf(w, ticketId);
    if (!d.ok) return d;
    return ok(done(d.value.gates) ? d.value : undefined);
  });

/** Every one of `kinds` has its attempt `attempt`, decided. */
export const decided =
  (kinds: readonly string[], attempt: number) =>
  (gates: readonly GateView[]): boolean =>
    kinds.every((kind) =>
      gates.some(
        (g) =>
          g.kind === kind && g.attempt === attempt && g.state !== "running",
      ),
    );

/** An operator transition at the ticket's current version. */
export async function operatorMove(
  w: World,
  ticketId: string,
  body: TransitionRequest,
): Promise<Result<TicketView>> {
  const d = await w.api.ticket(ticketId);
  if (!d.ok) return d;
  return w.api.transitionTicket(ticketId, d.value.ticket.version, body);
}

/** An operator transition that must land the ticket in `body.to`. */
export const operatorStep = (
  w: World,
  name: string,
  ticketId: string,
  body: TransitionRequest,
): Promise<TicketView> =>
  w.h.step(name, async () => {
    const moved = await operatorMove(w, ticketId, body);
    if (!moved.ok) return moved;
    return moved.value.status === body.to
      ? ok(moved.value)
      : err(refuse(`the ticket is ${moved.value.status}, not ${body.to}`));
  });

/**
 * The ticket already rests in `to`, moved there by a step before this one. A trivial ticket's
 * submit_plan carries it past plan_review to planned in the same move, so there is no
 * approve_plan left for anyone to take.
 */
export const landedStep = (
  w: World,
  name: string,
  ticketId: string,
  to: string,
): Promise<TicketRow> =>
  w.h.step(name, async () => {
    const ticket = await getTicket(w.db, ticketId);
    if (!ticket.ok) return ticket;
    return ticket.value.status === to
      ? ok(ticket.value)
      : err(refuse(`the ticket is ${ticket.value.status}, not ${to}`));
  });

/**
 * A machine step the supervisor took with the gate decision that settled it: the ticket
 * is in `to`, and the latest move into it is the supervisor's, not the operator's. The decision and
 * the move commit in one transaction, so once the round reads decided there is nothing to wait for.
 */
export const supervisorStep = (
  w: World,
  name: string,
  ticketId: string,
  to: string,
): Promise<TicketRow> =>
  w.h.step(name, async () => {
    const ticket = await getTicket(w.db, ticketId);
    if (!ticket.ok) return ticket;
    const events = await listTicketEvents(w.db, {
      ticket_id: ticketId,
      since: 0,
      limit: 1_000,
    });
    if (!events.ok) return events;
    const into = events.value.rows
      .filter((e) => e.kind === "transition" && e.to_status === to)
      .at(-1);
    const problems = [
      ...(ticket.value.status === to
        ? []
        : [`the ticket is ${ticket.value.status}, not ${to}`]),
      ...(into === undefined
        ? [`no move into ${to}`]
        : into.actor_kind === "supervisor"
          ? []
          : [
              `the move into ${to} was ${into.actor_kind}'s, not the supervisor's`,
            ]),
    ];
    return problems.length === 0
      ? ok(ticket.value)
      : err(refuse(problems.join("; ")));
  });

export interface BuilderRun {
  readonly sessionId: string;
  readonly runId: string;
  /** Its worktree's HEAD once its run ended: what a gate its run opened reviews. */
  readonly head: string;
}

/**
 * The session's HEAD commit and its run 1, once its working run has ended ok and the session has
 * come to rest in `settled` with `calls` behind it. A new session is `idle` before its run 1 starts
 * too (spawn, then startRun), so the wait is for the run's terminal event first.
 *
 * `settled` is `handed_off` for a session whose status move ended its phase: the API ships a
 * `session.handoff` with that move and the supervisor writes the packet once the working turn is
 * over, so the MCP calls are only complete once the session has ended.
 */
async function ranOk(
  w: World,
  id: string,
  calls: readonly ExpectedCall[],
  settled: string,
  /** Where this workspace puts the primary repo's worktree under the session root. */
  relPath: string,
): Promise<Result<BuilderRun>> {
  const ended = await waitFor(
    w,
    `session ${id}'s run 1 to its terminal`,
    EVENTS_TIMEOUT_MS,
    async () => {
      const stored = await w.api.events(id);
      if (!stored.ok) return stored;
      return ok(
        terminalOf(stored.value) === undefined ? undefined : stored.value,
      );
    },
  );
  if (!ended.ok) return ended;
  const rest = await sessionIn(w, id, settled);
  if (!rest.ok) return rest;
  // Re-read after the session has come to rest: a hand-off run's calls land after run 1's terminal.
  const events = await w.api.events(id);
  if (!events.ok) return events;
  const t = terminalOf(ended.value);
  const why = t?.payload.error?.message;
  const checked = verdict([
    ...(t?.payload.outcome === "ok"
      ? []
      : [
          `its run ended ${t?.payload.outcome ?? "with no terminal"}${why === undefined ? "" : `: ${why}`}`,
        ]),
    ...mcpCallProblems(events.value, calls),
  ]);
  if (!checked.ok) return checked;
  const runs = await listRuns(w.db, id);
  if (!runs.ok) return runs;
  const run = runs.value[0];
  if (run === undefined) return err(refuse(`session ${id} has no run`));
  try {
    const head = git(join(rest.value.session_root, relPath), [
      "rev-parse",
      "HEAD",
    ]);
    return ok({ sessionId: id, runId: run.id, head });
  } catch (cause) {
    return err(
      refuse(
        `HEAD of ${id}'s worktree: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    );
  }
}

/**
 * One builder step: its session on the ticket, its runs ended ok with `calls`, then at rest.
 *
 * A session whose status move ended a phase releases itself: it ends `handed_off` with
 * a full packet, which frees its executor slot, and the operator stops nothing. A session that
 * moved no status — B4, whose pass_harness is refused — still holds its ticket at the end of its
 * turn, so the operator stops it, and that exit leaves a degraded packet (§7.4).
 */
export async function builderStep(
  w: World,
  label: string,
  agent: string,
  ticketId: string,
  calls: readonly ExpectedCall[],
  o: {
    readonly handsOff?: boolean;
    /** Step 10's multi-repo workspace and the rel_path its primary takes. */
    readonly workspaceId?: string;
    readonly relPath?: string;
  } = {},
): Promise<BuilderRun> {
  const handsOff = o.handsOff ?? true;
  const relPath = o.relPath ?? SMOKE.relPath;
  const key = `smoke:m3:${agent}:${newId(w.h.clock.now())}`;
  const id = await w.h.step(`${label}: POST /sessions, spawned`, async () => {
    const accepted = await w.api.spawn(
      builderSpawn(agent, ticketId, o.workspaceId),
      key,
    );
    if (!accepted.ok) return accepted;
    w.h.track(accepted.value.session_id);
    const done = await commandDone(w, accepted.value.command_id);
    return done.ok ? ok(accepted.value.session_id) : done;
  });
  const run = await w.h.step(
    `${label} ${id}: its run ended ok, its MCP calls as scripted`,
    () => ranOk(w, id, calls, handsOff ? "handed_off" : "idle", relPath),
  );
  await (handsOff
    ? w.h.step(
        `${label}: released itself at the phase boundary, full packet (§7.1)`,
        () => phaseHandoffProblems(w, id, ticketId),
      )
    : w.h.step(`${label}: stopped`, async () => {
        const stop = await w.api.stop(id, "graceful", `smoke:m3:stop:${id}`);
        if (!stop.ok) return stop;
        const done = await commandDone(w, stop.value.command_id);
        return done.ok ? ok(undefined) : done;
      }));
  return run;
}

/** The session's own hand-off rows, once the first one is finalized (no longer `writing`). */
const finalizedFrom = (
  w: World,
  id: string,
  ticketId: string,
): Promise<Result<readonly HandoffRow[]>> =>
  waitFor(
    w,
    `${id}'s hand-off packet finalized`,
    COMMAND_TIMEOUT_MS,
    async () => {
      const rows = await listTicketHandoffs(w.db, ticketId);
      if (!rows.ok) return rows;
      const mine = rows.value.filter((h) => h.from_session_id === id);
      return ok(mine[0]?.quality === "writing" ? undefined : mine);
    },
  );

/**
 * The packet a phase boundary left: one `phase_change` row from this session, `full` (its hand-off
 * run wrote a judgement), and the session ended `ok` rather than `abandoned` — which is the whole
 * difference from what these sessions used to leave behind.
 *
 * The seal and the finalize are two steps: `sealHandoff` moves the session to `handed_off` and
 * `finalizeRow` turns its `writing` row into `full` tens of milliseconds later (supervisor
 * handoff.ts), so `handed_off` is not yet the signal that the packet is readable — hence the wait,
 * the same one `handoffFrom` makes for the M2 chain. A row that stays `writing` times out here and
 * a row finalized `degraded` still fails below: neither is accepted.
 */
async function phaseHandoffProblems(
  w: World,
  id: string,
  ticketId: string,
): Promise<Result<void>> {
  const finalized = await finalizedFrom(w, id, ticketId);
  if (!finalized.ok) return finalized;
  const mine = finalized.value;
  const s = await getSession(w.db, id);
  if (!s.ok) return s;
  const row = mine[0];
  return verdict([
    ...(mine.length === 1
      ? []
      : [`${mine.length} hand-offs from ${id}, expected 1`]),
    ...(row === undefined || row.reason === "phase_change"
      ? []
      : [`its hand-off reason is ${row.reason}, not phase_change`]),
    ...(row === undefined || row.quality === "full"
      ? []
      : [`its packet is ${row.quality}, not full`]),
    ...(s.value.exit_reason === "ok"
      ? []
      : [`it exited ${s.value.exit_reason ?? "(none)"}, not ok`]),
  ]);
}
