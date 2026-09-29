import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { newSessionInput, seedSpine, tempDb, unwrap } from "../testing.js";
import { getFleet } from "./fleet.js";
import {
  createSession,
  getSession,
  listLiveSessions,
  updateSessionState,
} from "./sessions.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 2));
afterAll(() => t.cleanup());

test("createSession inserts a pending session stamped by the clock", async () => {
  const session = unwrap(await createSession(t.db, newSessionInput()));
  expect(session).toMatchObject({
    state: "pending",
    created_at: T0,
    turns: 0,
    tool_calls: 0,
    cost_usd: 0,
    raw_segment_offset: null,
  });
  expect(session.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // a ULID
  expect(unwrap(await getSession(t.db, session.id))).toEqual(session);
});

test("createSession keeps a caller-minted id", async () => {
  const session = unwrap(
    await createSession(t.db, { ...newSessionInput(), id: "minted-by-api" }),
  );
  expect(session.id).toBe("minted-by-api");
  expect(
    await createSession(t.db, { ...newSessionInput(), id: "minted-by-api" }),
  ).toMatchObject({ ok: false, error: { class: "conflict" } });
});

test("updateSessionState moves from an allowed state and applies the patch", async () => {
  const session = unwrap(await createSession(t.db, newSessionInput()));
  const moved = unwrap(
    await updateSessionState(t.db, session.id, {
      from: ["pending", "preparing"],
      to: "spawning",
      patch: { raw_segment_offset: 0, executor_ref: "local:1:2" },
    }),
  );
  expect(moved).toMatchObject({
    state: "spawning",
    raw_segment_offset: 0,
    executor_ref: "local:1:2",
  });
});

test("the lifecycle sets raw_segment_offset through the CAS patch at each new process", async () => {
  const session = unwrap(await createSession(t.db, newSessionInput()));
  const first = unwrap(
    await updateSessionState(t.db, session.id, {
      from: ["pending"],
      to: "spawning",
      patch: { raw_segment_offset: 0 },
    }),
  );
  expect(first.raw_segment_offset).toBe(0);
  // An adopt after a restart starts a new segment where the raw log ended.
  const adopted = unwrap(
    await updateSessionState(t.db, session.id, {
      from: ["spawning"],
      to: "idle",
      patch: { raw_segment_offset: 81_920 },
    }),
  );
  expect(adopted).toMatchObject({ state: "idle", raw_segment_offset: 81_920 });
});

test("a CAS miss is a conflict when the session exists, not_found when it does not", async () => {
  const session = unwrap(await createSession(t.db, newSessionInput()));
  const conflict = await updateSessionState(t.db, session.id, {
    from: ["running"],
    to: "idle",
  });
  expect(conflict).toMatchObject({ ok: false, error: { class: "conflict" } });
  if (conflict.ok) throw new Error("expected a conflict");
  expect(conflict.error.message).toContain("pending");
  expect(unwrap(await getSession(t.db, session.id)).state).toBe("pending");

  expect(
    await updateSessionState(t.db, "no-such-session", {
      from: ["pending"],
      to: "idle",
    }),
  ).toMatchObject({ ok: false, error: { class: "not_found" } });
});

test("an empty from list is a validation error", async () => {
  expect(
    await updateSessionState(t.db, "any", { from: [], to: "idle" }),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("getSession of an unknown id is not_found", async () => {
  expect(await getSession(t.db, "no-such-session")).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
});

test("listLiveSessions matches v_fleet's state predicate", async () => {
  const exited = unwrap(await createSession(t.db, newSessionInput()));
  unwrap(
    await updateSessionState(t.db, exited.id, {
      from: ["pending"],
      to: "exited",
      patch: { exit_reason: "ok", ended_at: clock.now() },
    }),
  );
  const live = unwrap(await listLiveSessions(t.db)).map((s) => s.id);
  expect(live).not.toContain(exited.id);
  expect(live.length).toBeGreaterThan(0);
  const fleet = unwrap(await getFleet(t.db)).map((row) => row.id);
  expect(fleet.toSorted()).toEqual(live.toSorted());
});
