import type { ExecutorView } from "@bayon/proto";
import { expect, test } from "vitest";
import {
  defaultExecutor,
  formatElapsed,
  offeredExecutors,
  progressText,
} from "@/runners/conformance-progress";
import { executorView } from "@/test/executor-fixtures";
import { certification, commandView, summary } from "@/test/runner-fixtures";

// an operator watching a conformance run has to be able to tell a slow run from a
// wedged one, and a run waiting behind another from one nobody has picked up.

const T0 = 1_800_000_000_000;
const ID = "01M2SQSZ8ZE739M0T32ESWFQZ3";

const target = (executorId: string) => ({
  runner_id: "runner-a",
  executor_id: executorId,
});

test("an elapsed time is coarse enough to read and fine enough to tick", () => {
  expect(formatElapsed(0)).toBe("0s");
  expect(formatElapsed(8_400)).toBe("8s");
  expect(formatElapsed(59_999)).toBe("59s");
  expect(formatElapsed(60_000)).toBe("1m 00s");
  expect(formatElapsed(372_000)).toBe("6m 12s");
  expect(formatElapsed(3_960_000)).toBe("1h 06m");
  // Two stamps out of order never read as a negative age.
  expect(formatElapsed(-5_000)).toBe("0s");
});

test("a queued run says how long it has been queued, not just that it is", () => {
  expect(
    progressText(
      commandView({ id: ID, state: "pending", ts: T0, now: T0 + 90_000 }),
      ID,
    ),
  ).toBe(
    `Conformance queued 1m 30s ago; the supervisor has not claimed it yet (command ${ID}).`,
  );
});

test("a running run says how long it has been running", () => {
  expect(
    progressText(
      commandView({
        id: ID,
        state: "claimed",
        ts: T0,
        claimed_at: T0 + 1_000,
        now: T0 + 373_000,
      }),
      ID,
    ),
  ).toBe(`Conformance running on the supervisor for 6m 12s (command ${ID})…`);
});

test("a run waiting behind another names it, where it runs and how long it has been going", () => {
  // The reported bug: conformance runs are serialised, so this command is claimed but waiting.
  expect(
    progressText(
      commandView({
        id: ID,
        state: "claimed",
        ts: T0,
        claimed_at: T0,
        now: T0 + 30_000,
        ahead: [
          {
            id: "cmd-ahead",
            ts: T0 - 342_000,
            state: "claimed",
            claimed_at: T0 - 342_000,
            payload: target("ctr-lab"),
          },
        ],
      }),
      ID,
    ),
  ).toBe(
    `Conformance queued 30s ago, waiting behind 1 other conformance run, on ctr-lab, going 6m 12s (command ${ID}).`,
  );
});

test("a run ahead that names its model says which", () => {
  expect(
    progressText(
      commandView({
        id: ID,
        state: "claimed",
        ts: T0,
        claimed_at: T0,
        now: T0 + 30_000,
        ahead: [
          {
            id: "cmd-ahead",
            ts: T0 - 342_000,
            state: "claimed",
            claimed_at: T0 - 342_000,
            payload: { ...target("ctr-lab"), model_id: "runner-a.cheap" },
          },
        ],
      }),
      ID,
    ),
  ).toBe(
    `Conformance queued 30s ago, waiting behind 1 other conformance run, on ctr-lab with runner-a.cheap, going 6m 12s (command ${ID}).`,
  );
});

test("two runs ahead are counted, and the one in front is the one described", () => {
  expect(
    progressText(
      commandView({
        id: ID,
        state: "pending",
        ts: T0,
        now: T0 + 5_000,
        ahead: [
          {
            id: "cmd-front",
            ts: T0 - 120_000,
            state: "claimed",
            claimed_at: T0 - 60_000,
            payload: target("local"),
          },
          {
            id: "cmd-middle",
            ts: T0 - 60_000,
            state: "pending",
            claimed_at: null,
            payload: target("ctr-lab"),
          },
        ],
      }),
      ID,
    ),
  ).toBe(
    `Conformance queued 5s ago, waiting behind 2 other conformance runs; the one in front, on local, going 1m 05s (command ${ID}).`,
  );
});

test("a run ahead whose payload says nothing is still counted and timed", () => {
  expect(
    progressText(
      commandView({
        id: ID,
        state: "pending",
        ts: T0,
        now: T0 + 5_000,
        ahead: [
          {
            id: "cmd-front",
            ts: T0 - 60_000,
            state: "pending",
            claimed_at: null,
            payload: { not: "a conformance payload" },
          },
        ],
      }),
      ID,
    ),
  ).toBe(
    `Conformance queued 5s ago, waiting behind 1 other conformance run, going 1m 05s (command ${ID}).`,
  );
});

test("a settled run still reports its verdict, and an unread command its id", () => {
  expect(progressText(undefined, ID)).toBe(
    `Conformance queued (command ${ID}).`,
  );
  expect(
    progressText(
      commandView({
        id: ID,
        state: "failed",
        error: {
          class: "internal",
          message: "the suite crashed",
          retryable: false,
        },
      }),
      ID,
    ),
  ).toBe("Conformance failed: the suite crashed.");
  expect(
    progressText(
      commandView({
        id: ID,
        state: "done",
        result: {
          runner_id: "runner-a",
          executor_id: "local",
          runner_version: "1.2.0",
          report_path: "/frm/docs/conformance/runner-a@local.md",
          stored: true,
          summary: summary(),
        },
      }),
      ID,
    ),
  ).toBe(
    "Conformance done on local: 12 passed, 0 failed, 2 n/a, 0 incomplete. Certification updated. Report: /frm/docs/conformance/runner-a@local.md",
  );
});

const CTR = executorView({ id: "ctr-lab", kind: "container" });
const LOCAL = executorView({ id: "local", kind: "local" });

test("the executor defaults to the one the runner was most recently certified on", () => {
  expect(
    defaultExecutor(
      [CTR, LOCAL],
      [
        certification({ executor_id: "local", certified_at: T0 }),
        certification({ executor_id: "ctr-lab", certified_at: T0 + 1 }),
      ],
    ),
  ).toBe("ctr-lab");
  expect(
    defaultExecutor(
      [CTR, LOCAL],
      [
        certification({ executor_id: "local", certified_at: T0 + 1 }),
        certification({ executor_id: "ctr-lab", certified_at: T0 }),
      ],
    ),
  ).toBe("local");
});

test("a lapsed, failed or unregistered certification does not pick the executor", () => {
  const lapsed = certification({
    executor_id: "ctr-lab",
    certified_at: T0 + 10,
    decertified_at: T0 + 20,
  });
  const failed = certification({
    executor_id: "ctr-lab",
    certified_at: T0 + 10,
    passed_at: null,
  });
  const gone = certification({ executor_id: "ctr-9", certified_at: T0 + 10 });
  for (const c of [lapsed, failed, gone]) {
    expect(defaultExecutor([CTR, LOCAL], [c])).toBe("local");
  }
});

test("with no certification it falls back to a local executor, then to the first offered", () => {
  expect(defaultExecutor([CTR, LOCAL], [])).toBe("local");
  expect(defaultExecutor([CTR], [])).toBe("ctr-lab");
  expect(defaultExecutor([], [])).toBeNull();
});

test("an executor taken out of service is neither offered nor picked", () => {
  // an earlier change landed `frm executor disable`, so the state exists now: a conformance suite takes
  // minutes, and pre-selecting a box the operator disabled is how one runs on a box deliberately
  // taken down. an earlier change made the server refuse such a run outright, so it is no longer offered
  // either: the dropdown and the server now agree on a state somebody decided.
  const off = (e: ExecutorView): ExecutorView =>
    executorView({ ...e, enabled: false });
  const certified = certification({ executor_id: "local", certified_at: T0 });
  expect(offeredExecutors([CTR, LOCAL]).map((e) => e.id)).toEqual([
    "ctr-lab",
    "local",
  ]);
  expect(offeredExecutors([CTR, off(LOCAL)]).map((e) => e.id)).toEqual([
    "ctr-lab",
  ]);
  expect(offeredExecutors([off(CTR), off(LOCAL)])).toEqual([]);
  // Not even the most recent certification pulls a disabled executor back in.
  expect(defaultExecutor([CTR, off(LOCAL)], [certified])).toBe("ctr-lab");
  expect(defaultExecutor([CTR, off(LOCAL)], [])).toBe("ctr-lab");
  // With every executor disabled there is nothing to pick at all.
  expect(defaultExecutor([off(CTR), off(LOCAL)], [certified])).toBeNull();
});
