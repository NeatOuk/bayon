import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  SPINE_SEED,
  listAudit,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import { getAgent } from "./config.js";
import { setPulsePolicy } from "./pulse-policy.js";

const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
unwrap(await seedSpine(t.db, 4));
afterAll(() => t.cleanup());

const audit = (target: string) => ({
  actor: "operator",
  action: "rest.pulse_policy",
  target_kind: "agent",
  target_id: target,
});

test("setPulsePolicy sets only the given pulse_* columns and commits its audit row with them", async () => {
  const before = unwrap(await getAgent(t.db, SPINE_SEED.agentId));
  const auditBefore = unwrap(await listAudit(t.db)).length;
  const row = unwrap(
    await setPulsePolicy(
      t.db,
      SPINE_SEED.agentId,
      { mode: "interval", interval_ms: 600_000, jitter_pct: 0 },
      audit(SPINE_SEED.agentId),
    ),
  );
  expect(row).toEqual({
    ...before,
    pulse_mode: "interval",
    pulse_interval_ms: 600_000,
    pulse_jitter_pct: 0,
  });
  expect(unwrap(await getAgent(t.db, SPINE_SEED.agentId))).toEqual(row);
  const rows = unwrap(await listAudit(t.db));
  expect(rows).toHaveLength(auditBefore + 1);
  expect(rows.at(-1)).toMatchObject(audit(SPINE_SEED.agentId));
});

test("an unknown agent is not_found, and its audit row rolls back with it", async () => {
  const auditBefore = unwrap(await listAudit(t.db)).length;
  expect(
    await setPulsePolicy(t.db, "nobody", { mode: "manual" }, audit("nobody")),
  ).toMatchObject({ ok: false, error: { class: "not_found" } });
  expect(unwrap(await listAudit(t.db))).toHaveLength(auditBefore);
});

test("an empty change, a negative, zero or fractional value is a validation error", async () => {
  for (const bad of [
    {},
    { debounce_ms: -1 },
    { interval_ms: 0 },
    { max_per_hour: 1.5 },
    { jitter_pct: 101 },
  ]) {
    expect(
      await setPulsePolicy(t.db, SPINE_SEED.agentId, bad),
      JSON.stringify(bad),
    ).toMatchObject({ ok: false, error: { class: "validation" } });
  }
});
