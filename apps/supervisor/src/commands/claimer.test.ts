import { FakeClock, err, ok } from "@bayon/core";
import { getCommand, openDb } from "@bayon/db";
import { insertCommand, tempDb, unwrap } from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test, vi } from "vitest";
import { z } from "zod";
import { createClaimer, type CommandHandler } from "./claimer.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());

const lines: string[] = [];
const log = pino({ level: "info" }, { write: (s: string) => lines.push(s) });

type Seen = {
  n: number;
  id: string;
  attempts: number;
  idempotencyKey?: string;
};
function echo(type: string, seen: Seen[]): CommandHandler<{ n: number }> {
  return {
    type,
    payload: z.object({ n: z.int() }),
    idempotent: true,
    handle: async (p, cmd) => {
      seen.push({ n: p.n, ...cmd });
      return p.n < 0
        ? err({ class: "conflict", message: "negative", retryable: false })
        : ok({ doubled: p.n * 2 });
    },
  };
}

const settled = (id: string) =>
  vi.waitFor(
    async () => {
      const row = unwrap(await getCommand(t.db, id));
      expect(["done", "failed"]).toContain(row.state);
      return row;
    },
    { timeout: 5_000 },
  );

const turns = async (n: number) => {
  for (let i = 0; i < n; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const insert = async (type: string, payload: unknown, key?: string) =>
  unwrap(
    await insertCommand(t.db, {
      type,
      payload,
      ...(key === undefined ? {} : { idempotencyKey: key }),
    }),
  );

test("a handler's result is recorded; bad payloads and handler errors fail", async () => {
  const seen: Seen[] = [];
  const claimer = createClaimer({ db: t.db, clock, log });
  claimer.register(echo("t.echo", seen));
  const good = await insert("t.echo", { n: 21 });
  const bad = await insert("t.echo", { n: "x" });
  const refused = await insert("t.echo", { n: -1 });
  claimer.start();
  const done = await settled(good.id);
  expect(done).toMatchObject({ state: "done", result_json: '{"doubled":42}' });
  const invalid = await settled(bad.id);
  expect(invalid.state).toBe("failed");
  expect(JSON.parse(invalid.error ?? "")).toMatchObject({
    class: "validation",
  });
  const conflict = await settled(refused.id);
  await claimer.stop();
  expect(JSON.parse(conflict.error ?? "")).toMatchObject({
    class: "conflict",
    message: "negative",
  });
  // Commands inserted in one millisecond claim in id order, which a ULID leaves random.
  expect(seen.map((s) => s.n).toSorted()).toEqual([-1, 21]);
});

test("an unknown command type fails loudly with unknown_command", async () => {
  const claimer = createClaimer({ db: t.db, clock, log });
  const cmd = await insert("t.nobody-handles-this", {});
  claimer.start();
  const row = await settled(cmd.id);
  await claimer.stop();
  expect(row.state).toBe("failed");
  expect(JSON.parse(row.error ?? "")).toMatchObject({
    class: "unknown_command",
    retryable: false,
  });
  const logged = lines
    .map((l) => JSON.parse(l) as { level: number; command?: string })
    .find((l) => l.command === cmd.id);
  expect(logged?.level).toBe(50);
});

test("while wiring, a command with no handler yet waits; its handler's registration takes it; once wired, an unknown type fails", async () => {
  const seen: Seen[] = [];
  const claimer = createClaimer({ db: t.db, clock, log, wiring: true });
  const early = await insert("t.late", { n: 7 });
  const stray = await insert("t.never", {});
  claimer.start();
  await turns(20);
  expect(unwrap(await getCommand(t.db, early.id)).state).toBe("pending");
  expect(unwrap(await getCommand(t.db, stray.id)).state).toBe("pending");
  claimer.register(echo("t.late", seen));
  expect(await settled(early.id)).toMatchObject({
    state: "done",
    result_json: '{"doubled":14}',
  });
  expect(unwrap(await getCommand(t.db, stray.id)).state).toBe("pending");
  claimer.wired();
  expect(JSON.parse((await settled(stray.id)).error ?? "")).toMatchObject({
    class: "unknown_command",
  });
  await claimer.stop();
  expect(seen.map((s) => s.n)).toEqual([7]);
});

test("a repeated idempotency key is one command, handled once", async () => {
  const seen: Seen[] = [];
  const claimer = createClaimer({ db: t.db, clock, log });
  claimer.register(echo("t.idem", seen));
  const a = await insert("t.idem", { n: 1 }, "key-1");
  const b = await insert("t.idem", { n: 1 }, "key-1");
  expect(b).toEqual({ id: a.id, created: false });
  claimer.start();
  await settled(a.id);
  claimer.wake();
  await turns(20);
  await claimer.stop();
  expect(seen).toEqual([
    { n: 1, id: a.id, attempts: 1, idempotencyKey: "key-1" },
  ]);
});

test("two claimers on one database handle each command exactly once", async () => {
  const other = unwrap(await openDb({ path: t.path, clock }));
  const seen: Seen[] = [];
  const claimers = [
    createClaimer({ db: t.db, clock, log }),
    createClaimer({ db: other, clock, log }),
  ];
  for (const c of claimers) c.register(echo("t.race", seen));
  const ids = [];
  for (let n = 0; n < 20; n += 1) ids.push((await insert("t.race", { n })).id);
  for (const c of claimers) c.start();
  for (const id of ids) await settled(id);
  await Promise.all(claimers.map((c) => c.stop()));
  unwrap(await other.close());
  expect(seen.map((s) => s.id).toSorted()).toEqual(ids.toSorted());
});

test("a wake is picked up at once, the poll only after 1 s", async () => {
  const seen: Seen[] = [];
  const claimer = createClaimer({ db: t.db, clock, log });
  claimer.register(echo("t.wake", seen));
  claimer.start();
  await turns(20);
  const woken = await insert("t.wake", { n: 1 });
  await turns(20);
  expect(unwrap(await getCommand(t.db, woken.id)).state).toBe("pending");
  claimer.wake();
  expect((await settled(woken.id)).state).toBe("done");
  expect(clock.now()).toBe(T0);

  const polled = await insert("t.wake", { n: 2 });
  await clock.advance(999);
  await turns(20);
  expect(unwrap(await getCommand(t.db, polled.id)).state).toBe("pending");
  await clock.advance(1);
  expect((await settled(polled.id)).state).toBe("done");
  await claimer.stop();
});

test("stop waits for the command in flight", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const claimer = createClaimer({ db: t.db, clock, log });
  claimer.register({
    type: "t.slow",
    payload: z.object({}),
    idempotent: false,
    handle: async () => {
      await gate;
      return ok(null);
    },
  });
  const cmd = await insert("t.slow", {});
  claimer.start();
  await vi.waitFor(async () =>
    expect(unwrap(await getCommand(t.db, cmd.id)).state).toBe("claimed"),
  );
  let stopped = false;
  const stopping = claimer.stop().then(() => {
    stopped = true;
  });
  await turns(20);
  expect(stopped).toBe(false);
  release();
  await stopping;
  expect(unwrap(await getCommand(t.db, cmd.id)).state).toBe("done");
});

test("registering a type twice is an error at boot", () => {
  const claimer = createClaimer({ db: t.db, clock, log });
  claimer.register(echo("t.twice", []));
  expect(() => claimer.register(echo("t.twice", []))).toThrow(/t\.twice/);
});

test("a background handler runs off the loop: later commands are handled meanwhile, and stop waits for it", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: Seen[] = [];
  const claimer = createClaimer({ db: t.db, clock, log });
  claimer.register({
    type: "t.long",
    payload: z.object({}),
    idempotent: false,
    background: true,
    handle: async () => {
      await gate;
      return ok({ long: true });
    },
  });
  claimer.register(echo("t.quick", seen));
  const long = await insert("t.long", {});
  claimer.start();
  await vi.waitFor(async () =>
    expect(unwrap(await getCommand(t.db, long.id)).state).toBe("claimed"),
  );
  const quick = await insert("t.quick", { n: 2 });
  claimer.wake();
  expect((await settled(quick.id)).state).toBe("done");
  expect(unwrap(await getCommand(t.db, long.id)).state).toBe("claimed");
  let stopped = false;
  const stopping = claimer.stop().then(() => {
    stopped = true;
  });
  await turns(20);
  expect(stopped).toBe(false);
  release();
  await stopping;
  expect(unwrap(await getCommand(t.db, long.id))).toMatchObject({
    state: "done",
    result_json: '{"long":true}',
  });
});
