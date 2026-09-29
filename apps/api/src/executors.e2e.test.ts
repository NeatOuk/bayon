// GET /executors and POST /executors/:id/health over HTTP: each row as the supervisor
// keeps it, and one executor.health command per request.
import { FakeClock, systemClock } from "@bayon/core";
import {
  SPINE_SEED,
  listCommands,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  ApiErrorBody,
  ExecutorHealthAccepted,
  ExecutorsView,
  IDEMPOTENCY_HEADER,
} from "@bayon/proto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dbStore } from "./db-store.js";
import { startApi, type RunningApi } from "./server.js";

const TOKEN = "e2e-executors-bearer-0123456789abcdef";
const CONFIG = {
  ssh: {
    host: "192.0.2.10",
    user: "ops",
    identity_ref: "file:/keys/id_ed25519",
  },
  remote_root: "/home/ops/frm",
  image: "frm-ctr-lab:0123456789ab",
  network: "frm-internal",
};
const DETAIL = { rttMs: 312, failures: ["disk: 12 % free"] };

let t: TempDb;
let api: RunningApi;

beforeAll(async () => {
  t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(t.db, 8));
  unwrap(
    await seedRows(t.db, {
      executors: [
        {
          id: "ctr-lab",
          kind: "container",
          config_json: JSON.stringify(CONFIG),
          slots: 2,
          trust: "untrusted",
          egress_policy: "allowlist",
          health: "unhealthy",
          health_checked_at: 7,
          health_detail: JSON.stringify(DETAIL),
        },
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

const health = (id: string, key?: string) =>
  call(`/executors/${id}/health`, {
    method: "POST",
    headers: key === undefined ? {} : { [IDEMPOTENCY_HEADER]: key },
  });

test("GET /executors: every row, its last health detail and its config parsed, and the untrusted roles", async () => {
  const res = await call("/executors");
  expect(res.status).toBe(200);
  const { executors, untrusted_roles } = ExecutorsView.parse(await res.json());
  expect(untrusted_roles).toEqual(["investigator"]);
  expect(executors.map((e) => e.id).toSorted()).toEqual(
    ["ctr-lab", SPINE_SEED.executorId].toSorted(),
  );
  expect(executors.find((e) => e.id === "ctr-lab")).toEqual({
    id: "ctr-lab",
    kind: "container",
    trust: "untrusted",
    egress_policy: "allowlist",
    slots: 2,
    enabled: true,
    health: "unhealthy",
    health_checked_at: 7,
    health_detail: DETAIL,
    config: CONFIG,
  });
  expect(executors.find((e) => e.id === SPINE_SEED.executorId)).toMatchObject({
    kind: "local",
    health_detail: null,
  });
});

test("POST /executors/:id/health inserts one executor.health; a repeated key answers the first", async () => {
  const res = await health("ctr-lab", "health-1");
  expect(res.status).toBe(202);
  const accepted = ExecutorHealthAccepted.parse(await res.json());
  expect(accepted.created).toBe(true);
  const again = ExecutorHealthAccepted.parse(
    await (await health("ctr-lab", "health-1")).json(),
  );
  expect(again).toEqual({ command_id: accepted.command_id, created: false });
  const commands = unwrap(await listCommands(t.db)).filter(
    (c) => c.type === "executor.health",
  );
  expect(commands).toHaveLength(1);
  expect(JSON.parse(commands[0]?.payload_json ?? "null")).toEqual({
    executor_id: "ctr-lab",
  });
});

test("an unknown executor is 404 and inserts nothing", async () => {
  const before = unwrap(await listCommands(t.db)).length;
  const res = await health("no-such-executor");
  expect(res.status).toBe(404);
  expect(ApiErrorBody.parse(await res.json())).toMatchObject({
    error: { class: "not_found" },
  });
  expect(unwrap(await listCommands(t.db))).toHaveLength(before);
});
