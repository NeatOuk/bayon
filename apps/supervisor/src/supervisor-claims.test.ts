import { mkdtempSync, rmSync } from "node:fs";
import { FakeClock, ok } from "@bayon/core";
import { getCommand, type Db } from "@bayon/db";
import { claimCommand } from "@bayon/db/supervisor";
import { insertCommand, unwrap } from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test, vi } from "vitest";
import { z } from "zod";
import type { CommandHandler } from "./commands/claimer.js";
import { startSupervisor, type Supervisor } from "./supervisor.js";

// startClaiming with wiring: the claimer runs from boot on the
// types registered so far; startClaiming, after the last registration, settles what a dead process
// left claimed, then wired() fails what no handler will take.
const T0 = 1_700_000_000_000;
const log = pino({ level: "silent" });
const homes: string[] = [];
const running: Supervisor[] = [];
afterAll(async () => {
  for (const s of running) await s.shutdown();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});
const tempHome = () => {
  const home = mkdtempSync("/tmp/frm-");
  homes.push(home);
  return home;
};
const turns = async (n: number) => {
  for (let i = 0; i < n; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

async function start(home: string, clock: FakeClock) {
  const sup = unwrap(
    await startSupervisor({ home, clock, log, version: "0.1.0", wiring: true }),
  );
  running.push(sup);
  return sup;
}

const handler = (
  type: string,
  idempotent: boolean,
  seen: number[] = [],
): CommandHandler<Record<string, never>> => ({
  type,
  payload: z.object({}).strict(),
  idempotent,
  handle: async (_p, cmd) => {
    seen.push(cmd.attempts);
    return ok("done");
  },
});

const settled = (db: Db, id: string) =>
  vi.waitFor(
    async () => {
      const row = unwrap(await getCommand(db, id));
      expect(["done", "failed"]).toContain(row.state);
      return row;
    },
    { timeout: 5_000 },
  );

const post = async (db: Db, clock: FakeClock, type: string) => {
  await clock.advance(1);
  return unwrap(await insertCommand(db, { type, payload: {} })).id;
};

test("a dead process's claims are requeued at boot; before wired() an unhandled type waits, after it an unknown one fails", async () => {
  const home = tempHome();
  const clock = new FakeClock(T0);
  const first = await start(home, clock);
  const idem = await post(first.db, clock, "t.idem");
  const once = await post(first.db, clock, "t.once");
  // The first process claims both, then dies before recording either.
  for (const [id, type] of [
    [idem, "t.idem"],
    [once, "t.once"],
  ] as const) {
    expect(unwrap(await claimCommand(first.db, { types: [type] }))?.id).toBe(
      id,
    );
  }
  await first.shutdown();

  await clock.advance(1);
  const second = await start(home, clock);
  const late = await post(second.db, clock, "t.late");
  const unknown = await post(second.db, clock, "t.unknown");
  second.claimer.wake();
  await turns(20);
  // Wiring: no handler yet, so both wait; the dead claims wait for startClaiming.
  for (const [id, state] of [
    [late, "pending"],
    [unknown, "pending"],
    [idem, "claimed"],
    [once, "claimed"],
  ] as const) {
    expect(unwrap(await getCommand(second.db, id)).state).toBe(state);
  }

  const lateSeen: number[] = [];
  const idemSeen: number[] = [];
  second.claimer.register(handler("t.late", false, lateSeen));
  expect(await settled(second.db, late)).toMatchObject({ state: "done" });
  expect(lateSeen).toEqual([1]);
  second.claimer.register(handler("t.idem", true, idemSeen));
  second.claimer.register(handler("t.once", false));
  await turns(20);
  expect(unwrap(await getCommand(second.db, idem)).state).toBe("claimed");

  unwrap(await second.startClaiming());
  expect(await settled(second.db, idem)).toMatchObject({
    state: "done",
    attempts: 2,
  });
  expect(idemSeen).toEqual([2]);
  expect(JSON.parse((await settled(second.db, once)).error ?? "")).toEqual({
    class: "interrupted",
    message:
      "the supervisor restarted while it ran; t.once is not idempotent, so it was not retried",
    retryable: true,
  });
  expect(
    JSON.parse((await settled(second.db, unknown)).error ?? ""),
  ).toMatchObject({ class: "unknown_command" });
  expect(await second.startClaiming()).toEqual(ok(undefined)); // idempotent
});

test("the boot requeue never touches a claim the new process made before startClaiming", async () => {
  const home = tempHome();
  const clock = new FakeClock(T0);
  const sup = await start(home, clock);
  const gates: (() => void)[] = [];
  sup.claimer.register({
    type: "t.slow",
    payload: z.object({}).strict(),
    idempotent: false,
    handle: async () => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return ok("done");
    },
  });
  const id = await post(sup.db, clock, "t.slow");
  sup.claimer.wake();
  await vi.waitFor(() => expect(gates).toHaveLength(1), { timeout: 5_000 });
  unwrap(await sup.startClaiming());
  expect(unwrap(await getCommand(sup.db, id)).state).toBe("claimed");
  for (const release of gates) release();
  expect(await settled(sup.db, id)).toMatchObject({
    state: "done",
    attempts: 1,
  });
});
