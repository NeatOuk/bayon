import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { getTicket, type Db } from "@bayon/db";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import {
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type SeedRows,
} from "@bayon/db/testing";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { fingerprintOf } from "./probe-findings.js";
import { createProbeRunner, type ProbeResult } from "./probes.js";

// The probe runner over a real temp-file DB and real child processes. Probe timeouts
// run on the fake clock: the test advances it, nothing sleeps.
const clock = new FakeClock(1_700_000_000_000);
const home = realpathSync(mkdtempSync(join(tmpdir(), "frm-probes-")));
mkdirSync(join(home, "logs"));
const cleanups: (() => void)[] = [
  () => rmSync(home, { recursive: true, force: true }),
];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

const NODE = process.execPath;
const node = (script: string) => JSON.stringify([NODE, "-e", script]);
/** 500 lines, each its own signature: digits spelled as letters. */
const MANY_LINES =
  "for (let i = 0; i < 500; i++) console.log('warn ' + String(i).replace(/[0-9]/g, (d) => 'abcdefghij'[d]) + ' ' + 'x'.repeat(40))";

type Probe = NonNullable<SeedRows["probes"]>[number];
const shell = (
  name: string,
  script: string,
  { cwd = "logs", ...o }: Partial<Probe> & { cwd?: "logs" | "mirrors" } = {},
): Probe => ({
  name,
  kind: "shell",
  spec_json: `{"argv":${node(script)},"cwd":"${cwd}"}`,
  every_pulse: 0,
  ...o,
});

/** Test probes: every_pulse 0, so a full run is exactly 004's six. */
const PROBES: Probe[] = [
  shell("t_timeout", "setTimeout(() => {}, 60000)", { timeout_ms: 500 }),
  shell("t_many", MANY_LINES),
  shell("t_untrusted", "console.log('error: boom 42')", {
    untrusted_output: 1,
  }),
  shell("t_nomatch", "process.exit(1)"),
  shell("t_exit2", "console.error('cannot read'); process.exit(2)", {
    untrusted_output: 1,
  }),
  shell(
    "t_cwd",
    "console.log('in ' + require('path').basename(process.cwd()))",
    {
      cwd: "mirrors",
    },
  ),
  shell("t_off", "console.log(1)", { enabled: 0 }),
  // A row cannot smuggle SQL: the query is only a key, and the spec is strict.
  {
    name: "t_rowsql",
    kind: "sql",
    spec_json: '{"query":"delete from tickets"}',
    every_pulse: 0,
  },
  {
    name: "t_extra",
    kind: "sql",
    spec_json: '{"query":"budget","sql":"delete from tickets"}',
    every_pulse: 0,
  },
  {
    name: "t_http",
    kind: "http",
    spec_json: '{"url":"http://127.0.0.1:1"}',
    every_pulse: 0,
  },
  { name: "t_script", kind: "script_runner", spec_json: "{}", every_pulse: 0 },
];

async function seeded(): Promise<Db> {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 4));
  unwrap(await seedRows(t.db, { tickets: [ticketRow(1)], probes: PROBES }));
  return t.db;
}

const runnerOf = (db: Db, slots = new SlotCounter(1)) =>
  createProbeRunner({
    db,
    clock,
    executor: new LocalExecutor({ id: "local", slots }),
    slots,
    home,
    path: process.env["PATH"] ?? "",
  });

const Result = z.object({
  untrusted: z.boolean(),
  findings: z.array(z.record(z.string(), z.unknown())),
  omitted: z.int().optional(),
  stderr: z.string().optional(),
});
const resultOf = (r: ProbeResult | undefined) =>
  Result.parse(JSON.parse(r?.result_json ?? "null"));

async function runOne(
  db: Db,
  name: string,
  slots?: SlotCounter,
): Promise<ProbeResult> {
  const results = unwrap(
    await runnerOf(db, slots).run({
      pulseId: "p-1",
      names: [name],
      signal: new AbortController().signal,
    }),
  );
  expect(results).toHaveLength(1);
  const [only] = results;
  if (only === undefined) throw new Error("no result");
  return only;
}

/** Advances the fake clock until `p` settles: the probe's timer is armed only once it starts. */
async function drive<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  void p.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) {
    await clock.advance(1_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return p;
}

test("without names, runs the enabled every_pulse probes: 004's six, all ok on an empty fleet", async () => {
  const db = await seeded();
  const results = unwrap(
    await runnerOf(db).run({
      pulseId: "p-1",
      signal: new AbortController().signal,
    }),
  );
  expect(results.map((r) => [r.name, r.state, r.error])).toEqual([
    ["budget", "ok", null],
    ["gate_health", "ok", null],
    ["handoff_pending", "ok", null],
    ["log_scan", "ok", null],
    ["merged_prs", "ok", null],
    ["stale_sessions", "ok", null],
  ]);
  const scan = results.find((r) => r.name === "log_scan");
  expect(resultOf(scan)).toEqual({ untrusted: true, findings: [] });
});

test("a shell probe past its timeout_ms is killed and recorded as timeout", async () => {
  const db = await seeded();
  const result = await drive(runOne(db, "t_timeout"));
  expect(result).toMatchObject({
    name: "t_timeout",
    state: "timeout",
    error: "timeout: over 500 ms",
  });
  expect(result.duration_ms).toBeGreaterThanOrEqual(500);
});

test("output past the cap keeps capped findings in the row and the whole output at result_path", async () => {
  const db = await seeded();
  const result = await runOne(db, "t_many");
  expect(result.state).toBe("ok");
  expect(Buffer.byteLength(result.result_json ?? "")).toBeLessThanOrEqual(
    8 * 1024,
  );
  const body = resultOf(result);
  expect(body.findings.length).toBeGreaterThan(0);
  expect(body.findings.length).toBeLessThanOrEqual(50);
  expect(body.findings.length + (body.omitted ?? 0)).toBe(500);
  expect(body.findings[0]).toEqual({
    fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
    line: `warn a ${"x".repeat(40)}`,
    count: 1,
  });
  const path = result.result_path ?? "";
  expect(
    path.startsWith(join(home, "runtime", "pulses", "p-1", "probes")),
  ).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const full = readFileSync(path, "utf8").trimEnd().split("\n");
  expect(full).toHaveLength(500);
  expect(full[499]).toBe(`warn ejj ${"x".repeat(40)}`); // 499, spelled
});

test("a row's SQL never runs: an unknown query id and extra spec keys are refused", async () => {
  const db = await seeded();
  for (const name of ["t_rowsql", "t_extra"]) {
    const result = await runOne(db, name);
    expect(result).toMatchObject({ state: "error", result_json: null });
    expect(result.error).toMatch(/^validation: /);
  }
  expect(unwrap(await getTicket(db, "ticket-1")).num).toBe(1);
});

test("http and script_runner probes are refused (validation) for now", async () => {
  const db = await seeded();
  expect(await runOne(db, "t_http")).toMatchObject({
    state: "error",
    error:
      "validation: a http probe is not run yet; M2 runs sql and shell probes",
  });
  expect((await runOne(db, "t_script")).error).toMatch(
    /^validation: a script_runner probe/,
  );
});

test("untrusted_output is carried into the check, with a stable fingerprint per finding", async () => {
  const db = await seeded();
  const first = resultOf(await runOne(db, "t_untrusted"));
  expect(first).toEqual({
    untrusted: true,
    findings: [
      {
        fingerprint: fingerprintOf("t_untrusted", "error: boom #"),
        line: "error: boom 42",
        count: 1,
      },
    ],
  });
  expect(resultOf(await runOne(db, "t_untrusted"))).toEqual(first);
  expect(resultOf(await runOne(db, "t_nomatch")).untrusted).toBe(false);
});

test("exit 1 without stderr is no match; any other failure is an error with stderr inside result_json", async () => {
  const db = await seeded();
  expect(await runOne(db, "t_nomatch")).toMatchObject({
    state: "ok",
    error: null,
  });
  const failed = await runOne(db, "t_exit2");
  expect(failed).toMatchObject({ state: "error", error: "exit 2" });
  expect(resultOf(failed)).toEqual({
    untrusted: true,
    findings: [],
    stderr: "cannot read",
  });
});

test("a mirrors probe runs in each repo's mirror; a missing mirror is an error, the rest still report", async () => {
  const db = await seeded();
  const mirror = join(home, "alpha.git");
  mkdirSync(mirror, { recursive: true });
  unwrap(
    await seedRows(db, {
      repos: [
        { id: "r-a", name: "alpha", mirror_path: mirror },
        { id: "r-b", name: "beta", mirror_path: join(home, "gone.git") },
      ],
    }),
  );
  const result = await runOne(db, "t_cwd");
  expect(result.state).toBe("error");
  expect(result.error).toBe(
    `beta: cannot start: no directory ${join(home, "gone.git")}`,
  );
  expect(resultOf(result).findings).toEqual([
    expect.objectContaining({ line: "alpha: in alpha.git" }),
  ]);
});

test("a missing or disabled named probe, or a bad pulse id, fails the call", async () => {
  const db = await seeded();
  const run = (pulseId: string, names: string[]) =>
    runnerOf(db).run({ pulseId, names, signal: new AbortController().signal });
  expect(await run("p-1", ["nope"])).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
  expect(await run("p-1", ["t_off"])).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect(await run("../p", ["budget"])).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("a cancelled run records its checks as interrupted", async () => {
  const db = await seeded();
  const results = unwrap(
    await runnerOf(db).run({
      pulseId: "p-1",
      names: ["budget", "t_untrusted"],
      signal: AbortSignal.abort(),
    }),
  );
  expect(results.map((r) => [r.name, r.state, r.error])).toEqual([
    ["budget", "error", "interrupted: the run was cancelled"],
    ["t_untrusted", "error", "interrupted: the run was cancelled"],
  ]);
});

// a shell probe spawns a real program on the executor without going through admission,
// so it takes one of its slots for the run and is refused when the executor is already full.
test("a shell probe holds an executor slot while it runs, and gives it back", async () => {
  const db = await seeded();
  const slots = new SlotCounter(1);
  expect(slots.capacity()).toEqual({ slots: 1, used: 0 });

  const result = await runOne(db, "t_cwd", slots);
  expect(result.state).toBe("ok");
  // Released whatever the outcome: the next probe finds the executor free.
  expect(slots.capacity()).toEqual({ slots: 1, used: 0 });
});

test("a shell probe on a full executor is refused as busy, naming the executor, and never runs", async () => {
  const db = await seeded();
  const slots = new SlotCounter(1);
  const held = slots.tryAcquire();
  expect(held).not.toBeNull();

  const result = await runOne(db, "t_cwd", slots);
  expect(result).toMatchObject({ name: "t_cwd", state: "error" });
  expect(result.error).toContain("admission_refused");
  expect(result.error).toContain("local");
  expect(result.error).toContain("1 of 1 slots used");
  // The claim it could not take is not leaked: the executor is exactly as busy as before.
  expect(slots.capacity()).toEqual({ slots: 1, used: 1 });

  held?.release();
  expect((await runOne(db, "t_cwd", slots)).state).toBe("ok");
});

test("an sql probe needs no slot: it reads the database, never the executor", async () => {
  const db = await seeded();
  const slots = new SlotCounter(1);
  const held = slots.tryAcquire();

  // Full executor, and the sql probe still runs — it is refused for its own reason (a row may
  // never carry SQL), never for want of a slot it does not need.
  const result = await runOne(db, "t_rowsql", slots);
  expect(result.state).toBe("error");
  expect(result.error).not.toContain("admission_refused");
  held?.release();
});
