import type { FakeIo } from "@bayon/executors/testing";
import { runFixture } from "./program.js";

/**
 * The fixture program for FakeExecutor, run in-process: register it under `FIXTURE_PROGRAM` and
 * build the adapter with `command: [FIXTURE_PROGRAM]`. In-process, a crash exits 137 and every
 * signal is fatal (so `hard_hang` cannot ignore SIGTERM).
 */
export const fixtureProgram = (io: FakeIo): Promise<number> =>
  runFixture({
    argv: io.argv,
    cwd: io.cwd,
    env: io.env,
    fetch: (url, init) => fetch(url, init),
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    crash: async () => 137,
    ignoreTerm: () => undefined,
  });
