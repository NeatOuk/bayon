// §15 #7 interrupt: mid-tool, a terminal{interrupted} within 5 s, and run n+1 on the same handle
// ends ok with nothing of run n attributed to it (the an earlier change finding). The terminal is the
// runner's own, or (§5.2 amendment) the adapter's `basis: "interrupt+exit"` one; either comes
// through the records, so both are runner-sourced here.
import type { Result } from "@bayon/core";
import { settlesWithin } from "../../wait.js";
import { StepFailed } from "../harness.js";
import type { StoredEvent } from "../types.js";
import {
  callIds,
  check,
  define,
  endedWith,
  isInterruptExit,
  outcomeOf,
} from "./define.js";

export interface InterruptEvidence {
  readonly toolCallSeen: boolean;
  readonly interrupt: Result<void> | undefined;
  readonly endedInTime: boolean;
  readonly elapsedMs: number;
  readonly interruptMs: number;
  readonly run1: readonly StoredEvent[];
  readonly run2:
    | { readonly sent: Result<void>; readonly events: readonly StoredEvent[] }
    | undefined;
}

export function judgeInterrupt(e: InterruptEvidence) {
  const seen = check(
    "tool_call_seen",
    e.toolCallSeen,
    e.toolCallSeen ? null : "no tool_call before the interrupt",
    { precondition: true },
  );
  if (!e.toolCallSeen) return [seen];
  const opened = new Set(callIds(e.run1, "tool_call"));
  const leaked = (e.run2?.events ?? []).filter(
    (ev) =>
      (ev.kind === "tool_call" || ev.kind === "tool_result") &&
      opened.has(String(ev.payload.call_id)),
  );
  return [
    seen,
    check(
      "interrupt_accepted",
      e.interrupt?.ok === true,
      e.interrupt === undefined || e.interrupt.ok
        ? null
        : e.interrupt.error.message,
    ),
    check(
      "interrupted_within_5s",
      e.endedInTime &&
        endedWith(e.run1, "interrupted") &&
        e.elapsedMs <= e.interruptMs,
      `${e.elapsedMs} ms, ${outcomeOf(e.run1)}${e.run1.some(isInterruptExit) ? " (interrupt+exit)" : ""}`,
    ),
    check(
      "run_after_interrupt_ok",
      e.run2 !== undefined && e.run2.sent.ok && endedWith(e.run2.events, "ok"),
      e.run2 === undefined
        ? "no run n+1"
        : e.run2.sent.ok
          ? outcomeOf(e.run2.events)
          : `send refused: ${e.run2.sent.error.message}`,
    ),
    check(
      "no_cross_run_attribution",
      leaked.length === 0,
      `${leaked.length} events of run n bound to run n+1`,
    ),
  ];
}

export const t07 = define({
  id: 7,
  retries: 1,
  drive: async (ctx): Promise<InterruptEvidence> => {
    const { ingest } = ctx.ports;
    const live = await ctx.open({ scenario: "interrupt" });
    await live.spawn();
    const first = await live.start(live.turn(0));
    if (!first.sent.ok) throw new StepFailed("send", first.sent.error.message);
    const call = await live.waitFor(
      (e) => e.run_id === first.runId && e.kind === "tool_call",
      ctx.budgets.turnMs,
    );
    const evidence = {
      interruptMs: ctx.budgets.interruptMs,
      run1: [],
      run2: undefined,
      interrupt: undefined,
      endedInTime: false,
      elapsedMs: 0,
    };
    if (call === undefined) return { ...evidence, toolCallSeen: false };
    const t0 = ctx.clock.now();
    const interrupt = await ctx.call(
      "interrupt",
      ctx.subject.adapter.interrupt(live.handle),
    );
    const endedInTime = await settlesWithin(
      ingest.terminalOf(first.runId),
      ctx.clock,
      ctx.budgets.interruptMs,
    );
    const elapsedMs = ctx.clock.now() - t0;
    if (!endedInTime) {
      await ingest.closeRun(live.sessionId, first.runId, {
        outcome: "interrupted",
        errorClass: "interrupted",
        message: "no terminal within the interrupt budget",
      });
    }
    await first.done;
    const run1 = await live.events(first.runId);
    const second = await live.start(live.turn(1));
    return {
      ...evidence,
      toolCallSeen: true,
      interrupt,
      endedInTime,
      elapsedMs,
      run1,
      run2: {
        sent: second.sent,
        events: second.sent.ok ? (await live.finish(second)).events : [],
      },
    };
  },
  judge: judgeInterrupt,
});
