// Design an earlier change §3 and §6: the API finds a live session by its token hash (it never writes
// sessions); the supervisor re-mints on adopt; every MCP write attempt leaves an audit_log row.
import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf } from "../connection.js";
import { newSessionInput, seedSpine, tempDb, unwrap } from "../testing.js";
import { appendAudit } from "./audit.js";
import {
  createSession,
  findLiveSessionByTokenHash,
  setSessionTokenHash,
  updateSessionState,
} from "./sessions.js";

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 2));
afterAll(() => t.cleanup());

const hash = (c: string) => c.repeat(64);
let n = 0;
const session = async (tokenHash: string) =>
  unwrap(
    await createSession(t.db, {
      ...newSessionInput(),
      id: `mcp-auth-${++n}`,
      mcp_token_hash: tokenHash,
    }),
  );

test("findLiveSessionByTokenHash finds the live session holding the hash, and nothing else", async () => {
  const s = await session(hash("a"));
  expect(unwrap(await findLiveSessionByTokenHash(t.db, hash("a")))?.id).toBe(
    s.id,
  );
  expect(unwrap(await findLiveSessionByTokenHash(t.db, hash("f")))).toBeNull();
});

test("an ended session's token finds nothing: revocation needs no extra step", async () => {
  for (const [c, to] of [
    ["b", "exited"],
    ["c", "resumable"],
    ["d", "handed_off"],
  ] as const) {
    const s = await session(hash(c));
    unwrap(await updateSessionState(t.db, s.id, { from: ["pending"], to }));
    expect(unwrap(await findLiveSessionByTokenHash(t.db, hash(c)))).toBeNull();
  }
});

test("setSessionTokenHash replaces the hash: the old token dies, the new one finds the session", async () => {
  const s = await session(hash("1"));
  unwrap(await setSessionTokenHash(t.db, s.id, hash("2")));
  expect(unwrap(await findLiveSessionByTokenHash(t.db, hash("1")))).toBeNull();
  expect(unwrap(await findLiveSessionByTokenHash(t.db, hash("2")))?.id).toBe(
    s.id,
  );
});

test("setSessionTokenHash refuses an ended or unknown session, and a hash that is not sha-256 hex", async () => {
  const s = await session(hash("3"));
  unwrap(
    await updateSessionState(t.db, s.id, { from: ["pending"], to: "exited" }),
  );
  expect(await setSessionTokenHash(t.db, s.id, hash("4"))).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
  expect(await setSessionTokenHash(t.db, "nope", hash("4"))).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
  expect(await setSessionTokenHash(t.db, s.id, "plaintext")).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("appendAudit writes one row stamped now, its payload as JSON", async () => {
  const { id } = unwrap(
    await appendAudit(t.db, {
      actor: "session:s1",
      action: "mcp.human_ask",
      target_kind: "ticket",
      target_id: "T1",
      payload: { args_sha256: hash("e"), bytes: 42, outcome: "ok" },
    }),
  );
  const raw = unwrap(internalsOf(t.db)).raw;
  expect(raw.prepare("SELECT * FROM audit_log WHERE id = ?").get(id)).toEqual({
    id,
    ts: clock.now(),
    actor: "session:s1",
    action: "mcp.human_ask",
    target_kind: "ticket",
    target_id: "T1",
    payload_json: `{"args_sha256":"${hash("e")}","bytes":42,"outcome":"ok"}`,
    ip: null,
    // Neither ticket T1 nor session s1 exists here: nothing names a project.
    workspace_id: null,
  });
});

test("appendAudit refuses an empty actor or action", async () => {
  for (const bad of [
    { actor: "", action: "mcp.x" },
    { actor: "session:s1", action: "" },
  ]) {
    expect(await appendAudit(t.db, bad)).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  }
});
