// GET /sessions/:id with context compression: the session's pinned ruleset, its saving
// and its runs' context totals summed from their terminals; a session never compressed has none.
import { FakeClock, systemClock } from "@bayon/core";
import { openDb, type Db } from "@bayon/db";
import {
  addSession,
  appendTerminalForTest,
  seedSpine,
  tempDb,
  unwrap,
  updateRowForTest,
  type TempDb,
} from "@bayon/db/testing";
import { SessionView } from "@bayon/proto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dbStore } from "./db-store.js";
import { startApi, type RunningApi } from "./server.js";

const TOKEN = "e2e-ctx-bearer-0123456789abcdef";
const COMPRESSED = "01J0E2ECTXSESSION00000001";
const PLAIN = "01J0E2ECTXSESSION00000002";

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;

const totals = (failed: number) => ({
  ruleset: "ctx1",
  calls: 2,
  blocks: 3,
  compressed: 2,
  failed,
  chars_in: 40_000,
  chars_out: 4_000,
});

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 2));
  unwrap(await addSession(spine.db, COMPRESSED));
  unwrap(await addSession(spine.db, PLAIN));
  unwrap(
    await updateRowForTest(spine.db, "sessions", COMPRESSED, {
      context_ruleset: "ctx1",
      tokens_saved: 18_000,
    }),
  );
  unwrap(
    await appendTerminalForTest(spine.db, COMPRESSED, {
      outcome: "ok",
      context: totals(0),
    }),
  );
  unwrap(
    await appendTerminalForTest(spine.db, COMPRESSED, {
      outcome: "ok",
      context: totals(1),
    }),
  );
  // A terminal on a session that never compressed carries nothing to read.
  unwrap(await appendTerminalForTest(spine.db, PLAIN, { outcome: "ok" }));
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

const session = async (id: string): Promise<SessionView> => {
  const res = await fetch(`${api.url}/sessions/${id}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
  return SessionView.parse(await res.json());
};

test("a compressed session: its ruleset, its saving, and its runs' totals summed", async () => {
  expect(await session(COMPRESSED)).toMatchObject({
    context_ruleset: "ctx1",
    tokens_saved: 18_000,
    context: {
      ruleset: "ctx1",
      runs: 2,
      calls: 4,
      blocks: 6,
      compressed: 4,
      failed: 1,
      chars_in: 80_000,
      chars_out: 8_000,
    },
  });
});

test("a session never compressed: no ruleset, no saving, no totals", async () => {
  expect(await session(PLAIN)).toMatchObject({
    context_ruleset: null,
    tokens_saved: null,
    context: null,
  });
});
