// POST /executors over HTTP against a temp-file DB (§9.5 amendment).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, systemClock } from "@bayon/core";
import { listExecutors, openDb, type Db } from "@bayon/db";
import { tempDb, unwrap, type TempDb } from "@bayon/db/testing";
import {
  ApiErrorBody,
  AuditPage,
  ExecutorCreated,
  type CreateExecutorRequest,
} from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dbStore } from "../db-store.js";
import { startApi, type RunningApi } from "../server.js";
import { ExecutorsCreateService } from "./executors-create-service.js";

const TOKEN = "e2e-executors-0123456789abcdef";

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;
const dir = mkdtempSync(join(tmpdir(), "executors-e2e-"));
const frmHome = join(dir, "home");

// A real key line, so ssh-keygen -F reads the file as it would the operator's — the same fixture
// shape as host-key.test.ts.
execFileSync("ssh-keygen", [
  "-q",
  "-t",
  "ed25519",
  "-N",
  "",
  "-f",
  join(dir, "k"),
]);
const pub = readFileSync(join(dir, "k.pub"), "utf8")
  .split(" ")
  .slice(0, 2)
  .join(" ");
const PINNED_HOST = "192.0.2.10";
const operatorKnownHosts = join(dir, "known_hosts");
writeFileSync(operatorKnownHosts, `${PINNED_HOST} ${pub}\n`);

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    logger: false,
    executorsCreate: new ExecutorsCreateService({
      db: apiDb,
      clock: systemClock,
      frmHome,
      // Never wire-settable (security review): a test fixture, configured only at
      // construction, standing in for the real ~/.ssh/known_hosts.
      knownHostsPath: operatorKnownHosts,
    }),
  });
});

afterAll(async () => {
  await api?.close();
  await apiDb?.close();
  spine?.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const call = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${api.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function expectError(res: Response, status: number, errorClass: string) {
  expect(res.status).toBe(status);
  const body = ApiErrorBody.parse(await res.json());
  expect(body.error.class).toBe(errorClass);
  return body.error;
}

const REQUEST: CreateExecutorRequest = {
  id: "ctr-e2e1",
  host: PINNED_HOST,
  user: "ops",
  identity_ref: "file:/keys/id_ed25519",
  remote_root: "/home/ops/frm",
  slots: 2,
};

test("POST /executors needs the operator's bearer", async () => {
  const res = await fetch(`${api.url}/executors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(REQUEST),
  });
  expect(res.status).toBe(401);
});

describe("each refusal is 400 and writes nothing", () => {
  test.each([
    ["a bad id", { ...REQUEST, id: "Not Valid" }],
    ["a bad host", { ...REQUEST, id: "e2e-refused-1", host: "" }],
    [
      "a bad identity_ref (no scheme)",
      { ...REQUEST, id: "e2e-refused-2", identity_ref: "/keys/id" },
    ],
    [
      "a relative remote_root",
      { ...REQUEST, id: "e2e-refused-3", remote_root: "relative/path" },
    ],
    [
      "a host not in known_hosts",
      { ...REQUEST, id: "e2e-refused-4", host: "10.9.9.9" },
    ],
  ])("%s", async (_label, body) => {
    const countBefore = unwrap(await listExecutors(apiDb)).length;
    const res = await call("POST", "/executors", body);
    const error = await expectError(res, 400, "validation");
    if (_label === "a host not in known_hosts") {
      expect(error.message).toContain("frm never scans host keys");
    }
    expect(unwrap(await listExecutors(apiDb))).toHaveLength(countBefore);
  });
});

test("happy path is 201 with the documented shape; a repeat id is 409; the audit row appears", async () => {
  const res = await call("POST", "/executors", REQUEST);
  expect(res.status).toBe(201);
  const created = ExecutorCreated.parse(await res.json());
  expect(created).toEqual({
    id: "ctr-e2e1",
    host: PINNED_HOST,
    known_hosts_entries_copied: 1,
  });

  const pinnedPath = join(frmHome, "executors", "ctr-e2e1", "known_hosts");
  expect(readFileSync(pinnedPath, "utf8")).toBe(`${PINNED_HOST} ${pub}\n`);

  const repeat = await call("POST", "/executors", REQUEST);
  await expectError(repeat, 409, "conflict");

  const audit = await call("GET", "/audit?action=executor.create");
  expect(audit.status).toBe(200);
  const page = AuditPage.parse(await audit.json());
  const entry = page.items.find((e) => e.target_id === "ctr-e2e1");
  expect(entry).toMatchObject({
    actor: "operator",
    action: "executor.create",
    target_kind: "executor",
    target_id: "ctr-e2e1",
  });
  expect(entry?.payload).toEqual({
    via: "rest",
    host: PINNED_HOST,
    user: "ops",
    network: "frm-internal",
    slots: 2,
  });
  // Never a hint of key location in the audit trail.
  expect(JSON.stringify(entry?.payload ?? {})).not.toContain("identity_ref");
});

test("two concurrent creates for the same new id: exactly one succeeds, the other is refused (security review)", async () => {
  const body = { ...REQUEST, id: "ctr-e2e-race" };
  const [a, b] = await Promise.all([
    call("POST", "/executors", body),
    call("POST", "/executors", body),
  ]);
  const statuses = [a.status, b.status].toSorted();
  expect(statuses).toEqual([201, 409]);
  const winner = a.status === 201 ? a : b;
  const created = ExecutorCreated.parse(await winner.json());
  expect(created.id).toBe("ctr-e2e-race");
  // The surviving row's pinned key matches the host it actually names — no mismatch left behind.
  const pinnedPath = join(frmHome, "executors", "ctr-e2e-race", "known_hosts");
  expect(readFileSync(pinnedPath, "utf8")).toBe(`${PINNED_HOST} ${pub}\n`);
});
