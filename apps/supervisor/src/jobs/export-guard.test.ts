import { FakeClock, err, ok, type Result } from "@bayon/core";
import { getSession } from "@bayon/db";
import { createSession, updateSessionState } from "@bayon/db/supervisor";
import {
  SPINE_SEED,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "@bayon/db/testing";
import { afterAll, expect, test } from "vitest";
import { spawnExportIfIdle } from "./export-guard.js";

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());
unwrap(await seedSpine(t.db, 2)); // includes one live (idle) session for SPINE_SEED.agentId

const AGENT = SPINE_SEED.agentId;
let created = 0;

const spawnFresh = async (): Promise<Result<string>> => {
  created += 1;
  const session = unwrap(await createSession(t.db, newSessionInput()));
  return ok(session.id);
};

test("a live session already exists (the seeded one): reused, spawn is never called", async () => {
  const before = created;
  const found = unwrap(
    await spawnExportIfIdle({ db: t.db, agentId: AGENT, spawn: spawnFresh }),
  );
  expect(found).toBe(SPINE_SEED.sessionId);
  expect(created).toBe(before);
});

test("no live session: spawns a fresh one", async () => {
  unwrap(
    await updateSessionState(t.db, SPINE_SEED.sessionId, {
      from: ["idle"],
      to: "exited",
    }),
  );
  const before = created;
  const result = await spawnExportIfIdle({
    db: t.db,
    agentId: AGENT,
    spawn: spawnFresh,
  });
  expect(result.ok).toBe(true);
  expect(created).toBe(before + 1);
});

test("that freshly spawned session is then the one reused, spawn stays at one call", async () => {
  const before = created;
  const first = unwrap(
    await spawnExportIfIdle({ db: t.db, agentId: AGENT, spawn: spawnFresh }),
  );
  const second = unwrap(
    await spawnExportIfIdle({ db: t.db, agentId: AGENT, spawn: spawnFresh }),
  );
  expect(second).toBe(first);
  expect(created).toBe(before);
});

test("propagates a spawn failure instead of swallowing it", async () => {
  const failing = () =>
    Promise.resolve(
      err({ class: "internal" as const, message: "boom", retryable: false }),
    );
  expect(
    await spawnExportIfIdle({
      db: t.db,
      agentId: "agent-with-no-live-session",
      spawn: failing,
    }),
  ).toMatchObject({ ok: false, error: { message: "boom" } });
});

test("concurrent triggers agree on one session id, even if both read no live session", async () => {
  const fixedId = "01FIXEDEXPORTGUARD";
  const idempotentSpawn = async (): Promise<Result<string>> => {
    const attempt = await createSession(t.db, {
      ...newSessionInput(),
      id: fixedId,
    });
    if (attempt.ok) return ok(fixedId);
    if (attempt.error.class !== "conflict") return attempt;
    const existing = await getSession(t.db, fixedId);
    return existing.ok ? ok(existing.value.id) : existing;
  };
  const [a, b] = await Promise.all([
    spawnExportIfIdle({
      db: t.db,
      agentId: "agent-for-race-test",
      spawn: idempotentSpawn,
    }),
    spawnExportIfIdle({
      db: t.db,
      agentId: "agent-for-race-test",
      spawn: idempotentSpawn,
    }),
  ]);
  expect(unwrap(a)).toBe(fixedId);
  expect(unwrap(b)).toBe(fixedId);
});
