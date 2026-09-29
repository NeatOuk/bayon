import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf } from "./connection.js";
import { appendRun } from "./repos/runs.js";
import { createSession } from "./repos/sessions.js";
import { insertSpend } from "./repos/spend.js";
import {
  SPINE_SEED,
  newRunInput,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "./testing.js";

const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
unwrap(await seedSpine(t.db, 2));
afterAll(() => t.cleanup());
const { raw } = unwrap(internalsOf(t.db));

test("seed, session, run and spend rows insert with foreign_keys=ON", async () => {
  expect(raw.pragma("foreign_keys", { simple: true })).toBe(1);
  const session = unwrap(await createSession(t.db, newSessionInput()));
  const run = unwrap(await appendRun(t.db, newRunInput(session.id)));
  const spend = unwrap(
    await insertSpend(t.db, {
      run_id: run.id,
      session_id: session.id,
      phase: session.run_class,
      runner_id: SPINE_SEED.runnerId,
      model: "fixture-model",
      cost_usd: 0.25,
      cost_source: "reported",
    }),
  );
  expect(spend.created).toBe(true);
  expect(raw.pragma("foreign_key_check")).toEqual([]);
});

test("a session with an unknown agent_id is a validation error", async () => {
  const result = await createSession(t.db, {
    ...newSessionInput(),
    agent_id: "no-such-agent",
  });
  expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("the tickets ↔ sessions cycle: ticket, then session, then owner, in one transaction", () => {
  const insertSession = raw.prepare(
    `INSERT INTO sessions (id, agent_id, ticket_id, role, run_class, runner_id, executor_id,
       session_root, home_dir, config_hash, state, raw_log_path, mcp_token_hash, created_at)
     VALUES (?, ?, ?, 'builder', ?, ?, ?, '/r', '/h', 'c', 'pending', '/l', 'm', 1)`,
  );
  const session = (id: string, ticket: string) =>
    insertSession.run(
      id,
      SPINE_SEED.agentId,
      ticket,
      SPINE_SEED.runClass,
      SPINE_SEED.runnerId,
      SPINE_SEED.executorId,
    );
  // The session cannot come first: its ticket must exist.
  expect(() => session("s-early", "t-1")).toThrow(/FOREIGN KEY/);
  raw
    .transaction(() => {
      raw
        .prepare(
          `INSERT INTO tickets (id, num, title, type, status, origin, created_at, updated_at)
           VALUES ('t-1', 1, 'cycle', 'chore', 'new', 'test', 1, 1)`,
        )
        .run();
      session("s-1", "t-1");
      raw
        .prepare("UPDATE tickets SET owner_session_id = 's-1' WHERE id = 't-1'")
        .run();
    })
    .immediate();
  expect(raw.pragma("foreign_key_check")).toEqual([]);
  expect(() =>
    raw
      .prepare("UPDATE tickets SET owner_session_id = 'nope' WHERE id = 't-1'")
      .run(),
  ).toThrow(/FOREIGN KEY/);
});
