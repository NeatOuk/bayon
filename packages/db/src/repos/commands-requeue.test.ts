import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { listAudit, tempDb, unwrap } from "../testing.js";
import {
  claimCommand,
  getCommand,
  insertCommand,
  requeueClaimedCommands,
  requeueOutcome,
  type RequeueClaimed,
} from "./commands.js";

// requeueClaimedCommands: claimed commands requeued or failed, audited.
const T0 = 1_700_000_000_000;
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function world() {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  return { db: t.db, clock };
}

const BOOT: Omit<RequeueClaimed, "exclude"> = {
  claimedBefore: Number.POSITIVE_INFINITY,
  idempotentTypes: ["t.idem"],
  knownTypes: ["t.idem", "t.once"],
  maxAttempts: 3,
  why: "the supervisor restarted while it ran",
};

type World = Awaited<ReturnType<typeof world>>;

/**
 * Inserts a command and claims it `claims` times, requeueing between claims. `keep`: commands set up
 * earlier and still claimed, which the requeues in between must not touch.
 */
async function claimed(
  w: World,
  type: string,
  claims = 1,
  keep: readonly string[] = [],
): Promise<string> {
  await w.clock.advance(1); // a later ts than the command before it: the (ts, id) order is fixed
  const { id } = unwrap(await insertCommand(w.db, { type, payload: {} }));
  for (let i = 0; i < claims; i += 1) {
    expect(unwrap(await claimCommand(w.db))?.id).toBe(id);
    if (i < claims - 1) {
      unwrap(await requeueClaimedCommands(w.db, { ...BOOT, exclude: keep }));
    }
  }
  return id;
}

const errorOf = async (w: World, id: string): Promise<unknown> =>
  JSON.parse(unwrap(await getCommand(w.db, id)).error ?? "null");

test("at boot an idempotent command is requeued with its attempts kept; the next claim counts one more", async () => {
  const w = await world();
  const id = await claimed(w, "t.idem");
  const out = unwrap(
    await requeueClaimedCommands(w.db, { ...BOOT, exclude: [] }),
  );
  expect(out).toEqual({ requeued: [id], failed: [] });
  expect(unwrap(await getCommand(w.db, id))).toMatchObject({
    state: "pending",
    claimed_at: null,
    attempts: 1,
  });
  expect(unwrap(await claimCommand(w.db))).toMatchObject({ id, attempts: 2 });
});

test("a command that is not idempotent is failed interrupted and retryable; an unregistered type fails unknown_command", async () => {
  const w = await world();
  const once = await claimed(w, "t.once");
  const unknown = await claimed(w, "t.gone");
  const out = unwrap(
    await requeueClaimedCommands(w.db, { ...BOOT, exclude: [] }),
  );
  expect(out).toEqual({ requeued: [], failed: [once, unknown] });
  expect(await errorOf(w, once)).toEqual({
    class: "interrupted",
    message:
      "the supervisor restarted while it ran; t.once is not idempotent, so it was not retried",
    retryable: true,
  });
  expect(await errorOf(w, unknown)).toMatchObject({
    class: "unknown_command",
    retryable: false,
  });
});

test("the claim that reaches command_max_attempts is failed, the one before it still requeued", async () => {
  const w = await world();
  const second = await claimed(w, "t.idem", 2);
  const third = await claimed(w, "t.idem", 3, [second]);
  const out = unwrap(
    await requeueClaimedCommands(w.db, { ...BOOT, exclude: [] }),
  );
  expect(out).toEqual({ requeued: [second], failed: [third] });
  expect(await errorOf(w, third)).toEqual({
    class: "interrupted",
    message: "claimed 3 times without completing",
    retryable: false,
    cause: { attempts: 3 },
  });
});

test("at runtime only rows claimed before the cut and not in flight are touched, with the runtime why", async () => {
  const w = await world();
  const old = await claimed(w, "t.once");
  const inFlight = await claimed(w, "t.idem");
  await w.clock.advance(10_000);
  const fresh = await claimed(w, "t.idem");
  const out = unwrap(
    await requeueClaimedCommands(w.db, {
      ...BOOT,
      claimedBefore: T0 + 5_000,
      exclude: [inFlight],
      why: "claimed for more than 5000 ms without completing",
    }),
  );
  expect(out).toEqual({ requeued: [], failed: [old] });
  expect(await errorOf(w, old)).toMatchObject({
    message:
      "claimed for more than 5000 ms without completing; t.once is not idempotent, so it was not retried",
  });
  for (const id of [inFlight, fresh]) {
    expect(unwrap(await getCommand(w.db, id)).state).toBe("claimed");
  }
});

test("each change leaves one supervisor audit row naming the command, its type and attempts", async () => {
  const w = await world();
  const idem = await claimed(w, "t.idem");
  const once = await claimed(w, "t.once");
  unwrap(await requeueClaimedCommands(w.db, { ...BOOT, exclude: [] }));
  const rows = unwrap(await listAudit(w.db)).filter((a) =>
    a.action.startsWith("command."),
  );
  expect(rows).toMatchObject([
    {
      actor: "supervisor",
      action: "command.requeued",
      target_kind: "command",
      target_id: idem,
    },
    {
      actor: "supervisor",
      action: "command.abandoned",
      target_kind: "command",
      target_id: once,
    },
  ]);
  expect(JSON.parse(rows[1]?.payload_json ?? "{}")).toEqual({
    type: "t.once",
    attempts: 1,
    class: "interrupted",
  });
});

test("pending and finished commands are never touched; bad options are refused", async () => {
  const w = await world();
  const { id } = unwrap(
    await insertCommand(w.db, { type: "t.idem", payload: {} }),
  );
  const out = unwrap(
    await requeueClaimedCommands(w.db, { ...BOOT, exclude: [] }),
  );
  expect(out).toEqual({ requeued: [], failed: [] });
  expect(unwrap(await getCommand(w.db, id)).state).toBe("pending");
  const zero = await requeueClaimedCommands(w.db, {
    ...BOOT,
    maxAttempts: 0,
    exclude: [],
  });
  expect(zero).toMatchObject({ ok: false, error: { class: "validation" } });
  const noWhy = await requeueClaimedCommands(w.db, {
    ...BOOT,
    why: " ",
    exclude: [],
  });
  expect(noWhy).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("requeueOutcome: unknown before idempotent before attempts", () => {
  const o = { ...BOOT };
  expect(requeueOutcome({ type: "t.gone", attempts: 9 }, o)).toMatchObject({
    error: { class: "unknown_command" },
  });
  expect(requeueOutcome({ type: "t.once", attempts: 9 }, o)).toMatchObject({
    error: { class: "interrupted", retryable: true },
  });
  expect(requeueOutcome({ type: "t.idem", attempts: null }, o)).toEqual({
    state: "pending",
  });
});
