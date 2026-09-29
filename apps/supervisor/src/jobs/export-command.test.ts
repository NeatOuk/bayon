import { FakeClock, err, ok, type Result } from "@bayon/core";
import { createSession } from "@bayon/db/supervisor";
import {
  SPINE_SEED,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "@bayon/db/testing";
import { afterAll, expect, test } from "vitest";
import { exportRunHandler } from "./export-command.js";

const t = unwrap(await tempDb(new FakeClock(0)));
afterAll(() => t.cleanup());
unwrap(await seedSpine(t.db, 2)); // one live session for SPINE_SEED.agentId

const AGENT = SPINE_SEED.agentId;
let spawnCalls = 0;
const spawnFresh = async (): Promise<Result<string>> => {
  spawnCalls += 1;
  const session = unwrap(await createSession(t.db, newSessionInput()));
  return ok(session.id);
};

test("registers as export.run with an empty-object payload schema", () => {
  const handler = exportRunHandler({
    db: t.db,
    agentId: AGENT,
    spawn: spawnFresh,
  });
  expect(handler.type).toBe("export.run");
  expect(handler.payload.safeParse({}).success).toBe(true);
});

test("the exporter spawns once: reuses the seeded live session on the first call", async () => {
  const before = spawnCalls;
  const handler = exportRunHandler({
    db: t.db,
    agentId: AGENT,
    spawn: spawnFresh,
  });
  const result = await handler.handle({}, { id: "cmd-1", attempts: 1 });
  expect(result).toEqual(ok({ session_id: SPINE_SEED.sessionId }));
  expect(spawnCalls).toBe(before); // reused, never called spawn
});

test("a second call while one is live returns the same session, still no new spawn", async () => {
  const handler = exportRunHandler({
    db: t.db,
    agentId: AGENT,
    spawn: spawnFresh,
  });
  const first = unwrap(await handler.handle({}, { id: "cmd-2", attempts: 1 }));
  const before = spawnCalls;
  const second = unwrap(await handler.handle({}, { id: "cmd-3", attempts: 1 }));
  expect(second).toEqual(first);
  expect(spawnCalls).toBe(before);
});

test("propagates a spawn failure", async () => {
  const failing = () =>
    Promise.resolve(
      err({ class: "internal" as const, message: "boom", retryable: false }),
    );
  const handler = exportRunHandler({
    db: t.db,
    agentId: "agent-with-no-live-session",
    spawn: failing,
  });
  expect(await handler.handle({}, { id: "cmd-4", attempts: 1 })).toMatchObject({
    ok: false,
    error: { message: "boom" },
  });
});
