import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, ok, type Result } from "@bayon/core";
import { listPulseChecks, type Db } from "@bayon/db";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import {
  SPINE_SEED,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
} from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test } from "vitest";
import { probeRunCommand } from "./probe-command.js";
import {
  createProbeRunner,
  type ProbeResult,
  type ProbeRunner,
} from "./probes.js";

// probe.run: the handler checks and returns; the check lands in pulse_checks once the
// probe ends, through insertPulseChecks.
const clock = new FakeClock(1_700_000_000_000);
const home = realpathSync(mkdtempSync(join(tmpdir(), "frm-probe-cmd-")));
const cleanups: (() => void)[] = [
  () => rmSync(home, { recursive: true, force: true }),
];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));
const log = pino({ level: "silent" });
const META = { id: "cmd-1", attempts: 1 };

async function seeded(): Promise<Db> {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 4));
  unwrap(
    await seedRows(t.db, {
      pulses: [
        {
          id: "p-1",
          agent_id: SPINE_SEED.agentId,
          trigger: "manual",
          scheduled_at: 0,
          state: "done",
        },
      ],
      probes: [
        {
          name: "t_off",
          kind: "sql",
          spec_json: '{"query":"budget"}',
          enabled: 0,
        },
      ],
    }),
  );
  return t.db;
}

const realRunner = (db: Db, slots = new SlotCounter(1)) =>
  createProbeRunner({
    db,
    clock,
    executor: new LocalExecutor({ id: "local", slots }),
    slots,
    home,
    path: process.env["PATH"] ?? "",
  });

test("registers as probe.run with the proto payload", async () => {
  const cmd = probeRunCommand({
    db: await seeded(),
    runner: realRunner(await seeded()),
    log,
  });
  expect(cmd.handler.type).toBe("probe.run");
  expect(
    cmd.handler.payload.safeParse({ pulse_id: "p-1", probe: "budget" }).success,
  ).toBe(true);
  expect(cmd.handler.payload.safeParse({ pulse_id: "p-1" }).success).toBe(
    false,
  );
});

test("re-runs one probe and records a new pulse_checks row", async () => {
  const db = await seeded();
  const cmd = probeRunCommand({ db, runner: realRunner(db), log });
  expect(
    await cmd.handler.handle({ pulse_id: "p-1", probe: "budget" }, META),
  ).toEqual(ok({ pulse_id: "p-1", probe: "budget", queued: true }));
  await cmd.idle();
  expect(unwrap(await listPulseChecks(db, "p-1"))).toEqual([
    expect.objectContaining({
      pulse_id: "p-1",
      name: "budget",
      state: "ok",
      error: null,
    }),
  ]);
});

test("an unknown pulse or probe is not_found, a disabled probe validation; nothing is queued", async () => {
  const db = await seeded();
  const cmd = probeRunCommand({ db, runner: realRunner(db), log });
  const handle = (pulse_id: string, probe: string) =>
    cmd.handler.handle({ pulse_id, probe }, META);
  expect(await handle("p-9", "budget")).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
  expect(await handle("p-1", "nope")).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
  expect(await handle("p-1", "t_off")).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  await cmd.idle();
  expect(unwrap(await listPulseChecks(db, "p-1"))).toEqual([]);
});

test("stop cancels a re-run in flight and waits for its check to be recorded", async () => {
  const db = await seeded();
  const waiting: ProbeRunner = {
    run: (a) =>
      new Promise<Result<readonly ProbeResult[]>>((resolve) => {
        a.signal.addEventListener("abort", () =>
          resolve(
            ok([
              {
                name: a.names?.[0] ?? "",
                state: "error",
                duration_ms: 0,
                result_json: null,
                result_path: null,
                error: "interrupted: the run was cancelled",
              },
            ]),
          ),
        );
      }),
  };
  const cmd = probeRunCommand({ db, runner: waiting, log });
  unwrap(
    await cmd.handler.handle({ pulse_id: "p-1", probe: "log_scan" }, META),
  );
  expect(unwrap(await listPulseChecks(db, "p-1"))).toEqual([]);
  await cmd.stop();
  expect(unwrap(await listPulseChecks(db, "p-1"))).toEqual([
    expect.objectContaining({ name: "log_scan", state: "error" }),
  ]);
});

test("after stop, a command the claimer still hands over is refused, not orphaned", async () => {
  const db = await seeded();
  const cmd = probeRunCommand({ db, runner: realRunner(db), log });
  const pending = cmd.handler.handle(
    { pulse_id: "p-1", probe: "budget" },
    META,
  );
  await cmd.stop(); // lands while that handle() is still reading the pulse
  expect(await pending).toMatchObject({
    ok: false,
    error: { class: "interrupted", retryable: true },
  });
  expect(
    await cmd.handler.handle({ pulse_id: "p-1", probe: "budget" }, META),
  ).toMatchObject({ ok: false, error: { class: "interrupted" } });
  await cmd.idle();
  expect(unwrap(await listPulseChecks(db, "p-1"))).toEqual([]);
});
