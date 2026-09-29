// A crashed conformance run's leftovers: its journal's placed-and-never-
// released sessions are released on their own executor, then its directory goes; a session on an
// executor not loaded here, or one whose release fails, keeps its line and its directory.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseOptions } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import { pino } from "pino";
import { afterAll, expect, test } from "vitest";
import { tempHome } from "../lifecycle/testing/fixtures.js";
import { JOURNAL, pendingOf, recoverConformanceRuns } from "./recover.js";

class Releasing extends FakeExecutor {
  readonly released: string[] = [];
  failing = false;

  async release(sessionId: string, o: ReleaseOptions): Promise<void> {
    if (this.failing) throw new Error("ssh: connection refused");
    this.released.push(`${sessionId} ${o.root}`);
  }
}

const home = tempHome("frm-rec-");
afterAll(() => home.cleanup());
const log = pino({ level: "silent" });

function run(name: string, journal?: string): string {
  const dir = join(home.path, "conformance", "runs", name);
  mkdirSync(join(dir, "work"), { recursive: true });
  if (journal !== undefined) writeFileSync(join(dir, JOURNAL), journal);
  return dir;
}

test("pendingOf: the sessions placed and never released, with their executor", () => {
  expect([
    ...pendingOf(
      "placed c1 S1\nplaced c1 S2\nreleased S1\nplaced c2 S3\n\nnot a line\n",
    ),
  ]).toEqual([
    ["S2", "c1"],
    ["S3", "c2"],
  ]);
});

test("a crashed run's sessions are released on their executor, then its directory goes; the rest wait", async () => {
  const c1 = new Releasing({ id: "c1", programs: {} });
  const c2 = new Releasing({ id: "c2", programs: {} });
  const executors = new Map([
    ["c1", c1],
    ["c2", c2],
  ]);
  const done = run("01A", "placed c1 S1\nreleased S1\nplaced c1 S2\n");
  const elsewhere = run("01B", "placed c9 S3\n");
  const failing = run("01C", "placed c2 S4\n");
  const local = run("01D"); // a local run has no journal: nothing to release
  c2.failing = true;
  await recoverConformanceRuns({ frmHome: home.path, executors, log });
  expect(c1.released).toEqual(["S2 remove"]);
  expect(existsSync(done)).toBe(false);
  expect(existsSync(local)).toBe(false);
  expect(existsSync(elsewhere)).toBe(true);
  expect(existsSync(failing)).toBe(true);
  c2.failing = false;
  await recoverConformanceRuns({ frmHome: home.path, executors, log });
  expect(c2.released).toEqual(["S4 remove"]);
  expect(existsSync(failing)).toBe(false);
  expect(readFileSync(join(elsewhere, JOURNAL), "utf8")).toBe("placed c9 S3\n");
});

test("no runs directory at all is nothing to do", async () => {
  const empty = tempHome("frm-rec0-");
  try {
    await expect(
      recoverConformanceRuns({
        frmHome: empty.path,
        executors: new Map(),
        log,
      }),
    ).resolves.toBeUndefined();
  } finally {
    empty.cleanup();
  }
});
