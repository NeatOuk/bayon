import { FakeClock, ok } from "@bayon/core";
import { getCommand, type Db } from "@bayon/db";
import { claimCommand } from "@bayon/db/supervisor";
import { insertCommand, tempDb, unwrap } from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test, vi } from "vitest";
import { z } from "zod";
import { createClaimer, type CommandHandler } from "./claimer.js";

// The claimer's requeue: at boot every claimed row by its handler's
// idempotent flag; at runtime never a command it is running itself.
const T0 = 1_700_000_000_000;
const log = pino({ level: "silent" });
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function world() {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const claimer = createClaimer({ db: t.db, clock, log });
  cleanups.push(async () => {
    await claimer.stop();
    t.cleanup();
  });
  return { db: t.db, clock, claimer };
}

const BOOT = {
  claimedBefore: Number.POSITIVE_INFINITY,
  maxAttempts: 3,
  why: "the supervisor restarted while it ran",
};

function recorder(
  type: string,
  idempotent: boolean,
  seen: number[],
): CommandHandler<Record<string, never>> {
  return {
    type,
    payload: z.object({}).strict(),
    idempotent,
    handle: async (_p, cmd) => {
      seen.push(cmd.attempts);
      return ok({ attempts: cmd.attempts });
    },
  };
}

const settled = (db: Db, id: string) =>
  vi.waitFor(
    async () => {
      const row = unwrap(await getCommand(db, id));
      expect(["done", "failed"]).toContain(row.state);
      return row;
    },
    { timeout: 5_000 },
  );

/** A command a previous process claimed and never completed. */
async function leftOver(db: Db, clock: FakeClock, type: string) {
  await clock.advance(1);
  const { id } = unwrap(await insertCommand(db, { type, payload: {} }));
  expect(unwrap(await claimCommand(db, { types: [type] }))?.id).toBe(id);
  return id;
}

test("a boot requeue re-delivers an idempotent command (attempt 2) and fails the rest, by their handlers", async () => {
  const w = await world();
  const seen: number[] = [];
  w.claimer.register(recorder("t.idem", true, seen));
  w.claimer.register(recorder("t.once", false, []));
  const idem = await leftOver(w.db, w.clock, "t.idem");
  const once = await leftOver(w.db, w.clock, "t.once");
  const gone = await leftOver(w.db, w.clock, "t.gone");
  const out = unwrap(await w.claimer.requeue(BOOT));
  expect(out).toEqual({ requeued: [idem], failed: [once, gone] });
  w.claimer.start();
  expect(await settled(w.db, idem)).toMatchObject({ state: "done" });
  expect(seen).toEqual([2]);
  expect(
    JSON.parse(unwrap(await getCommand(w.db, once)).error ?? ""),
  ).toMatchObject({
    class: "interrupted",
    retryable: true,
  });
  expect(
    JSON.parse(unwrap(await getCommand(w.db, gone)).error ?? ""),
  ).toMatchObject({
    class: "unknown_command",
  });
});

test("a runtime requeue never touches the command the claimer is running, foreground or background", async () => {
  const w = await world();
  const gates: (() => void)[] = [];
  const blocking = (
    type: string,
    background: boolean,
  ): CommandHandler<Record<string, never>> => ({
    type,
    payload: z.object({}).strict(),
    idempotent: true,
    ...(background ? { background: true } : {}),
    handle: async (_p, cmd) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return ok({ attempts: cmd.attempts });
    },
  });
  w.claimer.register(blocking("t.fg", false));
  w.claimer.register(blocking("t.bg", true));
  const bg = unwrap(
    await insertCommand(w.db, { type: "t.bg", payload: {} }),
  ).id;
  await w.clock.advance(1);
  const fg = unwrap(
    await insertCommand(w.db, { type: "t.fg", payload: {} }),
  ).id;
  w.claimer.start();
  await vi.waitFor(() => expect(gates).toHaveLength(2), { timeout: 5_000 });
  await w.clock.advance(600_000);
  const out = unwrap(
    await w.claimer.requeue({
      claimedBefore: w.clock.now(),
      maxAttempts: 3,
      why: "claimed for more than 300000 ms without completing",
    }),
  );
  expect(out).toEqual({ requeued: [], failed: [] });
  for (const release of gates) release();
  expect(await settled(w.db, bg)).toMatchObject({ state: "done", attempts: 1 });
  expect(await settled(w.db, fg)).toMatchObject({ state: "done", attempts: 1 });
});

test("a requeued command is claimed at once: the requeue wakes the loop", async () => {
  const w = await world();
  const seen: number[] = [];
  w.claimer.register(recorder("t.idem", true, seen));
  w.claimer.start();
  const id = await leftOver(w.db, w.clock, "t.idem");
  unwrap(await w.claimer.requeue(BOOT));
  expect(await settled(w.db, id)).toMatchObject({ state: "done" });
  expect(seen).toEqual([2]);
});
