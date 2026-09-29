import { FakeClock, systemClock } from "@bayon/core";
import { openDb, type Db } from "@bayon/db";
import {
  addSession,
  listCommands,
  seedSpine,
  tempDb,
  unwrap,
  updateRowForTest,
  type TempDb,
} from "@bayon/db/testing";
import {
  ApiErrorBody,
  CommandAccepted,
  IDEMPOTENCY_HEADER,
  SessionView,
} from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dbStore } from "./db-store.js";
import { startApi, type RunningApi } from "./server.js";

// POST /sessions/:id/attach's `when`: stored on the session.attach command as asked,
// `now` when the body says nothing, 400 for anything else; and a session's pending takeover is
// visible on GET /sessions/:id.
const TOKEN = "e2e-bearer-attach-0123456789";
const SESSION = "01J0E2EATTACH0000000000001";
const PENDING = "01J0E2EATTACH0000000000002";
const AT = 1_700_000_000_123;

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 2));
  unwrap(await addSession(spine.db, SESSION));
  unwrap(await addSession(spine.db, PENDING));
  // The supervisor's write, arranged: a takeover pending on a running session.
  unwrap(
    await updateRowForTest(spine.db, "sessions", PENDING, {
      state: "running",
      attach_intent_owner: "tab-1",
      attach_intent_at: AT,
    }),
  );
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    logger: false,
  });
});

afterAll(async () => {
  await api?.close();
  await apiDb?.close();
  spine?.cleanup();
});

function call(
  path: string,
  init: { method?: string; body?: unknown; key?: string } = {},
): Promise<Response> {
  return fetch(`${api.url}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(init.key === undefined ? {} : { [IDEMPOTENCY_HEADER]: init.key }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function storedPayload(commandId: string): Promise<unknown> {
  const row = unwrap(await listCommands(spine.db)).find(
    (c) => c.id === commandId,
  );
  if (row === undefined) throw new Error(`no command ${commandId}`);
  expect(row.type).toBe("session.attach");
  return JSON.parse(row.payload_json);
}

const attach = async (body?: unknown, key?: string) => {
  const res = await call(`/sessions/${SESSION}/attach`, {
    method: "POST",
    body,
    key,
  });
  expect(res.status).toBe(202);
  return CommandAccepted.parse(await res.json());
};

describe("POST /sessions/:id/attach `when`", () => {
  test("turn_end round-trips onto the stored command, with its client token", async () => {
    const accepted = await attach({ client_token: "tab-9", when: "turn_end" });
    expect(await storedPayload(accepted.command_id)).toEqual({
      session_id: SESSION,
      client_token: "tab-9",
      when: "turn_end",
    });
  });

  test("no body, or no `when`, is `now`: an attach stops the agent where it is, as before", async () => {
    expect(await storedPayload((await attach()).command_id)).toEqual({
      session_id: SESSION,
      when: "now",
    });
    expect(
      await storedPayload(
        (await attach({ client_token: "tab-2" }, "attach-now")).command_id,
      ),
    ).toEqual({ session_id: SESSION, client_token: "tab-2", when: "now" });
    expect(
      await storedPayload((await attach({ when: "now" })).command_id),
    ).toEqual({ session_id: SESSION, when: "now" });
  });

  test("any other `when`, or an unknown key, is a 400 and inserts nothing", async () => {
    const before = unwrap(await listCommands(spine.db)).length;
    for (const body of [
      { when: "later" },
      { when: 1 },
      { when: "turn_end", after: "this step" },
    ]) {
      const res = await call(`/sessions/${SESSION}/attach`, {
        method: "POST",
        body,
      });
      expect(res.status).toBe(400);
      expect(ApiErrorBody.parse(await res.json()).error.class).toBe(
        "validation",
      );
    }
    expect(unwrap(await listCommands(spine.db))).toHaveLength(before);
  });
});

test("GET /sessions/:id carries a pending takeover, and none on a session without one", async () => {
  const pending = SessionView.parse(
    await (await call(`/sessions/${PENDING}`)).json(),
  );
  expect(pending).toMatchObject({
    state: "running",
    attach_intent_owner: "tab-1",
    attach_intent_at: AT,
  });
  const plain = SessionView.parse(
    await (await call(`/sessions/${SESSION}`)).json(),
  );
  expect(plain).toMatchObject({
    attach_intent_owner: null,
    attach_intent_at: null,
  });
});
