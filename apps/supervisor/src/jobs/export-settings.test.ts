// apps must not import @bayon/db/operator (no-sql.test.ts): settings rows go in with the generic
// `seedRows` test helper instead, exactly as an operator's `settings` upsert would land them.
import { DEFAULT_TICKET_KEY_PREFIX, FakeClock } from "@bayon/core";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { afterAll, expect, test } from "vitest";
import { loadExportSettings } from "./export-settings.js";

const clock = new FakeClock(0);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());

test("defaults apply when no settings rows exist: the interval timer is off by default", async () => {
  const settings = unwrap(await loadExportSettings(t.db));
  expect(settings).toEqual({
    // The tickets module's own default (amendment 13: one key), so an exported file is named by
    // the key the API shows (found by the M1 smoke, an earlier change: it was "T-" here, "FRM-" there).
    "tickets.key_prefix": DEFAULT_TICKET_KEY_PREFIX,
    "exports.repo_path": null,
    "exports.interval_ms": 0,
  });
});

test("an operator can opt into the interval timer", async () => {
  unwrap(
    await seedRows(t.db, {
      settings: [
        {
          key: "exports.interval_ms",
          value_json: "300000",
          updated_at: clock.now(),
        },
      ],
    }),
  );
  const settings = unwrap(await loadExportSettings(t.db));
  expect(settings["exports.interval_ms"]).toBe(300_000);
});

test("an operator-set repo_path and key_prefix override the defaults", async () => {
  unwrap(
    await seedRows(t.db, {
      settings: [
        {
          key: "tickets.key_prefix",
          value_json: '"FOR-"',
          updated_at: clock.now(),
        },
        {
          key: "exports.repo_path",
          value_json: '"/srv/exports"',
          updated_at: clock.now(),
        },
      ],
    }),
  );
  const settings = unwrap(await loadExportSettings(t.db));
  expect(settings["tickets.key_prefix"]).toBe("FOR-");
  expect(settings["exports.repo_path"]).toBe("/srv/exports");
});

test("a key_prefix with a path separator or traversal is refused, not smuggled into a file path", async () => {
  for (const bad of ["../../etc", "a/b", "T.", "T ", ""]) {
    const fresh = unwrap(await tempDb(clock));
    try {
      unwrap(
        await seedRows(fresh.db, {
          settings: [
            {
              key: "tickets.key_prefix",
              value_json: JSON.stringify(bad),
              updated_at: clock.now(),
            },
          ],
        }),
      );
      expect(await loadExportSettings(fresh.db)).toMatchObject({
        ok: false,
        error: { class: "validation" },
      });
    } finally {
      fresh.cleanup();
    }
  }
});
