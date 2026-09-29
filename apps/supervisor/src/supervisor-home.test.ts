import { mkdtempSync, rmSync } from "node:fs";
import { FakeClock } from "@bayon/core";
import { pino } from "pino";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { homeTag } from "./paths.js";
import { startSupervisor } from "./supervisor.js";

// an earlier change MEDIUM-2: a supervisor never starts inside one of its own home's sessions, whose tag
// its environment would carry; the orphan scan must never find its own ancestry.
const homes: string[] = [];
afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test("FRM_HOME_TAG equal to this home's own tag: startSupervisor refuses, touching nothing", async () => {
  const home = mkdtempSync("/tmp/frm-");
  homes.push(home);
  vi.stubEnv("FRM_HOME_TAG", homeTag(home));
  const started = await startSupervisor({
    home,
    clock: new FakeClock(1_700_000_000_000),
    log: pino({ level: "silent" }),
    version: "0.1.0",
  });
  expect(started).toMatchObject({
    ok: false,
    error: {
      class: "validation",
      message: "refusing to start inside one of this home's sessions",
    },
  });
});

test("another home's tag is no bar", async () => {
  const home = mkdtempSync("/tmp/frm-");
  homes.push(home);
  vi.stubEnv("FRM_HOME_TAG", "fh-000000000000000000000000");
  const started = await startSupervisor({
    home,
    clock: new FakeClock(1_700_000_000_000),
    log: pino({ level: "silent" }),
    version: "0.1.0",
  });
  expect(started.ok).toBe(true);
  if (started.ok) await started.value.shutdown();
});

test("homeTag: fh- and 24 hex, one per real path", () => {
  const home = mkdtempSync("/tmp/frm-");
  homes.push(home);
  expect(homeTag(home)).toMatch(/^fh-[0-9a-f]{24}$/);
  expect(homeTag(`${home}/.`)).toBe(homeTag(home));
  expect(homeTag(home)).not.toBe(homeTag(`${home}-other`));
});
