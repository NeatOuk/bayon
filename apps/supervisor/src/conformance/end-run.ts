// The end of a conformance run: nothing the suite started outlives it. No process starts
// from here on, and every group the suite launched that is still alive is killed and waited for;
// then its ports are disposed and its directory removed. Never rejects: what went wrong comes back,
// so the run's report is still written, and a run that left something behind stores no
// certification. The refs and paths go to the log; what comes back names none (the report's rule).
import { rm } from "node:fs/promises";
import { err, type Clock, type Result } from "@bayon/core";
import type { FaultExecutor } from "@bayon/runners/conformance";
import type { Logger } from "pino";
import { frmError } from "../lifecycle/errors.js";

export interface EndRunOptions {
  /** The suite's executor: it recorded every process the run launched. */
  readonly fault: FaultExecutor;
  readonly clock: Clock;
  readonly log: Logger;
  readonly dir: string;
  /** The ports' dispose: ok only when the workspace freed everything it placed. */
  readonly dispose: () => Promise<Result<void>>;
  /** How long a killed group gets to leave the process table. */
  readonly killMs: number;
  readonly removeDir: (dir: string) => Promise<void>;
}

export const removeRunDir = (dir: string): Promise<void> =>
  rm(dir, { recursive: true, force: true });

const codeOf = (e: unknown): string =>
  typeof e === "object" &&
  e !== null &&
  "code" in e &&
  typeof e.code === "string"
    ? e.code
    : "error";

/** Removes the run's directory; what went wrong, if anything. */
async function remove(o: EndRunOptions): Promise<string | undefined> {
  try {
    await o.removeDir(o.dir);
    return undefined;
  } catch (e) {
    o.log.error(
      { dir: o.dir, err: String(e) },
      "cannot remove a conformance run's directory",
    );
    return `its run directory could not be removed (${codeOf(e)})`;
  }
}

/** Ends the run. Returns what its end left undone: empty when it left nothing behind. */
export async function endRun(o: EndRunOptions): Promise<readonly string[]> {
  const groups = await o.fault.end(o.clock, o.killMs);
  if (groups.killed.length > 0) {
    o.log.error(
      { dir: o.dir, killed: groups.killed, outlived: groups.alive },
      "a conformance run's processes were alive at its end: killed",
    );
  }
  const disposed = await o
    .dispose()
    .catch((e: unknown) =>
      err(
        frmError(
          "internal",
          "the conformance ports did not dispose",
          String(e),
        ),
      ),
    );
  if (!disposed.ok) {
    // Its journal names what is still on the executor: the next sweep frees it (§7).
    o.log.error(
      { dir: o.dir, error: disposed.error },
      "a conformance run left sessions on its executor: kept its run directory",
    );
  }
  // A group that outlived its kill may still write there: the directory stays with it.
  const removal =
    disposed.ok && groups.alive.length === 0 ? await remove(o) : undefined;
  return [
    ...(groups.killed.length === 0
      ? []
      : [
          `${groups.killed.length} process group(s) the suite started were still alive at its end and were killed`,
        ]),
    ...(groups.alive.length === 0
      ? []
      : [
          `${groups.alive.length} process group(s) outlived their kill, so the run directory was kept`,
        ]),
    ...(removal === undefined ? [] : [removal]),
  ];
}
