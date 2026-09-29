import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, ok } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf, openDb, openDbReadOnly, type Db } from "./connection.js";
import { getFleet } from "./repos/fleet.js";
import { unwrap } from "./testing.js";

const dir = mkdtempSync(join(tmpdir(), "bayon-conn-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const clock = new FakeClock(1_700_000_000_000);

test("openDb applies the five pragmas, verified by query", async () => {
  const db = unwrap(await openDb({ path: join(dir, "pragmas.db"), clock }));
  const { raw } = unwrap(internalsOf(db));
  const read = (name: string) => raw.pragma(name, { simple: true });
  expect(read("journal_mode")).toBe("wal");
  expect(read("synchronous")).toBe(1); // NORMAL
  expect(read("busy_timeout")).toBe(5000);
  expect(read("foreign_keys")).toBe(1);
  expect(read("wal_autocheckpoint")).toBe(1000);
  unwrap(await db.close());
});

test(":memory: cannot run WAL, so opening it is a validation error", async () => {
  expect(await openDb({ path: ":memory:", clock })).toMatchObject({
    ok: false,
    error: { class: "validation", retryable: false },
  });
});

test("a path in a missing directory is a validation error, not a throw", async () => {
  expect(
    await openDb({ path: join(dir, "missing", "x.db"), clock }),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("Db is opaque: it exposes only stats and close", async () => {
  const db = unwrap(await openDb({ path: join(dir, "opaque.db"), clock }));
  expect(Object.keys(db)).toEqual(["stats", "close"]);
  expect(db.stats).toEqual({ txns: 0, busy: 0 });
  unwrap(await db.close());
});

test("a closed Db returns errors instead of throwing", async () => {
  const db = unwrap(await openDb({ path: join(dir, "closed.db"), clock }));
  unwrap(await db.close());
  expect(await getFleet(db)).toMatchObject({
    ok: false,
    error: { class: "internal" },
  });
});

test("openDbReadOnly fails fast on a missing file instead of creating one", async () => {
  const path = join(dir, "readonly-missing.db");
  expect(await openDbReadOnly({ path, clock })).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("openDbReadOnly sets busy_timeout and refuses any write at the SQLite layer", async () => {
  const path = join(dir, "readonly.db");
  const writer = unwrap(await openDb({ path, clock }));
  unwrap(await writer.close());

  const ro = unwrap(await openDbReadOnly({ path, clock }));
  const { raw } = unwrap(internalsOf(ro));
  expect(raw.pragma("busy_timeout", { simple: true })).toBe(5000);
  expect(() => raw.prepare("CREATE TABLE t(x)").run()).toThrow(
    /readonly database/,
  );
  unwrap(await ro.close());
});

test("an object that did not come from openDb is rejected", async () => {
  const impostor: Db = {
    stats: { txns: 0, busy: 0 },
    close: () => Promise.resolve(ok(undefined)),
  };
  expect(await getFleet(impostor)).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});
