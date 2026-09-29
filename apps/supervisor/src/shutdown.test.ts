// The supervisor lock keeps one supervisor per FRM_HOME (Invariant 12): shutdown releases it
// last, after the database and socket close, so a restarter cannot boot a second writer mid-flush.
import { mkdtempSync, rmSync } from "node:fs";
import { FakeClock, err, ok } from "@bayon/core";
import { unwrap } from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test, vi } from "vitest";
import { startSupervisor } from "./supervisor.js";

const T0 = 1_700_000_000_000;
const home = mkdtempSync("/tmp/frm-");
afterAll(() => rmSync(home, { recursive: true, force: true }));
const log = pino({ level: "silent" });
const base = { home, log, version: "0.1.0" } as const;

test("a second supervisor is refused until the first one's shutdown has resolved", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let shuttingDown = false;
  const first = unwrap(
    await startSupervisor({
      ...base,
      clock: new FakeClock(T0),
      lifecycle: () => ({
        boot: async () => ok(undefined),
        spawnInternal: async () => ok("unused"),
        stop: async () => undefined,
        onSessionEnded: () => () => undefined,
        onHandoffPending: () => () => undefined,
        shutdown: async () => {
          shuttingDown = true;
          await gate; // the first supervisor is still mid-shutdown, its DB still open
        },
        spawn: async () =>
          err({
            class: "not_found",
            message: "unused in this test",
            retryable: false,
          }),
      }),
    }),
  );
  const stopping = first.shutdown();
  await vi.waitFor(() => expect(shuttingDown).toBe(true));

  const during = await startSupervisor({ ...base, clock: new FakeClock(T0) });
  expect(during.ok ? null : during.error.class).toBe("conflict");

  release();
  await stopping;
  const after = unwrap(
    await startSupervisor({ ...base, clock: new FakeClock(T0) }),
  );
  await after.shutdown();
});
