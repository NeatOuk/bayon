import { FakeClock, type SessionState } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { newSessionInput, seedSpine, tempDb, unwrap } from "../testing.js";
import {
  clearAttachIntent,
  listAttachIntents,
  setAttachIntent,
} from "./attach.js";
import { createSession, getSession, updateSessionState } from "./sessions.js";

// A pending "take over after this step" (032): set only on a running session, cleared
// whatever the state, listed for the reconciler's sweep.
const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());
unwrap(await seedSpine(t.db, 2));

/** A fresh session moved straight from pending to `state` (the CAS checks the from-set only). */
async function sessionIn(state: SessionState): Promise<string> {
  const id = unwrap(await createSession(t.db, newSessionInput())).id;
  unwrap(await updateSessionState(t.db, id, { from: ["pending"], to: state }));
  return id;
}

const intentOf = async (id: string) => {
  const s = unwrap(await getSession(t.db, id));
  return { owner: s.attach_intent_owner, at: s.attach_intent_at };
};

test("setAttachIntent records the ask on a running session; the latest ask replaces the first", async () => {
  const id = await sessionIn("running");
  expect(await intentOf(id)).toEqual({ owner: null, at: null });
  expect(
    unwrap(await setAttachIntent(t.db, id, { owner: "tab-1", at: T0 })),
  ).toBe(true);
  expect(await intentOf(id)).toEqual({ owner: "tab-1", at: T0 });
  expect(
    unwrap(await setAttachIntent(t.db, id, { owner: "tab-2", at: T0 + 5 })),
  ).toBe(true);
  expect(await intentOf(id)).toEqual({ owner: "tab-2", at: T0 + 5 });
});

test("setAttachIntent refuses a session that is not running: its turn has already ended", async () => {
  for (const state of ["idle", "exited"] as const) {
    const id = await sessionIn(state);
    expect(
      unwrap(await setAttachIntent(t.db, id, { owner: "tab", at: T0 })),
    ).toBe(false);
    expect(await intentOf(id)).toEqual({ owner: null, at: null });
  }
  expect(
    unwrap(await setAttachIntent(t.db, "nope", { owner: "tab", at: T0 })),
  ).toBe(false);
});

test("clearAttachIntent clears in any state, and says whether there was one", async () => {
  const id = await sessionIn("running");
  unwrap(await setAttachIntent(t.db, id, { owner: "tab", at: T0 }));
  unwrap(await updateSessionState(t.db, id, { from: ["running"], to: "idle" }));
  expect(unwrap(await clearAttachIntent(t.db, id))).toBe(true);
  expect(await intentOf(id)).toEqual({ owner: null, at: null });
  expect(unwrap(await clearAttachIntent(t.db, id))).toBe(false);
});

test("listAttachIntents lists only the sessions with a pending ask, oldest ask first", async () => {
  for (const s of unwrap(await listAttachIntents(t.db))) {
    unwrap(await clearAttachIntent(t.db, s.id));
  }
  const later = await sessionIn("running");
  const earlier = await sessionIn("running");
  await sessionIn("running"); // no ask
  unwrap(await setAttachIntent(t.db, later, { owner: "b", at: T0 + 20 }));
  unwrap(await setAttachIntent(t.db, earlier, { owner: "a", at: T0 + 10 }));
  expect(unwrap(await listAttachIntents(t.db)).map((s) => s.id)).toEqual([
    earlier,
    later,
  ]);
});
