import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  SPINE_SEED,
  addSession,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import { getSession, repinPendingSession } from "./sessions.js";

// repinPendingSession: a re-admission re-pins a pending session's inputs, never
// another state's, and never its identity.
const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
afterAll(() => t.cleanup());
unwrap(await seedSpine(t.db, 13));

const PINS = {
  config_hash: "c".repeat(64),
  toolset_hash: "t".repeat(64),
  model: "model-2",
  model_tier: "cheap",
  effort: null,
  mission_hash: null,
  context_ruleset: "ctx1",
} as const;

test("a pending session takes the new pins; its identity stays", async () => {
  const before = unwrap(await addSession(t.db, "p-1"));
  const after = unwrap(await repinPendingSession(t.db, "p-1", PINS));
  expect(after).toMatchObject({ ...PINS, state: "pending" });
  expect(after).toMatchObject({
    runner_id: before.runner_id,
    executor_id: before.executor_id,
    workspace_id: before.workspace_id,
  });
});

test("a session in any other state is a conflict, and keeps its pins", async () => {
  const idle = unwrap(await getSession(t.db, SPINE_SEED.sessionId));
  expect(
    await repinPendingSession(t.db, SPINE_SEED.sessionId, PINS),
  ).toMatchObject({ ok: false, error: { class: "conflict" } });
  expect(unwrap(await getSession(t.db, SPINE_SEED.sessionId))).toEqual(idle);
});
