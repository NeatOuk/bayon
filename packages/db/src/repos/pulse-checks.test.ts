import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import type { Db } from "../connection.js";
import {
  SPINE_SEED,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "../testing.js";
import { insertPulseChecks } from "./pulse-checks.js";
import { listPulseChecks } from "./pulses.js";
import { listRepos } from "./registry-reads.js";
import { findTicketByFingerprint } from "./tickets.js";

// writer and reads: pulse_checks (the supervisor's), a ticket by its probe
// fingerprint, and the repos a mirrors probe runs in.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

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
    }),
  );
  return t.db;
}

const check = (name: string) => ({
  name,
  state: "ok" as const,
  duration_ms: 3,
  result_json: '{"untrusted":false,"findings":[]}',
  result_path: null,
  error: null,
});

test("insertPulseChecks records each result against the pulse, in one transaction", async () => {
  const db = await seeded();
  const rows = unwrap(
    await insertPulseChecks(db, "p-1", [check("budget"), check("log_scan")]),
  );
  expect(rows.map((r) => [r.pulse_id, r.name])).toEqual([
    ["p-1", "budget"],
    ["p-1", "log_scan"],
  ]);
  const listed = unwrap(await listPulseChecks(db, "p-1"));
  expect(listed.map((r) => r.name).toSorted()).toEqual(["budget", "log_scan"]);
  expect(listed.every((r) => r.id.length === 26)).toBe(true);
});

test("nothing to record writes nothing; a bad row rolls the whole batch back", async () => {
  const db = await seeded();
  expect(unwrap(await insertPulseChecks(db, "p-1", []))).toEqual([]);
  expect(
    await insertPulseChecks(db, "p-1", [
      check("budget"),
      check("no_such_probe"),
    ]),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(
    await insertPulseChecks(db, "no-such-pulse", [check("budget")]),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(unwrap(await listPulseChecks(db, "p-1"))).toEqual([]);
});

test("findTicketByFingerprint finds the ticket a fingerprint filed, else null", async () => {
  const db = await seeded();
  unwrap(
    await seedRows(db, {
      tickets: [
        ticketRow(1, { origin: "probe", origin_fingerprint: "fp-1" }),
        ticketRow(2),
      ],
    }),
  );
  expect(unwrap(await findTicketByFingerprint(db, "fp-1"))?.id).toBe(
    "ticket-1",
  );
  expect(unwrap(await findTicketByFingerprint(db, "fp-2"))).toBeNull();
});

test("listRepos lists every repo by name", async () => {
  const db = await seeded();
  unwrap(
    await seedRows(db, {
      repos: [
        { id: "r-2", name: "zeta", mirror_path: "/m/zeta" },
        { id: "r-1", name: "alpha", mirror_path: "/m/alpha" },
      ],
    }),
  );
  expect(unwrap(await listRepos(db)).map((r) => r.name)).toEqual([
    "alpha",
    "zeta",
  ]);
});
