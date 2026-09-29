import { FakeClock } from "@bayon/core";
import { getTicket } from "@bayon/db";
import {
  newRunInput,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test } from "vitest";
import { ReleaseCandidates } from "./candidates.js";
import { createWatchdog } from "./watchdog.js";

// The run-ended event: only a run that did not end ok queues its ticket's
// circuit. A ticket already at the threshold shows it: an ok run's event trips nothing, a failed
// run's event trips it.

const T0 = Date.UTC(2026, 8, 14, 12);
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 14));
afterAll(() => t.cleanup());

let seq = 0;
unwrap(
  await seedRows(t.db, {
    tickets: [ticketRow(1, { status: "building", created_at: T0 - 60_000 })],
    sessions: [
      {
        ...newSessionInput(),
        id: "s1",
        ticket_id: "ticket-1",
        state: "idle",
        created_at: 0,
      },
    ],
    runs: [1, 2, 3].map((i) => {
      seq += 1;
      return {
        ...newRunInput("s1"),
        id: `run-${seq}`,
        seq,
        state: "failed" as const,
        error_class: "runner_exited_without_terminal",
        started_at: T0 - 100 + i,
        ended_at: T0 - 50 + i,
      };
    }),
  }),
);

const w = createWatchdog({
  db: t.db,
  clock,
  log: pino({ level: "silent" }),
  candidates: new ReleaseCandidates(),
  killGraceMs: () => 5_000,
  probeTimeoutMs: () => 1_000,
  liveProcesses: () => [],
  checkCeilings: () => undefined,
  diskPaths: [],
});

/** Lets runEnded's session read and its queued op, if any, run to their end. */
async function drained(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await w.settled();
}

test("an ok run's terminal queues nothing", async () => {
  w.runEnded("s1", "ok");
  await drained();
  expect(unwrap(await getTicket(t.db, "ticket-1")).status).toBe("building");
});

test("a failed run's terminal queues the circuit, which trips at the threshold", async () => {
  w.runEnded("s1", "failed");
  await drained();
  expect(unwrap(await getTicket(t.db, "ticket-1")).status).toBe("blocked");
});
