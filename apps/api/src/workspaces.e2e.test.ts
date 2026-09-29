// GET /workspaces: every workspace row, for the New ticket dialog's picker.
import { FakeClock, systemClock } from "@bayon/core";
import {
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import { WorkspacesView } from "@bayon/proto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dbStore } from "./db-store.js";
import { startApi, type RunningApi } from "./server.js";

const TOKEN = "e2e-workspaces-bearer-0123456789abcdef";

let t: TempDb;
let api: RunningApi;

beforeAll(async () => {
  t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(t.db, 8));
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        { id: "w-b", name: "b-workspace", kind: "single" },
        { id: "w-a", name: "a-workspace", kind: "multi" },
      ],
    }),
  );
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(t.db),
    clock: systemClock,
    logger: false,
  });
});

afterAll(async () => {
  await api.close();
  t.cleanup();
});

const call = (path: string, init: RequestInit = {}) =>
  fetch(`${api.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });

test("GET /workspaces: every row, ordered by name", async () => {
  const res = await call("/workspaces");
  expect(res.status).toBe(200);
  const { workspaces } = WorkspacesView.parse(await res.json());
  expect(workspaces).toEqual([
    { id: "w-a", name: "a-workspace", kind: "multi" },
    { id: "w-b", name: "b-workspace", kind: "single" },
  ]);
});
