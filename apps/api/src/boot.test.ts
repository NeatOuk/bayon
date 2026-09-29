import { FakeClock, systemClock } from "@bayon/core";
import { tempDb, unwrap } from "@bayon/db/testing";
import { describe, expect, test } from "vitest";
import { bootApi, checkMigrations } from "./boot.js";

const TOKEN = "boot-bearer-0123456789abcdef";
const env = (path: string) => ({
  FRM_API_TOKEN: TOKEN,
  FRM_API_PORT: "0",
  FRM_DB: path,
});

/** A temp database migrated to `to` (latest when omitted), removed afterwards. */
async function withDb(
  to: number | undefined,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const temp = unwrap(
    await tempDb(new FakeClock(), to === undefined ? {} : { to }),
  );
  try {
    await fn(temp.path);
  } finally {
    temp.cleanup();
  }
}

describe("bootApi", () => {
  test("starts on a migrated database and serves /health", async () => {
    await withDb(undefined, async (path) => {
      const booted = unwrap(
        await bootApi({ env: env(path), clock: systemClock, logger: false }),
      );
      try {
        const res = await fetch(`${booted.api.url}/health`);
        expect(res.status).toBe(200);
      } finally {
        await booted.close();
      }
    });
  });

  test("refuses to start while migrations are pending", async () => {
    const cases = [
      [0, "001_spine"],
      [1, "002_seed"],
    ] as const;
    for (const [to, pending] of cases) {
      await withDb(to, async (path) => {
        const booted = await bootApi({
          env: env(path),
          clock: systemClock,
          logger: false,
        });
        expect(booted).toMatchObject({
          ok: false,
          error: { class: "validation" },
        });
        // The headline says how far behind and where it starts; the cause lists every file.
        expect(booted.ok ? "" : booted.error.message).toContain(
          `migrations to apply, from ${pending})`,
        );
        expect(booted.ok ? [] : booted.error.cause).toMatchObject({
          pending: expect.arrayContaining([pending]),
        });
      });
    }
  });

  test("refuses without a token or without a database", async () => {
    for (const bad of [
      { FRM_DB: "/nowhere/foreman.db" },
      { FRM_API_TOKEN: TOKEN },
    ]) {
      expect(await bootApi({ env: bad, clock: systemClock })).toMatchObject({
        ok: false,
        error: { class: "validation" },
      });
    }
  });
});

describe("checkMigrations", () => {
  const clean = {
    applied: [],
    pending: [],
    drifted: [],
    tables: [],
    views: [],
  };

  test("nothing pending or drifted is ready", () => {
    expect(checkMigrations(clean)).toEqual({ ok: true, value: undefined });
  });

  test("drifted files refuse first, by name", () => {
    const result = checkMigrations({
      ...clean,
      drifted: [{ version: 1, name: "spine" }],
      pending: [{ version: 2, name: "seed" }],
    });
    expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(result.ok ? "" : result.error.message).toContain(
      "have since changed (001_spine",
    );
  });
});
