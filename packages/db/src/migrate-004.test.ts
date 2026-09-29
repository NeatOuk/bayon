import { FakeClock } from "@bayon/core";
import type { Insertable } from "kysely";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { internalsOf, type Db } from "./connection.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";
import { findLivePulse, listProbes } from "./repos/pulses.js";
import type {
  ProbesTable,
  PulseChecksTable,
  PulsesTable,
} from "./schema-pulse.js";
import type { AttentionWhy, HandoffsTable } from "./schema-work.js";
import {
  rawAttentionForTest,
  SPINE_SEED,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "./testing.js";

// 004_pulse: the pulse tables and their lease index, the seeded probes and M2 settings,
// and v_needs_attention rebuilt (M2 amendments c, d, i).
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function dbAt(to: number): Promise<Db> {
  const t = unwrap(await tempDb(clock, { to }));
  cleanups.push(t.cleanup);
  return t.db;
}

/** A database at 004 with the spine seeded: an agent, a runner, an executor and a session. */
async function spineAt4(): Promise<Db> {
  const db = await dbAt(4);
  unwrap(await seedSpine(db, 4));
  return db;
}

const rawOf = (db: Db) => unwrap(internalsOf(db)).raw;
const exec = (db: Db, statement: string): void => {
  rawOf(db).prepare(statement).run();
};

/** The schema in a fixed order, without rootpage. */
const dump = (db: Db): string =>
  JSON.stringify(
    rawOf(db)
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      )
      .all(),
  );

const Settings = z.array(z.object({ key: z.string(), value_json: z.string() }));
const settingsOf = (db: Db) =>
  Settings.parse(
    rawOf(db)
      .prepare("SELECT key, value_json FROM settings ORDER BY key")
      .all(),
  );

const conflict = { ok: false, error: { class: "conflict" } };
const validation = { ok: false, error: { class: "validation" } };

// v_needs_attention reads the wall clock (unixepoch()); this sits far past it.
const FAR_FUTURE = 32_503_680_000_000; // 3000-01-01

/** A live pulse for the spine's agent, holding its lease. */
const pulse = (
  id: string,
  o: Partial<Insertable<PulsesTable>> = {},
): Insertable<PulsesTable> => ({
  id,
  agent_id: SPINE_SEED.agentId,
  trigger: "cron",
  scheduled_at: 0,
  state: "leased",
  lease_token: `lease-${id}`,
  lease_expires_at: 1_020_000,
  ...o,
});

/** An accepted hand-off: pending only when a test clears accepted_at. */
const handoff = (
  id: string,
  ticket_id: string,
  o: Partial<Insertable<HandoffsTable>> = {},
): Insertable<HandoffsTable> => ({
  id,
  ticket_id,
  reason: "turn_ceiling",
  facts_json: "{}",
  packet_path: `/p/${id}.md`,
  packet_hash: "h",
  created_at: 0,
  accepted_at: 1,
  ...o,
});
const chain = (ticketId: string, n: number) =>
  Array.from({ length: n }, (_, i) => handoff(`${ticketId}-h${i}`, ticketId));

/** A row with values its table's types forbid: the CHECKs, not tsc, must refuse it. */
const invalid = <T>(row: T, bad: Record<string, unknown>): T =>
  ({ ...row, ...bad }) as unknown as T;

const refsFor = async (db: Db, why: AttentionWhy) =>
  unwrap(await rawAttentionForTest(db)).filter((row) => row.why === why);

test("004 adds pulses, probes and pulse_checks; the views keep their names", async () => {
  const db = await dbAt(3);
  const before = unwrap(await migrationStatus(db));
  const after = unwrap(await migrateUp(db, { to: 4 }));
  expect(after.tables.filter((t) => !before.tables.includes(t))).toEqual([
    "probes",
    "pulse_checks",
    "pulses",
  ]);
  expect(after.views).toEqual(before.views);
});

test("004 seeds the six §10.2 probes; a sql probe names a query and carries no SQL", async () => {
  const probes = unwrap(await listProbes(await dbAt(4)));
  expect(
    probes.map(({ name, kind, untrusted_output }) => ({
      name,
      kind,
      untrusted_output,
    })),
  ).toEqual([
    { name: "budget", kind: "sql", untrusted_output: 0 },
    { name: "gate_health", kind: "sql", untrusted_output: 0 },
    { name: "handoff_pending", kind: "sql", untrusted_output: 0 },
    { name: "log_scan", kind: "shell", untrusted_output: 1 },
    { name: "merged_prs", kind: "shell", untrusted_output: 0 },
    { name: "stale_sessions", kind: "sql", untrusted_output: 0 },
  ]);
  for (const probe of probes) {
    expect(probe).toMatchObject({
      timeout_ms: 30_000,
      enabled: 1,
      every_pulse: 1,
    });
    const spec: unknown = JSON.parse(probe.spec_json);
    if (probe.kind === "sql") expect(spec).toEqual({ query: probe.name });
    else expect(spec).toMatchObject({ argv: expect.any(Array) });
  }
  const cwd = (name: string) =>
    z
      .object({ cwd: z.string() })
      .parse(JSON.parse(probes.find((p) => p.name === name)?.spec_json ?? ""))
      .cwd;
  expect(cwd("merged_prs")).toBe("mirrors");
  expect(cwd("log_scan")).toBe("logs");
});

test("004 seeds the M2 settings exactly, and keeps a value the operator already set", async () => {
  const m2 = (db: Db) =>
    settingsOf(db).filter((s) =>
      /^(?:pulse|handoff|preflight|spend)\./.test(s.key),
    );
  expect(m2(await dbAt(4))).toEqual([
    { key: "handoff.max_turns", value_json: "3" },
    { key: "handoff.packet_tokens_cap", value_json: "1200" },
    { key: "handoff.prompt_tokens_cap", value_json: "1500" },
    { key: "handoff.wall_clock_ms", value_json: "300000" },
    { key: "preflight.margin_pct", value_json: "15" },
    { key: "pulse.lease_ttl_ms", value_json: "1020000" },
    { key: "spend.alarm_pct", value_json: "25" },
    { key: "spend.baseline_days", value_json: "30" },
  ]);

  const tuned = await dbAt(3);
  unwrap(
    await seedRows(tuned, {
      settings: [{ key: "spend.alarm_pct", value_json: "40", updated_at: 0 }],
    }),
  );
  unwrap(await migrateUp(tuned, { to: 4 }));
  expect(m2(tuned)).toContainEqual({
    key: "spend.alarm_pct",
    value_json: "40",
  });
});

test("one live pulse per agent: a second leased or running pulse is refused (amendment d)", async () => {
  const db = await spineAt4();
  unwrap(
    await seedRows(db, {
      agents: [
        {
          id: "agent-orch",
          name: "orch",
          kind: "orchestrator",
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          created_at: 0,
        },
      ],
      pulses: [pulse("p-1")],
    }),
  );
  expect(await seedRows(db, { pulses: [pulse("p-2")] })).toMatchObject(
    conflict,
  );
  expect(
    await seedRows(db, { pulses: [pulse("p-2", { state: "running" })] }),
  ).toMatchObject(conflict);

  // Another agent's lease is its own, and a pulse that ended holds none.
  unwrap(
    await seedRows(db, {
      pulses: [
        pulse("p-orch", { agent_id: "agent-orch" }),
        pulse("p-done", { state: "done" }),
        pulse("p-skip", {
          state: "skipped",
          skip_reason: "nothing_to_do",
          lease_token: null,
          lease_expires_at: null,
        }),
        pulse("p-fail", { state: "failed", skip_reason: "unreported" }),
      ],
    }),
  );
  exec(db, "UPDATE pulses SET state = 'expired' WHERE id = 'p-1'");
  unwrap(await seedRows(db, { pulses: [pulse("p-2", { state: "running" })] }));
  expect(unwrap(await findLivePulse(db, SPINE_SEED.agentId))?.id).toBe("p-2");
});

test.each([
  ["an unknown trigger", { trigger: "timer" }],
  ["an unknown state", { state: "queued" }],
  ["a leased pulse without a lease token", { lease_token: null }],
  [
    "a running pulse without a lease expiry",
    { state: "running", lease_expires_at: null },
  ],
  ["a skipped pulse without a reason", { state: "skipped" }],
  ["a negative cost", { state: "done", cost_usd: -1 }],
  ["negative context tokens", { context_tokens: -1 }],
])("pulses refuses %s", async (_, bad) => {
  const db = await spineAt4();
  expect(
    await seedRows(db, { pulses: [invalid(pulse("p"), bad)] }),
  ).toMatchObject(validation);
});

const probe: Insertable<ProbesTable> = {
  name: "extra",
  kind: "sql",
  spec_json: '{"query":"extra"}',
};

test.each([
  ["an unknown kind", { kind: "python" }],
  ["spec_json that is not JSON", { spec_json: "not json" }],
  [
    "a sql probe carrying SQL instead of a query id",
    { spec_json: '{"sql":"SELECT 1"}' },
  ],
  ["a shell probe without argv", { kind: "shell", spec_json: '{"cmd":"ls"}' }],
  ["a zero timeout", { timeout_ms: 0 }],
  ["a flag other than 0 or 1", { untrusted_output: 2 }],
])("probes refuses %s", async (_, bad) => {
  const db = await dbAt(4);
  expect(await seedRows(db, { probes: [invalid(probe, bad)] })).toMatchObject(
    validation,
  );
});

test("pulse_checks belong to a pulse and name a probe; their state is closed", async () => {
  const db = await spineAt4();
  const check = (
    id: string,
    o: Partial<Insertable<PulseChecksTable>> = {},
  ): Insertable<PulseChecksTable> => ({
    id,
    pulse_id: "p-1",
    name: "budget",
    state: "ok",
    duration_ms: 12,
    result_json: "{}",
    ...o,
  });
  unwrap(
    await seedRows(db, {
      pulses: [pulse("p-1")],
      pulse_checks: [check("c-1"), check("c-2", { state: "timeout" })],
    }),
  );
  expect(
    await seedRows(db, { pulse_checks: [check("c-3", { name: "nope" })] }),
  ).toMatchObject(validation);
  expect(
    await seedRows(db, { pulse_checks: [check("c-3", { pulse_id: "p-9" })] }),
  ).toMatchObject(validation);
  expect(
    await seedRows(db, {
      pulse_checks: [invalid(check("c-3"), { state: "running" })],
    }),
  ).toMatchObject(validation);
});

test("tickets.origin_fingerprint stays unique: a duplicate is refused, while NULLs repeat (§10.2)", async () => {
  const db = await dbAt(4);
  unwrap(
    await seedRows(db, {
      tickets: [
        ticketRow(1, { origin: "probe", origin_fingerprint: "fp-1" }),
        ticketRow(2),
        ticketRow(3),
      ],
    }),
  );
  expect(
    await seedRows(db, {
      tickets: [ticketRow(4, { origin: "probe", origin_fingerprint: "fp-1" })],
    }),
  ).toMatchObject(conflict);
});

test("handoff_pending is any hand-off with accepted_at NULL, at any age and with or without a successor (amendment c)", async () => {
  const db = await dbAt(3);
  unwrap(await seedSpine(db, 3));
  const successor = { to_session_id: SPINE_SEED.sessionId };
  unwrap(
    await seedRows(db, {
      tickets: [ticketRow(1, { status: "building" })],
      handoffs: [
        handoff("new", "ticket-1", {
          accepted_at: null,
          created_at: FAR_FUTURE,
        }),
        handoff("assigned", "ticket-1", { ...successor, accepted_at: null }),
        handoff("accepted", "ticket-1", successor),
      ],
    }),
  );
  // 003 keyed the arm on to_session_id, so "assigned" and "accepted" were not pending.
  expect((await refsFor(db, "handoff_pending")).map((r) => r.ref)).toEqual([
    "new",
  ]);
  unwrap(await migrateUp(db, { to: 4 }));
  expect(await refsFor(db, "handoff_pending")).toEqual([
    { why: "handoff_pending", ref: "assigned", ticket_id: "ticket-1" },
    { why: "handoff_pending", ref: "new", ticket_id: "ticket-1" },
  ]);
});

test("split_candidate: an open, splittable ticket whose hand-offs reached the threshold (amendment i)", async () => {
  const db = await dbAt(4);
  unwrap(
    await seedRows(db, {
      tickets: [
        ticketRow(1, { status: "building" }),
        ticketRow(2, { status: "done" }),
        ticketRow(3, { status: "building", split_depth: 2 }),
        ticketRow(4, { status: "building" }),
        ticketRow(5, { status: "split" }),
      ],
      handoffs: [
        ...chain("ticket-1", 4),
        ...chain("ticket-2", 4),
        ...chain("ticket-3", 4),
        ...chain("ticket-4", 3),
        ...chain("ticket-5", 4),
      ],
    }),
  );
  const candidates = async () =>
    (await refsFor(db, "split_candidate")).map((r) => [r.ref, r.ticket_id]);
  // autosplit.handoff_threshold=4, autosplit.max_depth=2 (002's seeds)
  expect(await candidates()).toEqual([["ticket-1", "ticket-1"]]);
  exec(
    db,
    "UPDATE settings SET value_json = '3' WHERE key = 'autosplit.handoff_threshold'",
  );
  expect(await candidates()).toEqual([
    ["ticket-1", "ticket-1"],
    ["ticket-4", "ticket-4"],
  ]);
  exec(db, "DELETE FROM settings WHERE key = 'autosplit.handoff_threshold'");
  expect(await candidates()).toEqual([]);
});

test("004 down on a seeded database leaves exactly the 003 schema and settings, and keeps the tickets", async () => {
  const db = await dbAt(3);
  unwrap(await seedSpine(db, 3));
  unwrap(await seedRows(db, { tickets: [ticketRow(1)] }));
  const schemaAt3 = dump(db);
  const settingsAt3 = settingsOf(db);
  unwrap(await migrateUp(db, { to: 4 }));
  unwrap(
    await seedRows(db, {
      pulses: [pulse("p-1", { state: "done" })],
      pulse_checks: [
        { id: "c-1", pulse_id: "p-1", name: "budget", state: "ok" },
      ],
    }),
  );
  const status = unwrap(await migrateDown(db));
  expect(status.applied.map((m) => m.version)).toEqual([1, 2, 3]);
  expect(dump(db)).toBe(schemaAt3);
  expect(settingsOf(db)).toEqual(settingsAt3);
  expect(rawOf(db).prepare("SELECT id FROM tickets").all()).toEqual([
    { id: "ticket-1" },
  ]);
});
