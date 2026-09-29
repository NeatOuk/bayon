// The machine-step sweep, a step of every reconciler pass. A gate's decision takes the
// machine step it settles in its own transaction (decideGate → advanceTicket); this is for the
// steps no decision is coming to take:
//   * the operator waived the round's last failed gate — a waive is the API's write, not a decision;
//   * a ticket blocked while its gates decided, then unblocked back into review;
//   * anything a restart fell between.
// Each resting ticket (a status a gate decides, no gate of its running) gets `advanceTicket`, which
// decides again from the stored facts and writes nothing when no edge applies, so the sweep is
// idempotent: a second pass over the same rows finds the tickets moved on, or still waiting.
//
// A ticket at `qa_harness` that no step moved is then asked whether it is owed a QA gate
//: it crossed `pass_review` while its project ran no QA, so no round opened one, and
// `harnessStep` would wait on it for ever. `openOwedHarness` opens the round `pass_review` would have
// opened, `running` and with no command; the gate engine's poll starts it. The gate running takes
// the ticket off the next pass's list, and once decided it is the round's, so it never reopens.
//
// It runs through a fleet or project pause on purpose. A machine step is bookkeeping: it spawns
// nothing and inserts no command, so a pause has nothing of it to hold back, and freezing it would
// recreate the stall it exists to end — a ticket parked in review for the whole pause with its round
// long decided. Staffing the next phase is what a pause stops, and it does. A QA gate it opens is
// held by the gate engine through a fleet hold, exactly as the one `pass_review` opens.
import { listMachineCandidates, type MachineCursor } from "@bayon/db";
import { advanceTicket, openOwedHarness } from "@bayon/db/supervisor";
import type { Ctx } from "./context.js";

/** The most tickets one pass looks at; the next pass carries on after the last of them. */
export const MACHINE_SWEEP_MAX = 100;

/** What the sweep uses of the lifecycle: the database and the log. */
export type SweepCtx = Pick<Ctx, "db" | "log">;

/**
 * Where each lifecycle's sweep left off, so more resting tickets than one pass's cap are all seen
 * in turn rather than the same oldest ones every pass. In memory: a restart starts from the top,
 * which is exactly the gap the sweep exists to cover.
 */
const cursors = new WeakMap<SweepCtx, MachineCursor>();

export interface MachineSwept {
  readonly looked: number;
  readonly advanced: number;
  /** Tickets at qa_harness this pass opened an owed QA gate for. */
  readonly opened: number;
}

export async function sweepMachineSteps(ctx: SweepCtx): Promise<MachineSwept> {
  const after = cursors.get(ctx) ?? null;
  const page = await listMachineCandidates(ctx.db, {
    limit: MACHINE_SWEEP_MAX,
    after,
  });
  if (!page.ok) {
    ctx.log.error(
      { error: page.error },
      "machine-step sweep: cannot list resting tickets",
    );
    return { looked: 0, advanced: 0, opened: 0 };
  }
  const last = page.value.at(-1);
  // A short page reached the end: the next pass starts from the top again.
  if (last === undefined || page.value.length < MACHINE_SWEEP_MAX) {
    cursors.delete(ctx);
  } else {
    cursors.set(ctx, { updated_at: last.updated_at, id: last.id });
  }
  let advanced = 0;
  let opened = 0;
  for (const t of page.value) {
    const out = await advanceTicket(ctx.db, t.id);
    if (!out.ok) {
      ctx.log.error(
        { ticketId: t.id, error: out.error },
        "machine-step sweep: advanceTicket failed",
      );
      continue;
    }
    if (!out.value.advanced) {
      if (out.value.status === QA_STATUS) opened += await openOwed(ctx, t.id);
      continue;
    }
    advanced += 1;
    ctx.log.info(
      { ticketId: t.id, rule: out.value.rule, to: out.value.to },
      "machine-step sweep: a resting ticket moved on",
    );
  }
  if (opened > 0) {
    ctx.log.info(
      { looked: page.value.length, advanced, opened },
      "machine-step sweep: opened owed QA gates this pass",
    );
  }
  return { looked: page.value.length, advanced, opened };
}

const QA_STATUS = "qa_harness";

/** The QA gate a resting `qa_harness` ticket is owed, if any: 1 when one opened, else 0. */
async function openOwed(ctx: SweepCtx, ticketId: string): Promise<number> {
  const out = await openOwedHarness(ctx.db, ticketId);
  if (!out.ok) {
    ctx.log.error(
      { ticketId, error: out.error },
      "machine-step sweep: openOwedHarness failed",
    );
    return 0;
  }
  if (out.value.opened.length === 0) return 0;
  ctx.log.info(
    { ticketId, gateIds: out.value.opened.map((g) => g.id) },
    "machine-step sweep: opened the QA gate a ticket at qa_harness was owed",
  );
  return 1;
}
