// Every step-shaped wait the smoke performs, once, so the whole-run deadline (cli.ts) can never
// again drift below what the steps it wraps could legitimately need. Before this file
// existed, the outer deadline (180 s / 90 s with --hang) was a number picked independently of the
// step deadlines below, whose worst-case sum is far larger: under load the outer "frm smoke"
// deadline fired first, reporting only "the overall deadline passed" instead of which step stalled.

/** One boot wait: supervisor heartbeat, runner registration, or an API health check. */
export const BOOT_TIMEOUT_MS = 30_000;
/** A `commands` row reaching a terminal state. */
export const COMMAND_TIMEOUT_MS = 30_000;
/** A run's terminal event arriving over the WS. */
export const EVENTS_TIMEOUT_MS = 60_000;
/** The supervisor's heartbeat advancing with no API up. */
export const HEARTBEAT_TIMEOUT_MS = 30_000;
/** A child process exiting after being signalled. */
export const EXIT_TIMEOUT_MS = 10_000;
/** The `hang` run class's own wall-clock kill, waited on top of its terminal event. */
export const HANG_WALL_CLOCK_MS = 3_000;
/** The M2 smoke orchestrator's pulse interval (m2-config.ts): its cron wakes come this far apart. */
export const M2_PULSE_INTERVAL_MS = 20_000;
/**
 * One M2 step: at most one pulse interval before the next pulse, then that pulse's run and the
 * session it staffs doing its part (spawn, MCP calls, a hand-off run, or a death and adoption).
 */
export const M2_STEP_TIMEOUT_MS = M2_PULSE_INTERVAL_MS + EVENTS_TIMEOUT_MS;
/**
 * One `runner.conformance` command, run by the supervisor on its live budgets (§15; its test 9
 * alone waits out a 20 s hang): generous, as a slow host runs the suite's processes slowly.
 */
export const M3_CONFORMANCE_TIMEOUT_MS = 180_000;
/**
 * A round of gates decided: the pin, the reviewer spawned, its run and the decision; or two
 * short-clocked attempts of a hanging review (step 8).
 */
export const M3_GATE_TIMEOUT_MS = 60_000;
/** One remote command of the container run over its own ssh: a listing, a copy, a scan. */
export const CTR_SSH_TIMEOUT_MS = 120_000;
/** `frm executor image` on a cold host: apt and the runners' installs (about 130 s seen). */
export const CTR_IMAGE_TIMEOUT_MS = 20 * 60_000;
/** The container executor healthy: its /mcp tunnel up and /mcp answering through the gateway. */
export const CTR_HEALTH_TIMEOUT_MS = 120_000;
/**
 * One `runner.conformance` on the container executor: every session placed, cloned,
 * claimed and released over ssh. At most 2× the longest seen on ctr-lab: 115.1 s and 118.7 s in two
 * green container runs, 117 s in the gated live test. The local M3_CONFORMANCE_TIMEOUT_MS is
 * unchanged.
 */
export const CTR_CONFORMANCE_TIMEOUT_MS = 235_000;
/**
 * One pull-the-plug cycle's recovery: the supervisor restarted, its reconciler adopting
 * the resumable sessions, killing the straggler that escaped the plug, requeueing every claimed
 * command and re-admitting the queued one. A whole boot's work on a host that has just had every
 * process group killed under it, so it is a boot wait plus the reconciler's own pass.
 */
export const M4_PLUG_TIMEOUT_MS = 90_000;
/** `frm backup` and `frm restore` over the smoke's own DB: one write, one read, one integrity check. */
export const M4_BACKUP_TIMEOUT_MS = 60_000;

/**
 * Every step-shaped wait along one path through the smoke, in the order phases.ts awaits them.
 * Keeping this list explicit (rather than inferring it) means adding or removing a step is a
 * visible diff here too — the same bookkeeping the smoke already needs, just no longer silently
 * allowed to drift from the outer deadline.
 */
const STEPS_MS: Readonly<
  Record<
    "normal" | "hang" | "m1" | "m2" | "m3" | "m3Container" | "m4",
    readonly number[]
  >
> = {
  // setUp: supervisor up, runners registered, API up (3 boot waits). Then every mode but m3
  // certifies the fixture runner (one conformance command, certify.ts; an earlier change: 012's
  // admission.require_certified=1); m3 counts its two in its own list.
  // buildSession: spawn command done, terminal event.
  // apiRestart: spawn command done, pre-gate events, session running, API exit, heartbeat
  // advances, API restarted (boot). resumeAndCompare: stop command done, terminal event,
  // resubscribed catch-up event wait.
  normal: [
    BOOT_TIMEOUT_MS,
    BOOT_TIMEOUT_MS,
    BOOT_TIMEOUT_MS,
    M3_CONFORMANCE_TIMEOUT_MS,
    COMMAND_TIMEOUT_MS,
    EVENTS_TIMEOUT_MS,
    COMMAND_TIMEOUT_MS,
    EVENTS_TIMEOUT_MS,
    COMMAND_TIMEOUT_MS,
    EXIT_TIMEOUT_MS,
    HEARTBEAT_TIMEOUT_MS,
    BOOT_TIMEOUT_MS,
    COMMAND_TIMEOUT_MS,
    EVENTS_TIMEOUT_MS,
    EVENTS_TIMEOUT_MS,
  ],
  // setUp: the same 3 boot waits. buildSession: spawn command done, then the terminal-event wait
  // plus the run class's own wall-clock kill (apiRestart never runs with --hang).
  hang: [
    BOOT_TIMEOUT_MS,
    BOOT_TIMEOUT_MS,
    BOOT_TIMEOUT_MS,
    M3_CONFORMANCE_TIMEOUT_MS,
    COMMAND_TIMEOUT_MS,
    EVENTS_TIMEOUT_MS + HANG_WALL_CLOCK_MS,
  ],
  // setUp: the same 3 boot waits. m1Session: spawn command done, the human_ask call arriving,
  // the session running, the stop command done, its terminal. The exports: export command
  // done, the exporter's terminal, the ticket_exports rows, the exporter's stop command done,
  // the second export command done, its terminal.
  m1: [
    BOOT_TIMEOUT_MS,
    BOOT_TIMEOUT_MS,
    BOOT_TIMEOUT_MS,
    M3_CONFORMANCE_TIMEOUT_MS,
    COMMAND_TIMEOUT_MS,
    EVENTS_TIMEOUT_MS,
    COMMAND_TIMEOUT_MS,
    COMMAND_TIMEOUT_MS,
    EVENTS_TIMEOUT_MS,
    COMMAND_TIMEOUT_MS,
    EVENTS_TIMEOUT_MS,
    COMMAND_TIMEOUT_MS,
    COMMAND_TIMEOUT_MS,
    COMMAND_TIMEOUT_MS,
    EVENTS_TIMEOUT_MS,
  ],
  // setUp: the same 3 boot waits. The supervisor's stop and restart (its boot catchup is P1).
  // Eleven pulse-paced waits (m2-phases.ts): S1 staffed, S1's worktree, S1's hand-off, S2's
  // accept, S2's hand-off, S3's accept, S3's degraded packet, S4's accept, T blocked, P5, the
  // run-now pulse settled. Four command-scale waits: S3 running, S4 idle, the two run-now commands.
  m2: [
    BOOT_TIMEOUT_MS,
    BOOT_TIMEOUT_MS,
    BOOT_TIMEOUT_MS,
    M3_CONFORMANCE_TIMEOUT_MS,
    EXIT_TIMEOUT_MS,
    BOOT_TIMEOUT_MS,
    ...Array.from({ length: 11 }, () => M2_STEP_TIMEOUT_MS),
    ...Array.from({ length: 4 }, () => COMMAND_TIMEOUT_MS),
  ],
  // setUp: the same 3 boot waits. Two conformance commands (certify.ts: the shared fixture one,
  // then the reviewer's). Six builder steps, each three command-scale waits and one events wait: a
  // spawn command, its run's terminal event, the session at rest, and then either its packet
  // finalized (the five that release themselves at a phase boundary) or its stop command
  // (B4, which moved no status). Five gate waits: T's plan_review, rounds 1 and 2, T2's two
  // attempts, T3's plan_review.
  m3: [
    BOOT_TIMEOUT_MS,
    BOOT_TIMEOUT_MS,
    BOOT_TIMEOUT_MS,
    M3_CONFORMANCE_TIMEOUT_MS,
    M3_CONFORMANCE_TIMEOUT_MS,
    ...Array.from({ length: 18 }, () => COMMAND_TIMEOUT_MS),
    ...Array.from({ length: 6 }, () => EVENTS_TIMEOUT_MS),
    ...Array.from({ length: 5 }, () => M3_GATE_TIMEOUT_MS),
  ],
  // The container run (m3-ctr-*.ts). setUp: the same 3 boot waits; before the supervisor: executor
  // add, the unlabelled list, the image, the stand-in's two copies. Then the fixture runner's
  // certification on local for the builders. C0 health. C1 spawn command,
  // terminal, idle. C2 four scans. C3 stop command, reaped. C4 the gateway and three probes. 1c one
  // conformance command. Tc: three builder steps (three command waits and one events wait each),
  // two rounds (a gate wait and a reaped wait each). Teardown's three host commands.
  m3Container: [
    BOOT_TIMEOUT_MS,
    BOOT_TIMEOUT_MS,
    BOOT_TIMEOUT_MS,
    CTR_SSH_TIMEOUT_MS,
    CTR_SSH_TIMEOUT_MS,
    CTR_IMAGE_TIMEOUT_MS,
    CTR_SSH_TIMEOUT_MS,
    CTR_SSH_TIMEOUT_MS,
    M3_CONFORMANCE_TIMEOUT_MS,
    CTR_HEALTH_TIMEOUT_MS,
    COMMAND_TIMEOUT_MS,
    EVENTS_TIMEOUT_MS,
    COMMAND_TIMEOUT_MS,
    ...Array.from({ length: 4 }, () => CTR_SSH_TIMEOUT_MS),
    COMMAND_TIMEOUT_MS,
    M3_GATE_TIMEOUT_MS,
    ...Array.from({ length: 4 }, () => CTR_SSH_TIMEOUT_MS),
    CTR_CONFORMANCE_TIMEOUT_MS,
    ...Array.from({ length: 9 }, () => COMMAND_TIMEOUT_MS),
    ...Array.from({ length: 3 }, () => EVENTS_TIMEOUT_MS),
    ...Array.from({ length: 4 }, () => M3_GATE_TIMEOUT_MS),
    ...Array.from({ length: 3 }, () => CTR_SSH_TIMEOUT_MS),
  ],
  // setUp: the same 3 boot waits, then the fixture runner's certification. Budget: the cap write,
  // the queued spawn, the raise, its terminal. Kill switch: the gated spawn running, the pause, the
  // queued spawn, the gated run's terminal, the resume admitting it. Backup: write, then restore.
  // Then the plug cycle twice, each: the sessions placed (3 command waits), the snapshot, the
  // restart and its whole recovery. Sweep: one pass over the worktrees left behind.
  m4: [
    BOOT_TIMEOUT_MS,
    BOOT_TIMEOUT_MS,
    BOOT_TIMEOUT_MS,
    M3_CONFORMANCE_TIMEOUT_MS,
    ...Array.from({ length: 12 }, () => COMMAND_TIMEOUT_MS),
    ...Array.from({ length: 4 }, () => EVENTS_TIMEOUT_MS),
    M4_BACKUP_TIMEOUT_MS,
    M4_BACKUP_TIMEOUT_MS,
    ...Array.from({ length: 2 }, () => M4_PLUG_TIMEOUT_MS),
    COMMAND_TIMEOUT_MS,
  ],
};

/** Slack over the worst-case step sum, covering scheduling jitter between steps. */
export const OUTER_MARGIN_MS = 60_000;

/** The arithmetic itself: the step deadlines plus the margin, kept as a pure function so it has
 * its own unit test independent of the concrete constants above. */
export function outerDeadlineMs(
  stepsMs: readonly number[],
  marginMs: number,
): number {
  return stepsMs.reduce((total, ms) => total + ms, 0) + marginMs;
}

/**
 * The whole `frm smoke` run's default deadline for each mode: always more than every step it can
 * hit could legitimately need, so a slow run times out on a specific step's own deadline — with
 * its name and log tails — rather than the outer catch-all firing first.
 */
export const SMOKE_DEADLINE_MS = {
  normal: outerDeadlineMs(STEPS_MS.normal, OUTER_MARGIN_MS),
  hang: outerDeadlineMs(STEPS_MS.hang, OUTER_MARGIN_MS),
  m1: outerDeadlineMs(STEPS_MS.m1, OUTER_MARGIN_MS),
  m2: outerDeadlineMs(STEPS_MS.m2, OUTER_MARGIN_MS),
  m3: outerDeadlineMs(STEPS_MS.m3, OUTER_MARGIN_MS),
  m3Container: outerDeadlineMs(STEPS_MS.m3Container, OUTER_MARGIN_MS),
  m4: outerDeadlineMs(STEPS_MS.m4, OUTER_MARGIN_MS),
} as const;
