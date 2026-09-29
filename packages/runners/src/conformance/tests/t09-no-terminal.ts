// §15 #9 no-terminal-event (non-negotiable): (a) a stalled runner is caught by the watchdog at the
// wall clock, while alive, and no terminal appears the runner could not have sent; (b) a kill -9
// mid-run leaves no runner terminal and the supervisor closes the run. An adapter that infers a
// terminal from the exit fails `no_runner_terminal` (the exit-code inference bug, §5.2). The one exception
// (§5.2 amendment): in (a) the watchdog interrupted before the kill, so an adapter's
// `terminal{interrupted, basis: "interrupt+exit"}` is allowed there; never in (b), where nothing
// asked for an interrupt.
import { StepFailed } from "../harness.js";
import type { StoredEvent, WatchResult } from "../types.js";
import { check, define, isInterruptExit, runnerTerminals } from "./define.js";

export interface NoTerminalEvidence {
  readonly sentAt: number;
  readonly hangMs: number;
  readonly watch: WatchResult;
  readonly firstEventSeen: boolean;
  readonly aliveAtFire: boolean | undefined;
  readonly deadAfter: boolean;
  readonly stalled: readonly StoredEvent[];
  readonly midRun: boolean;
  readonly killed: readonly StoredEvent[];
}

export function judgeNoTerminal(e: NoTerminalEvidence) {
  const stalled = runnerTerminals(e.stalled).filter(
    (t) => !isInterruptExit(t),
  ).length;
  const killed = runnerTerminals(e.killed).length;
  const close = e.killed.find((ev) => ev.kind === "terminal");
  return [
    check("first_event_seen", e.firstEventSeen),
    check(
      "watchdog_verdict",
      e.watch.by === "watchdog" && e.watch.outcome === "timeout",
      `${e.watch.by}:${e.watch.outcome}`,
    ),
    check(
      "fired_on_time",
      e.watch.firedAt !== undefined && e.watch.firedAt - e.sentAt >= e.hangMs,
      e.watch.firedAt === undefined
        ? "never fired"
        : `${e.watch.firedAt - e.sentAt} ms after send`,
    ),
    check("alive_when_fired", e.aliveAtFire === true),
    check("dead_after_teardown", e.deadAfter),
    check("mid_run_kill", e.midRun),
    check(
      "no_runner_terminal",
      stalled === 0 && killed === 0,
      `${stalled} after the stall, ${killed} after kill -9`,
    ),
    check(
      "closed_without_terminal",
      close?.kind === "terminal" &&
        close.source === "supervisor" &&
        close.payload.error?.class === "runner_exited_without_terminal",
      close?.kind === "terminal"
        ? `${close.source}:${close.payload.outcome}`
        : "no terminal",
    ),
  ];
}

export const t09 = define({
  id: 9,
  retries: 0,
  drive: async (ctx): Promise<NoTerminalEvidence> => {
    const { executor } = ctx.subject;
    // (a) the stall: only the run's first record gets through.
    const a = await ctx.open({ scenario: "interrupt" });
    await a.spawn();
    executor.stall(a.dirs.cwd);
    let aliveAtFire: boolean | undefined;
    const sentAt = ctx.clock.now();
    const stalledRun = await a.start(a.turn(0), {
      wallClockMs: ctx.budgets.hangMs,
      onFire: async () => {
        aliveAtFire =
          (await ctx.call("probe", executor.probe(a.latestRef()))) === "alive";
      },
    });
    if (!stalledRun.sent.ok)
      throw new StepFailed("send", stalledRun.sent.error.message);
    const watch = await stalledRun.done;
    const stalled = await a.events(stalledRun.runId);
    const deadAfter =
      (await ctx.call("probe", executor.probe(a.latestRef()))) === "dead";
    // (b) kill -9 once the run is visibly under way.
    const b = await ctx.open({ scenario: "interrupt" });
    await b.spawn();
    const killedRun = await b.start(b.turn(0));
    if (!killedRun.sent.ok)
      throw new StepFailed("send", killedRun.sent.error.message);
    const call = await b.waitFor(
      (e) => e.run_id === killedRun.runId && e.kind === "tool_call",
      ctx.budgets.turnMs,
    );
    if (call !== undefined) executor.kill9(b.dirs.cwd);
    await killedRun.done;
    await ctx.call("ingest ended", ctx.ports.ingest.ended(b.sessionId));
    return {
      sentAt,
      hangMs: ctx.budgets.hangMs,
      watch,
      firstEventSeen: stalled.some((e) => e.source === "runner"),
      aliveAtFire,
      deadAfter,
      stalled,
      midRun: call !== undefined,
      killed: await b.events(killedRun.runId),
    };
  },
  judge: judgeNoTerminal,
});
