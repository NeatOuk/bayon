import type { ScriptOp } from "@bayon/runners/script";
import { expect, test } from "vitest";
import { pump } from "./script-pump.js";

// Every script job's op loop (review MEDIUM-5). The lint job spends its whole life
// inside one `runLintJob` call -- a repo's install and then its lint, up to the gate's fifteen
// minutes -- so whether stdin is read *during* that call is the difference between a working
// `interrupt` and a parameter that only looks like one. The parity job carried the same copy.

const ops = (...list: readonly ScriptOp[]): AsyncGenerator<ScriptOp> =>
  (async function* () {
    for (const op of list) yield op;
  })();

const GO: ScriptOp = { op: "send", runId: "r-1", text: "go" };
const INTERRUPT: ScriptOp = { op: "interrupt" };

test("an interrupt reaches the running job, not the job that has already finished", async () => {
  let aborted = false;
  let finish = (): void => undefined;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  // A stand-in for runOnce: it runs until something aborts it, exactly as a lint command does.
  const run = async (signal: AbortSignal): Promise<void> => {
    signal.addEventListener("abort", () => {
      aborted = true;
      finish();
    });
    await blocked;
  };
  // Awaiting the run before the loop, this never returns: the interrupt is the only thing that can
  // end the run, and it is sitting unread behind the run itself.
  await pump(ops(GO, INTERRUPT), run);
  expect(aborted).toBe(true);
});

test("stdin's end waits for the job: the child never exits mid-command", async () => {
  let done = false;
  await pump(ops(GO), async () => {
    await new Promise((r) => setTimeout(r, 5));
    done = true;
  });
  expect(done).toBe(true);
});

test("stdin that ends before any send runs nothing at all", async () => {
  let ran = false;
  await pump(ops(INTERRUPT), async () => {
    ran = true;
  });
  expect(ran).toBe(false);
});

test("a run that throws is reported to the caller, never swallowed", async () => {
  await expect(
    pump(ops(GO), () => Promise.reject(new Error("the job died"))),
  ).rejects.toThrow("the job died");
});
