import { FakeClock, ok, type ExitReason, type SessionState } from "@bayon/core";
import type { Compilable } from "kysely";
import { afterAll, expect, test } from "vitest";
import { all, execute, qb, read, write, type Db } from "../connection.js";
import { newSessionInput, seedSpine, tempDb, unwrap } from "../testing.js";
import { ackAttention } from "./attention-ack.js";
import { getFleetOverview } from "./fleet-overview.js";
import { createSession } from "./sessions.js";

// dismissing a finished session's error from the attention strip. What matters is that
// the dismissal is recorded with its actor, that the strip then stays clear, and that a *live*
// condition cannot be dismissed — hiding one would be a worse dead end than the one this fixes.

const NOW = Date.UTC(2026, 8, 13, 10);
const HOUR = 60 * 60_000;

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function fresh(): Promise<Db> {
  const t = unwrap(await tempDb(new FakeClock(NOW)));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 2));
  return t.db;
}

const exec = async (db: Db, query: Compilable<unknown>) =>
  unwrap(
    await write(db, (ix) => {
      execute(ix, query);
      return ok(undefined);
    }),
  );

async function session(
  db: Db,
  id: string,
  set: {
    readonly state: SessionState;
    readonly last_event_at?: number;
    readonly ended_at?: number;
    readonly exit_reason?: ExitReason;
    readonly error_message?: string;
  },
): Promise<void> {
  unwrap(await createSession(db, { ...newSessionInput(), id }));
  await exec(db, qb.updateTable("sessions").set(set).where("id", "=", id));
}

const errored = (id: string) =>
  ({
    state: "exited" as const,
    ended_at: NOW - HOUR,
    exit_reason: "error" as const,
    error_message: `${id} broke`,
  }) as const;

const auditActions = async (db: Db): Promise<string[]> => {
  const got = await read(db, (ix) =>
    all(ix, qb.selectFrom("audit_log").select(["action", "actor"])),
  );
  return unwrap(got).map((r) => `${r.actor}:${r.action}`);
};

const attentionIds = async (db: Db): Promise<string[]> =>
  unwrap(await getFleetOverview(db)).attention.map((a) => a.session_id);

test("dismissing an error exit clears it from the strip and records who did it", async () => {
  const db = await fresh();
  await session(db, "crashed", errored("crashed"));
  expect(await attentionIds(db)).toContain("crashed");

  const acked = unwrap(await ackAttention(db, "crashed", "operator"));
  expect(acked).toEqual({
    session_id: "crashed",
    acked_at: NOW,
    acked_by: "operator",
  });
  expect(await attentionIds(db)).not.toContain("crashed");
  expect(await auditActions(db)).toContain("operator:attention.ack");
});

test("it stays gone: a later read does not bring a dismissed error back", async () => {
  const db = await fresh();
  await session(db, "crashed", errored("crashed"));
  await session(db, "other", errored("other"));
  unwrap(await ackAttention(db, "crashed", "operator"));

  // Only the dismissed one goes; the rest of the strip is untouched.
  expect(await attentionIds(db)).toEqual(["other"]);
  expect(await attentionIds(db)).toEqual(["other"]);
});

test("dismissing twice keeps the first acknowledgement and does not fail", async () => {
  const db = await fresh();
  await session(db, "crashed", errored("crashed"));
  const first = unwrap(await ackAttention(db, "crashed", "operator"));
  const again = unwrap(await ackAttention(db, "crashed", "someone-else"));
  // The acknowledgement that happened is the first one; a retried click must not rewrite it.
  expect(again).toEqual(first);
  expect(again.acked_by).toBe("operator");
});

test("a live stale session cannot be dismissed: its remedy is real, so hiding it would lie", async () => {
  const db = await fresh();
  await session(db, "stale", { state: "idle", last_event_at: NOW - 10 * HOUR });
  expect(await attentionIds(db)).toContain("stale");

  const refused = await ackAttention(db, "stale", "operator");
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("a live session must not be dismissible");
  expect(refused.error.class).toBe("conflict");
  expect(refused.error.message).toContain("only a finished session's error");
  expect(await attentionIds(db)).toContain("stale");
  expect(await auditActions(db)).not.toContain("operator:attention.ack");
});

test("a clean exit cannot be dismissed either: it was never on the strip", async () => {
  const db = await fresh();
  await session(db, "clean", {
    state: "exited",
    ended_at: NOW - HOUR,
    exit_reason: "ok",
  });
  const refused = await ackAttention(db, "clean", "operator");
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("a clean exit must not be dismissible");
  expect(refused.error.class).toBe("conflict");
});

test("an unknown session is not_found, and an actorless dismissal is refused", async () => {
  const db = await fresh();
  const missing = await ackAttention(db, "nobody", "operator");
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.class).toBe("not_found");

  await session(db, "crashed", errored("crashed"));
  const anonymous = await ackAttention(db, "crashed", "  ");
  expect(anonymous.ok).toBe(false);
  if (!anonymous.ok) expect(anonymous.error.class).toBe("validation");
  // Refused means refused: the error is still on the strip.
  expect(await attentionIds(db)).toContain("crashed");
});
