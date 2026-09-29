import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { runCli, type CliIo } from "./cli.js";

const dir = mkdtempSync(join(tmpdir(), "bayon-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const clock = new FakeClock(1_700_000_000_000);

function capture(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    env,
    clock,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, out: () => out.join("\n"), err: () => err.join("\n") };
}

test("up, status and down --yes against a temp file", async () => {
  const path = join(dir, "cli.db");
  const up = capture();
  expect(await runCli(["up", "--db", path], up.io)).toBe(0);
  expect(up.out()).toMatch(/applied\s+001_spine/);
  expect(up.out()).toMatch(
    /tables\s+53: agents, approvals, attention_acks, audit_log, backups,/,
  );
  expect(up.out()).toMatch(
    /views\s+3: v_fleet, v_needs_attention, v_ticket_economics/,
  );

  const status = capture({ FRM_DB: path });
  expect(await runCli(["status"], status.io)).toBe(0);
  expect(status.out()).toContain(path);
  expect(status.out()).toMatch(/pending\s+\(none\)/);

  const refused = capture();
  expect(await runCli(["down", "--db", path], refused.io)).toBe(2);
  expect(refused.err()).toContain("--yes");

  const down = capture();
  expect(await runCli(["down", "--db", path, "--yes"], down.io)).toBe(0);
  // `down` reverts the last migration alone, so the one pending after it is the newest.
  expect(down.out()).toMatch(/pending\s+052_drift_rounds_max/);
});

test("--to stops at a version", async () => {
  const cli = capture();
  const path = join(dir, "to.db");
  expect(await runCli(["up", "--db", path, "--to", "1"], cli.io)).toBe(0);
  expect(cli.out()).toMatch(/pending\s+002_seed/);
});

test("the database defaults to $FRM_HOME/foreman.db", async () => {
  const cli = capture({ FRM_HOME: dir });
  expect(await runCli(["status"], cli.io)).toBe(0);
  expect(cli.out()).toContain(join(dir, "foreman.db"));
});

test.each([
  [[]],
  [["frob", "--db", "x.db"]],
  [["up", "--nope", "--db", "x.db"]],
  [["up", "down", "--db", "x.db"]],
  [["status"]],
  [["up", "--db", "x.db", "--to", "one"]],
  [["status", "--db", "x.db", "--to", "1"]],
])("bad arguments %j exit 2 with the usage", async (argv) => {
  const cli = capture();
  expect(await runCli(argv, cli.io)).toBe(2);
  expect(cli.err()).toContain("usage:");
});

test("a database that cannot open exits 1", async () => {
  const cli = capture();
  const path = join(dir, "missing", "x.db");
  expect(await runCli(["status", "--db", path], cli.io)).toBe(1);
  expect(cli.err()).toMatch(/^validation: /);
});

test("a failing migration command exits 1", async () => {
  const cli = capture();
  const path = join(dir, "empty.db");
  expect(await runCli(["down", "--db", path, "--yes"], cli.io)).toBe(1);
  expect(cli.err()).toMatch(/^validation: /);
});
