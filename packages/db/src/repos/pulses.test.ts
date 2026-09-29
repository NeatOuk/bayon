import { FakeClock } from "@bayon/core";
import type { Insertable } from "kysely";
import { afterAll, expect, test } from "vitest";
import type { Db } from "../connection.js";
import type { PulsesTable } from "../schema-pulse.js";
import { SPINE_SEED, seedRows, seedSpine, tempDb, unwrap } from "../testing.js";
import {
  findLivePulse,
  findPulseBySession,
  getProbe,
  getPulse,
  listProbes,
  listPulseChecks,
  listPulses,
} from "./pulses.js";

// The 004 pulse reads (M2). Their writers come with the scheduler and probe runner.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

const OTHER_AGENT = "agent-orch";

async function seeded(): Promise<Db> {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 4));
  unwrap(
    await seedRows(t.db, {
      agents: [
        {
          id: OTHER_AGENT,
          name: "orch",
          kind: "orchestrator",
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          created_at: 0,
        },
      ],
    }),
  );
  return t.db;
}

const ended = (
  id: string,
  scheduled_at: number,
  o: Partial<Insertable<PulsesTable>> = {},
): Insertable<PulsesTable> => ({
  id,
  agent_id: SPINE_SEED.agentId,
  trigger: "cron",
  scheduled_at,
  state: "done",
  ...o,
});

test("getPulse and getProbe read one row; a missing one is not_found", async () => {
  const db = await seeded();
  unwrap(await seedRows(db, { pulses: [ended("p-1", 1)] }));
  expect(unwrap(await getPulse(db, "p-1"))).toMatchObject({
    id: "p-1",
    state: "done",
    trigger: "cron",
  });
  expect(unwrap(await getProbe(db, "log_scan"))).toMatchObject({
    kind: "shell",
    untrusted_output: 1,
  });
  const notFound = { ok: false, error: { class: "not_found" } };
  expect(await getPulse(db, "nope")).toMatchObject(notFound);
  expect(await getProbe(db, "nope")).toMatchObject(notFound);
});

test("findLivePulse is the agent's leased or running pulse, else null", async () => {
  const db = await seeded();
  unwrap(await seedRows(db, { pulses: [ended("p-1", 1)] }));
  expect(unwrap(await findLivePulse(db, SPINE_SEED.agentId))).toBeNull();
  unwrap(
    await seedRows(db, {
      pulses: [
        ended("p-2", 2, {
          state: "running",
          lease_token: "t",
          lease_expires_at: 9,
        }),
      ],
    }),
  );
  expect(unwrap(await findLivePulse(db, SPINE_SEED.agentId))?.id).toBe("p-2");
  expect(unwrap(await findLivePulse(db, OTHER_AGENT))).toBeNull();
});

test("findPulseBySession is the pulse a session runs, else null", async () => {
  const db = await seeded();
  unwrap(
    await seedRows(db, {
      pulses: [ended("p-1", 1, { session_id: SPINE_SEED.sessionId })],
    }),
  );
  expect(unwrap(await findPulseBySession(db, SPINE_SEED.sessionId))?.id).toBe(
    "p-1",
  );
  expect(unwrap(await findPulseBySession(db, "other"))).toBeNull();
});

test("listPulses is newest first, one agent's when asked, and bounded", async () => {
  const db = await seeded();
  unwrap(
    await seedRows(db, {
      pulses: [
        ended("p-a", 1),
        ended("p-c", 3),
        ended("p-b", 2),
        ended("p-o", 4, { agent_id: OTHER_AGENT }),
      ],
    }),
  );
  const ids = async (q: Parameters<typeof listPulses>[1]) =>
    unwrap(await listPulses(db, q)).map((p) => p.id);
  expect(await ids({ limit: 10 })).toEqual(["p-o", "p-c", "p-b", "p-a"]);
  expect(await ids({ agent_id: SPINE_SEED.agentId, limit: 2 })).toEqual([
    "p-c",
    "p-b",
  ]);
  expect(await listPulses(db, { limit: 0 })).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("listProbes is by name; enabledOnly leaves the disabled ones out", async () => {
  const db = await seeded();
  unwrap(
    await seedRows(db, {
      probes: [
        { name: "zz_off", kind: "sql", spec_json: '{"query":"x"}', enabled: 0 },
      ],
    }),
  );
  const all = unwrap(await listProbes(db)).map((p) => p.name);
  expect(all).toEqual([
    "budget",
    "gate_health",
    "handoff_pending",
    "log_scan",
    "merged_prs",
    "stale_sessions",
    "zz_off",
  ]);
  expect(
    unwrap(await listProbes(db, { enabledOnly: true })).map((p) => p.name),
  ).toEqual(all.filter((name) => name !== "zz_off"));
});

test("listPulseChecks is one pulse's checks in id order", async () => {
  const db = await seeded();
  const check = (id: string, pulse_id: string) => ({
    id,
    pulse_id,
    name: "budget",
    state: "ok" as const,
  });
  unwrap(
    await seedRows(db, {
      pulses: [ended("p-1", 1), ended("p-2", 2)],
      pulse_checks: [
        check("c-2", "p-1"),
        check("c-1", "p-1"),
        check("c-x", "p-2"),
      ],
    }),
  );
  expect(unwrap(await listPulseChecks(db, "p-1")).map((c) => c.id)).toEqual([
    "c-1",
    "c-2",
  ]);
  expect(unwrap(await listPulseChecks(db, "p-9"))).toEqual([]);
});
