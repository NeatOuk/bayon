// a login grant that no session can use is named at boot, once, rather than surfacing
// only when a spawn is refused. Against a real temp database; runner ids come from the registry.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  FakeClock,
  LOGIN_IN_PLACE_KEY,
  READS_GRANTED_LOGIN,
  readsGrantedLogin,
} from "@bayon/core";
import { openDb } from "@bayon/db";
import { migrateUp } from "@bayon/db/supervisor";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { registrations } from "@bayon/runners";
import { pino } from "pino";
import { afterAll, expect, test } from "vitest";
import { unusableGrants } from "./boot.js";
import { dbPath } from "./paths.js";
import { startSupervisor } from "./supervisor.js";

const T0 = 1_700_000_000_000;
const home = mkdtempSync("/tmp/frm-");
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** A registered runner that does not declare it reads a login, and one that does (if any). */
const unreading = registrations().find(
  (r) => !readsGrantedLogin(r.runner.defaults),
)?.runner.id;

const grant = (value: unknown) => ({
  settings: [
    {
      key: LOGIN_IN_PLACE_KEY,
      value_json: JSON.stringify(value),
      updated_at: T0,
    },
  ],
});

test("unusableGrants names each granted runner that is unregistered or cannot read a login, and passes one that can", async () => {
  const t = unwrap(await tempDb(new FakeClock(T0)));
  try {
    unwrap(
      await seedRows(t.db, {
        runners: [
          ["reads-one", { [READS_GRANTED_LOGIN]: true }],
          ["reads-none", {}],
        ].map(([id, defaults]) => ({
          id: String(id),
          kind: "script",
          adapter: String(id),
          caps_json: "{}",
          defaults_json: JSON.stringify(defaults),
        })),
        ...grant({
          "reads-one": "/op/a.json",
          "reads-none": "/op/b.json",
          "not-registered": "/op/c.json",
        }),
      }),
    );
    expect(unwrap(await unusableGrants(t.db))).toEqual([
      { runnerId: "reads-none", reason: "cannot_read" },
      { runnerId: "not-registered", reason: "unregistered" },
    ]);
    unwrap(await seedRows(t.db, grant({})));
    expect(unwrap(await unusableGrants(t.db))).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("a boot with such a grant logs one warning for it, naming the setting and the runner, and still starts", async () => {
  expect(unreading).toBeDefined();
  const runnerId = unreading ?? "";
  const path = dbPath(home);
  const db = unwrap(await openDb({ path, clock: new FakeClock(T0) }));
  unwrap(await migrateUp(db, {}));
  unwrap(await seedRows(db, grant({ [runnerId]: join(home, "auth.json") })));
  unwrap(await db.close());

  const lines: { msg?: string; runner?: string; setting?: string }[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() !== "") lines.push(JSON.parse(line) as never);
      }
      done();
    },
  });
  const sup = unwrap(
    await startSupervisor({
      home,
      clock: new FakeClock(T0),
      log: pino({ level: "warn" }, sink),
      version: "0.1.0",
    }),
  );
  await sup.shutdown();
  const warned = lines.filter((l) => l.runner === runnerId);
  expect(warned).toHaveLength(1);
  expect(warned[0]?.setting).toBe(LOGIN_IN_PLACE_KEY);
  expect(warned[0]?.msg).toContain("cannot read a login in place");
});
