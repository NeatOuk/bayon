import { describe, expect, test } from "vitest";
import { retryStormHolds, type RetryStormSettings } from "../admission.js";
import {
  circuitVerdict,
  isTicketFailure,
  type CircuitInput,
  type TicketFailure,
} from "./circuit.js";
import { pairKey } from "./requests.js";

// The breaker's verdict: the ticket's own failures since its reset,
// supervisor restarts, interruptions, refusals and storm bursts excluded.

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 14, 12);
const STORM: RetryStormSettings = {
  count: 5,
  windowMs: 10 * MIN,
  backoffMs: 15 * MIN,
};

let seq = 0;
const failure = (o: Partial<TicketFailure> = {}): TicketFailure => {
  seq += 1;
  return {
    kind: "run",
    sessionId: `s${seq}`,
    runId: `r${seq}`,
    runnerId: "fixture",
    executorId: "local",
    state: "failed",
    errorClass: "runner_exited_without_terminal",
    errorMessage: null,
    at: T0 + seq,
    ...o,
  };
};

const judge = (o: Partial<CircuitInput> & Pick<CircuitInput, "failures">) =>
  circuitVerdict({
    resetAt: T0,
    threshold: 3,
    holdsByPair: new Map(),
    ...o,
  });

describe("circuitVerdict", () => {
  test("trips at the threshold, not below it", () => {
    const three = [failure(), failure(), failure()];
    expect(judge({ failures: three.slice(0, 2) }).tripped).toBe(false);
    expect(judge({ failures: three }).tripped).toBe(true);
    expect(judge({ failures: three.slice(0, 2), threshold: 2 }).tripped).toBe(
      true,
    );
  });

  test("only failures after the reset count", () => {
    const before = failure({ at: T0 - 1 });
    const atReset = failure({ at: T0 });
    const after = [failure(), failure()];
    const v = judge({ failures: [before, atReset, ...after] });
    expect(v.tripped).toBe(false);
    expect(v.counted.map((f) => f.at)).toEqual(after.map((f) => f.at));
  });

  test("restarts, interruptions and admission refusals are never the ticket's", () => {
    for (const errorClass of [
      "interrupted",
      "supervisor_restart",
      "admission_refused",
    ]) {
      const v = judge({
        failures: [
          failure({ errorClass }),
          failure({ errorClass, state: "timeout" }),
          failure({ errorClass, kind: "start", runId: null, state: "exited" }),
        ],
      });
      expect(v.counted, errorClass).toEqual([]);
    }
  });

  test("interrupted, budget_stop and ok runs are not failures; timeouts and failed starts are", () => {
    expect(isTicketFailure(failure({ state: "interrupted" }))).toBe(false);
    expect(isTicketFailure(failure({ state: "budget_stop" }))).toBe(false);
    expect(isTicketFailure(failure({ state: "ok" }))).toBe(false);
    expect(isTicketFailure(failure({ state: "timeout" }))).toBe(true);
    expect(
      isTicketFailure(
        failure({
          kind: "start",
          runId: null,
          state: "exited",
          errorClass: "spawn_failed",
        }),
      ),
    ).toBe(true);
  });

  test("runner_error inside a burst of its own pair is the storm's, even long after the hold lapsed", () => {
    const burst = [0, 1, 2, 3, 4].map((i) => T0 + i * MIN);
    const holds = new Map([
      [pairKey("fixture", "local"), retryStormHolds(burst, STORM)],
    ]);
    const inBurst = [T0 + 2 * MIN, T0 + 4 * MIN, T0 + 10 * MIN].map((at) =>
      failure({ at, errorClass: "runner_error" }),
    );
    // The verdict takes no `now`: a hold that lapsed hours ago still excludes its burst.
    expect(judge({ failures: inBurst, holdsByPair: holds }).counted).toEqual(
      [],
    );
  });

  test("the storm excludes only runner_error, only of its pair, only inside the burst", () => {
    const burst = [0, 1, 2, 3, 4].map((i) => T0 + i * MIN);
    const holds = new Map([
      [pairKey("fixture", "local"), retryStormHolds(burst, STORM)],
    ]);
    const counted = [
      failure({ at: T0 + 2 * MIN, state: "timeout", errorClass: "timeout" }),
      failure({
        at: T0 + 3 * MIN,
        errorClass: "runner_error",
        executorId: "ctr-lab",
      }),
      failure({ at: T0 + 20 * MIN, errorClass: "runner_error" }),
    ];
    const v = judge({ failures: counted, holdsByPair: holds });
    expect(v.tripped).toBe(true);
    expect(v.counted).toHaveLength(3);
  });

  test("counted failures come oldest first", () => {
    const late = failure({ at: T0 + 30 });
    const early = failure({ at: T0 + 10 });
    expect(judge({ failures: [late, early] }).counted).toEqual([early, late]);
  });
});
