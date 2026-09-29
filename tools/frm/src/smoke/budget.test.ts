import { expect, test } from "vitest";
import {
  BOOT_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  CTR_CONFORMANCE_TIMEOUT_MS,
  CTR_HEALTH_TIMEOUT_MS,
  CTR_IMAGE_TIMEOUT_MS,
  CTR_SSH_TIMEOUT_MS,
  EVENTS_TIMEOUT_MS,
  EXIT_TIMEOUT_MS,
  HANG_WALL_CLOCK_MS,
  HEARTBEAT_TIMEOUT_MS,
  M2_STEP_TIMEOUT_MS,
  M3_CONFORMANCE_TIMEOUT_MS,
  M3_GATE_TIMEOUT_MS,
  OUTER_MARGIN_MS,
  outerDeadlineMs,
  SMOKE_DEADLINE_MS,
} from "./budget.js";

// the whole-run deadline used to be picked independently of the step deadlines it
// wraps, and was shorter than their worst-case sum — so under load the outer "frm smoke" timeout
// fired first with a bare "the overall deadline passed" instead of the failing step's own message.

test("outerDeadlineMs sums the step deadlines plus the margin", () => {
  expect(outerDeadlineMs([10, 20, 30], 5)).toBe(65);
  expect(outerDeadlineMs([], 100)).toBe(100);
  expect(outerDeadlineMs([1_000], 0)).toBe(1_000);
});

test("the normal-mode deadline exceeds the worst case if every step it can hit takes the full time", () => {
  // setUp's 3 boot waits, buildSession's 1 command + 1 events wait, apiRestart's 2 commands +
  // 1 events wait + 1 exit wait + 1 heartbeat wait + 1 boot wait (API restart), and
  // resumeAndCompare's 1 command + 2 events waits — the exact path phases.ts awaits for a
  // non-hang run.
  // Plus the fixture runner's certification after setUp (require_certified=1).
  const worstCase =
    4 * BOOT_TIMEOUT_MS +
    M3_CONFORMANCE_TIMEOUT_MS +
    4 * COMMAND_TIMEOUT_MS +
    4 * EVENTS_TIMEOUT_MS +
    EXIT_TIMEOUT_MS +
    HEARTBEAT_TIMEOUT_MS;
  expect(SMOKE_DEADLINE_MS.normal).toBeGreaterThan(worstCase);
  expect(SMOKE_DEADLINE_MS.normal).toBe(worstCase + OUTER_MARGIN_MS);
});

test("the --hang deadline exceeds the worst case of its own (shorter) path", () => {
  // setUp's 3 boot waits, then buildSession's 1 command wait and one events wait that itself
  // already includes the run class's own wall-clock kill; apiRestart never runs with --hang.
  const worstCase =
    3 * BOOT_TIMEOUT_MS +
    M3_CONFORMANCE_TIMEOUT_MS +
    COMMAND_TIMEOUT_MS +
    (EVENTS_TIMEOUT_MS + HANG_WALL_CLOCK_MS);
  expect(SMOKE_DEADLINE_MS.hang).toBeGreaterThan(worstCase);
  expect(SMOKE_DEADLINE_MS.hang).toBe(worstCase + OUTER_MARGIN_MS);
});

test("the --m1 deadline exceeds the worst case of its own path", () => {
  // setUp's 3 boot waits. The M1 session: the spawn command, the human_ask call arriving, the
  // running check, the stop command, its terminal. The exports: two export commands, each
  // exporter's terminal, the ticket_exports rows, the first exporter's stop.
  const worstCase =
    3 * BOOT_TIMEOUT_MS +
    M3_CONFORMANCE_TIMEOUT_MS +
    7 * COMMAND_TIMEOUT_MS +
    4 * EVENTS_TIMEOUT_MS;
  expect(SMOKE_DEADLINE_MS.m1).toBeGreaterThan(worstCase);
  expect(SMOKE_DEADLINE_MS.m1).toBe(worstCase + OUTER_MARGIN_MS);
});

test("the --m2 deadline exceeds the worst case of its own path", () => {
  // setUp's 3 boot waits; the supervisor's stop and restart; eleven pulse-paced waits (S1 staffed,
  // its worktree, its hand-off; S2's accept and hand-off; S3's accept and degraded packet; S4's
  // accept; T blocked; P5; the run-now pulse settled); four command-scale waits (S3 running, S4
  // idle, the two run-now commands).
  const worstCase =
    4 * BOOT_TIMEOUT_MS +
    M3_CONFORMANCE_TIMEOUT_MS +
    EXIT_TIMEOUT_MS +
    11 * M2_STEP_TIMEOUT_MS +
    4 * COMMAND_TIMEOUT_MS;
  expect(SMOKE_DEADLINE_MS.m2).toBeGreaterThan(worstCase);
  expect(SMOKE_DEADLINE_MS.m2).toBe(worstCase + OUTER_MARGIN_MS);
});

test("the --m3 deadline exceeds the worst case of its own path", () => {
  // setUp's 3 boot waits; the two conformance commands; six builder steps (spawn command, the
  // run's terminal event, the session idle, stop command); five gate waits (T's plan_review,
  // rounds 1 and 2, T2's two attempts, T3's plan_review).
  const worstCase =
    3 * BOOT_TIMEOUT_MS +
    2 * M3_CONFORMANCE_TIMEOUT_MS +
    18 * COMMAND_TIMEOUT_MS +
    6 * EVENTS_TIMEOUT_MS +
    5 * M3_GATE_TIMEOUT_MS;
  expect(SMOKE_DEADLINE_MS.m3).toBeGreaterThan(worstCase);
  expect(SMOKE_DEADLINE_MS.m3).toBe(worstCase + OUTER_MARGIN_MS);
});

test("the --m3 container run's deadline exceeds the worst case of its own path", () => {
  // setUp's 3 boot waits; before the supervisor: executor add, the unlabelled list, the image, the
  // stand-in's two copies; C0 health; C1 spawn, terminal, idle; C2 four scans; C3 stop and reaped;
  // C4 the gateway and three probes; 1c conformance; Tc's three builder steps and two rounds (a
  // gate wait and a reaped wait each); teardown's three host commands. Plus the fixture runner's
  // certification on local after setUp (require_certified=1).
  const worstCase =
    3 * BOOT_TIMEOUT_MS +
    15 * CTR_SSH_TIMEOUT_MS +
    CTR_IMAGE_TIMEOUT_MS +
    CTR_HEALTH_TIMEOUT_MS +
    12 * COMMAND_TIMEOUT_MS +
    4 * EVENTS_TIMEOUT_MS +
    5 * M3_GATE_TIMEOUT_MS +
    M3_CONFORMANCE_TIMEOUT_MS +
    CTR_CONFORMANCE_TIMEOUT_MS;
  expect(SMOKE_DEADLINE_MS.m3Container).toBe(worstCase + OUTER_MARGIN_MS);
  expect(SMOKE_DEADLINE_MS.m3Container).toBeGreaterThan(SMOKE_DEADLINE_MS.m3);
});

test("the hang deadline is shorter than the normal one, as the CLI usage promises", () => {
  expect(SMOKE_DEADLINE_MS.hang).toBeLessThan(SMOKE_DEADLINE_MS.normal);
});
