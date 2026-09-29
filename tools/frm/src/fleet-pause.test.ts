// `frm pause|resume`: through the API when it answers; straight into the database when
// it does not (a real closed port, not a stub), audited as the operator's via frm; never behind the
// back of an API that answered with an error.
import { createServer } from "node:net";
import { dirname } from "node:path";
import { FLEET_PAUSED_KEY, FakeClock } from "@bayon/core";
import { getSettings } from "@bayon/db";
import { listAudit, tempDb, unwrap, type TempDb } from "@bayon/db/testing";
import { afterEach, expect, test } from "vitest";
import { parseCli } from "./cli.js";
import { parseFleetCli, runFleetCommand, type FleetIo } from "./fleet-pause.js";
import type { Fetch } from "./smoke/api-client.js";

const TOKEN = "frm-pause-test-bearer";
const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

async function db(): Promise<TempDb> {
  const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  opened.push(t);
  return t;
}

/** A port nothing listens on: bound, then closed. */
const closedPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

function rig(env: FleetIo["env"], fetch?: Fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const io: FleetIo = {
    env,
    clock: new FakeClock(1_700_000_000_000),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...(fetch === undefined ? {} : { fetch }),
  };
  return { io, out, err };
}

const pausedIn = async (t: TempDb) =>
  unwrap(await getSettings(t.db, [FLEET_PAUSED_KEY])).get(FLEET_PAUSED_KEY);

test("parse: pause and resume take no arguments; parseCli routes them", () => {
  expect(parseFleetCli(["pause"])).toEqual({
    ok: true,
    value: { paused: true },
  });
  expect(parseFleetCli(["resume"])).toEqual({
    ok: true,
    value: { paused: false },
  });
  expect(parseFleetCli(["pause", "now"]).ok).toBe(false);
  expect(parseCli(["resume"])).toEqual({
    ok: true,
    value: { command: "fleet", options: { paused: false } },
  });
});

test("the API answers: its state is printed and the database is left to it", async () => {
  const t = await db();
  const calls: [string, RequestInit][] = [];
  const { io, out } = rig(
    {
      FRM_API_TOKEN: TOKEN,
      FRM_API_URL: "http://api.test/",
      FRM_HOME: dirname(t.path),
    },
    async (url, init) => {
      calls.push([url, init]);
      return Response.json({ paused: true, changed: true, updated_at: 5 });
    },
  );
  expect(await runFleetCommand({ paused: true }, io)).toBe(0);
  expect(out).toEqual(["fleet paused (via the API)"]);
  expect(calls.map(([url, init]) => [url, init.method])).toEqual([
    ["http://api.test/api/v1/fleet/pause", "POST"],
  ]);
  expect(new Headers(calls[0]?.[1].headers).get("authorization")).toBe(
    `Bearer ${TOKEN}`,
  );
  expect(await pausedIn(t)).toBe(0);
});

test("the API is stopped: frm pause writes the database itself, audited; frm resume too", async () => {
  const t = await db();
  const port = await closedPort();
  const env = {
    FRM_API_TOKEN: TOKEN,
    FRM_API_URL: `http://127.0.0.1:${port}`,
    FRM_HOME: dirname(t.path),
  };
  const paused = rig(env);
  expect(await runFleetCommand({ paused: true }, paused.io)).toBe(0);
  expect(paused.err[0]).toMatch(
    /the API did not answer .*; writing .*foreman\.db directly/,
  );
  expect(paused.out).toEqual(["fleet paused (via the database)"]);
  expect(await pausedIn(t)).toBe(1);

  const again = rig(env);
  expect(await runFleetCommand({ paused: true }, again.io)).toBe(0);
  expect(again.out).toEqual(["fleet already paused (via the database)"]);

  const resumed = rig(env);
  expect(await runFleetCommand({ paused: false }, resumed.io)).toBe(0);
  expect(await pausedIn(t)).toBe(0);
  expect(
    unwrap(await listAudit(t.db)).map((r) => [
      r.actor,
      r.action,
      r.payload_json,
    ]),
  ).toEqual([
    ["operator", "fleet.pause", JSON.stringify({ via: "frm" })],
    ["operator", "fleet.resume", JSON.stringify({ via: "frm" })],
  ]);
});

test("an API that answers with an error is believed: exit 1, nothing written", async () => {
  const t = await db();
  const { io, err } = rig(
    {
      FRM_API_TOKEN: "wrong",
      FRM_API_URL: "http://api.test",
      FRM_HOME: dirname(t.path),
    },
    async () =>
      Response.json(
        {
          error: {
            class: "validation",
            message: "bad bearer",
            retryable: false,
          },
        },
        { status: 401 },
      ),
  );
  expect(await runFleetCommand({ paused: true }, io)).toBe(1);
  expect(err).toEqual([
    "frm pause: the API refused it: validation: bad bearer",
  ]);
  expect(await pausedIn(t)).toBe(0);
  expect(unwrap(await listAudit(t.db))).toEqual([]);
});

test("no token: straight to the database, saying why", async () => {
  const t = await db();
  const { io, err, out } = rig({ FRM_DB: t.path });
  expect(await runFleetCommand({ paused: true }, io)).toBe(0);
  expect(err[0]).toContain("FRM_API_TOKEN is not set");
  expect(out).toEqual(["fleet paused (via the database)"]);
  expect(await pausedIn(t)).toBe(1);
});

test("the API is down and there is no database to fall back to: exit 2, nothing created", async () => {
  const port = await closedPort();
  const api = { FRM_API_TOKEN: TOKEN, FRM_API_URL: `http://127.0.0.1:${port}` };
  const none = rig(api);
  expect(await runFleetCommand({ paused: true }, none.io)).toBe(2);
  expect(none.err[0]).toContain("set FRM_HOME (or FRM_DB)");
  const t = await db();
  const missing = rig({ ...api, FRM_HOME: `${dirname(t.path)}/nowhere` });
  expect(await runFleetCommand({ paused: true }, missing.io)).toBe(2);
  expect(missing.err[0]).toContain("no database at");
});
