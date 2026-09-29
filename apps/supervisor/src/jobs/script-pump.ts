// The op loop every `script` job of this daemon runs (MEDIUM-5). One file rather
// than a copy per job, because the thing that was wrong was wrong in both copies.
//
// A job reads one `send` from stdin, does its work, honours `interrupt`, and exits only when stdin
// ends (`@bayon/runners/script` states the contract). The trap is the order: awaiting the work
// before entering the loop means *nothing reads stdin while the work runs*, which is the whole life
// of a job that shells out. An `interrupt` then sits in the pipe until the work finishes on its
// own, and the `AbortSignal` threaded down into the child's `killGroup` can never fire. Nothing
// runs unbounded either way — the session's process group is SIGKILLed at the gate's wall clock —
// but a stop that can only arrive after the thing it stops is no stop, and the parameter reads as
// working cancellation.
import { readGo, type ScriptOp } from "@bayon/runners/script";

/**
 * Runs `run` beside the op loop: `interrupt` aborts its signal while it is still running, and stdin
 * ending waits for it rather than cutting it off mid-command.
 *
 * Rejects with whatever `run` rejected with, after the loop has drained — the caller reports it as
 * the job's terminal failure.
 */
export async function pump(
  ops: AsyncGenerator<ScriptOp>,
  run: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const stop = new AbortController();
  const go = await readGo(ops);
  const settled = go === undefined ? Promise.resolve() : run(stop.signal);
  // Marks a rejection handled so it cannot surface as an unhandled rejection while the loop below
  // is still awaiting stdin. `await settled` after the loop still throws it — nothing is swallowed.
  settled.catch(() => undefined);
  for (;;) {
    const next = await ops.next();
    if (next.done === true) break;
    if (next.value.op === "interrupt") stop.abort();
  }
  await settled;
}
