import { FakeClock, ok } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  SPINE_SEED,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import {
  createSession,
  findLiveByAgent,
  findLiveByRunnerSessionId,
  getSession,
  listSessionsInStates,
  releaseExpiredLeases,
  updateSessionState,
} from "./sessions.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());
unwrap(await seedSpine(t.db, 2));

const create = async (runner_session_id: string | null = null) => {
  await clock.advance(1); // distinct created_at, so "oldest first" is decided by time
  return unwrap(
    await createSession(t.db, { ...newSessionInput(), runner_session_id }),
  ).id;
};
const end = async (id: string, to: "exited" | "resumable") =>
  unwrap(await updateSessionState(t.db, id, { from: ["pending"], to }));

test("listSessionsInStates filters by state, oldest first", async () => {
  const a = await create();
  const b = await create();
  const pending = unwrap(await listSessionsInStates(t.db, ["pending"]));
  expect(pending.map((s) => s.id)).toEqual([a, b]);
  const idle = unwrap(await listSessionsInStates(t.db, ["idle"]));
  expect(idle.map((s) => s.id)).toEqual([SPINE_SEED.sessionId]);
  expect(unwrap(await listSessionsInStates(t.db, []))).toEqual([]);
  await end(a, "exited");
  await end(b, "exited");
});

test("findLiveByRunnerSessionId skips exited and resumable sessions", async () => {
  const live = await create("rs-1");
  await end(await create("rs-1"), "exited");
  await end(await create("rs-1"), "resumable");
  const found = unwrap(await findLiveByRunnerSessionId(t.db, "rs-1"));
  expect(found.map((s) => s.id)).toEqual([live]);
  expect(unwrap(await findLiveByRunnerSessionId(t.db, "rs-none"))).toEqual([]);
});

test("findLiveByAgent skips exited and resumable sessions, and is empty for an unknown agent", async () => {
  const live = await create();
  await end(await create(), "exited");
  await end(await create(), "resumable");
  const found = unwrap(await findLiveByAgent(t.db, SPINE_SEED.agentId));
  expect(found.map((s) => s.id)).toContain(live);
  expect(
    found.every((s) => s.state !== "exited" && s.state !== "resumable"),
  ).toBe(true);
  expect(unwrap(await findLiveByAgent(t.db, "agent-none"))).toEqual([]);
});

test("releaseExpiredLeases clears expired attach leases and keeps live ones", async () => {
  const lease = async (expiresAt: number) => {
    const id = await create();
    unwrap(
      await updateSessionState(t.db, id, {
        from: ["pending"],
        to: "pending",
        patch: {
          attach_lease_owner: "operator",
          attach_lease_expires_at: expiresAt,
        },
      }),
    );
    return id;
  };
  const expired = await lease(clock.now() - 1);
  const held = await lease(clock.now() + 60_000);
  expect(await releaseExpiredLeases(t.db)).toEqual(ok(1));
  expect(unwrap(await getSession(t.db, expired))).toMatchObject({
    attach_lease_owner: null,
    attach_lease_expires_at: null,
  });
  expect(unwrap(await getSession(t.db, held)).attach_lease_owner).toBe(
    "operator",
  );
  expect(await releaseExpiredLeases(t.db)).toEqual(ok(0));
});

test("releaseExpiredLeases never touches a human_attached session's lease", async () => {
  const id = await create();
  unwrap(
    await updateSessionState(t.db, id, {
      from: ["pending"],
      to: "human_attached",
      patch: {
        attach_lease_owner: "operator",
        attach_lease_expires_at: clock.now() - 1,
      },
    }),
  );
  expect(await releaseExpiredLeases(t.db)).toEqual(ok(0));
  expect(unwrap(await getSession(t.db, id))).toMatchObject({
    state: "human_attached",
    attach_lease_owner: "operator",
  });
});
