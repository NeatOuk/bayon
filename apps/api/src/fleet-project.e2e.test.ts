// GET /fleet?project= and GET /inbox?kind=&project= over HTTP against a temp-file DB:
// the project IDE's live roster and its count of open staffing proposals.
import { FakeClock, STAFF_APPROVAL_KIND, systemClock } from "@bayon/core";
import { openDb, type Db } from "@bayon/db";
import {
  SPINE_SEED,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import { ApiErrorBody, Fleet, InboxPage } from "@bayon/proto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dbStore } from "./db-store.js";
import { startApi, type RunningApi } from "./server.js";

const TOKEN = "e2e-fleet-project-0123456789abcdef";

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;

const get = (path: string): Promise<Response> =>
  fetch(`${api.url}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });

const proposal = (id: string, ticket_id: string, asked_at: number) => ({
  id,
  kind: STAFF_APPROVAL_KIND,
  question: `Staff ${ticket_id}?`,
  context_md: null,
  options_json: null,
  batch_id: null,
  answer_json: null,
  answered_by: null,
  asked_at,
  answered_at: null,
  expires_at: null,
  dedupe_key: null,
  proposal_json: null,
  ticket_id,
  session_id: null,
});

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 3));
  unwrap(
    await seedRows(spine.db, {
      workspaces: [
        { id: "shop", name: "shop", kind: "single" },
        { id: "blog", name: "blog", kind: "single" },
      ],
      agents: [
        {
          id: "shop-builder",
          name: "shop-builder",
          kind: "builder",
          runner_id: SPINE_SEED.runnerId,
          workspace_id: "shop",
          created_at: 0,
        },
        {
          id: "blog-builder",
          name: "blog-builder",
          kind: "builder",
          runner_id: SPINE_SEED.runnerId,
          workspace_id: "blog",
          created_at: 0,
        },
      ],
      tickets: [
        ticketRow(4, { workspace_id: "shop" }),
        ticketRow(5, { workspace_id: "blog" }),
      ],
      sessions: [
        {
          ...newSessionInput(),
          id: "s-shop",
          agent_id: "shop-builder",
          ticket_id: "ticket-4",
          state: "running",
          created_at: 0,
        },
        {
          ...newSessionInput(),
          id: "s-blog",
          agent_id: "blog-builder",
          state: "running",
          created_at: 0,
        },
      ],
      human_requests: [
        proposal("p-shop", "ticket-4", 1),
        proposal("p-blog", "ticket-5", 2),
      ],
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

async function fleetOf(query: string): Promise<Fleet> {
  const res = await get(`/fleet${query}`);
  expect(res.status).toBe(200);
  return Fleet.parse(await res.json());
}

test("GET /fleet: every live session with its project and its ticket's key", async () => {
  const fleet = await fleetOf("");
  expect(
    fleet.sessions.map((s) => [s.id, s.workspace_id, s.ticket_key]),
  ).toEqual([
    ["s-blog", "blog", null],
    ["s-shop", "shop", "FRM-4"],
    [SPINE_SEED.sessionId, null, null],
  ]);
});

test("GET /fleet?project= keeps one project's sessions; the rest of the body stays fleet-wide", async () => {
  const all = await fleetOf("");
  const shop = await fleetOf("?project=shop");
  expect(shop.sessions.map((s) => s.id)).toEqual(["s-shop"]);
  expect(shop.slots).toEqual(all.slots);
  expect(shop.budget).toEqual(all.budget);
  expect((await fleetOf("?project=nowhere")).sessions).toEqual([]);
});

test("GET /fleet?project= with no value is 400", async () => {
  const res = await get("/fleet?project=");
  expect(res.status).toBe(400);
  expect(ApiErrorBody.parse(await res.json()).error.class).toBe("validation");
});

test("GET /inbox?kind=staff_approval&project= is one project's open staffing proposals", async () => {
  const res = await get(
    `/inbox?status=open&kind=${STAFF_APPROVAL_KIND}&project=shop&limit=100`,
  );
  expect(res.status).toBe(200);
  const page = InboxPage.parse(await res.json());
  expect(page.items.map((item) => item.id)).toEqual(["p-shop"]);
  expect(page.has_more).toBe(false);
});
