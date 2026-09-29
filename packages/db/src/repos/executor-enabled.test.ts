// setExecutorEnabledFromCli, `frm executor disable|enable`'s writer, against a real
// temp database: the column and its audit row in one transaction; live sessions counted, never
// touched; certifications and probes kept, because disabling is not decertifying.
import { FakeClock } from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import { getExecutor } from "../index.js";
import { all, qb, read } from "../connection.js";
import {
  listAudit,
  modelRow,
  newSessionInput,
  seedRows,
  SPINE_SEED,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "../testing.js";
import { setExecutorEnabledFromCli } from "./executor-enabled.js";

const T0 = 1_700_000_000_000;
const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

/** The spine (runner `fixture`, executor `local`, one idle session on it) plus a second executor. */
async function db(): Promise<TempDb> {
  const t = unwrap(await tempDb(new FakeClock(T0)));
  opened.push(t);
  unwrap(await seedSpine(t.db, 1));
  unwrap(
    await seedRows(t.db, {
      executors: [{ id: "spare", kind: "local", config_json: "{}" }],
    }),
  );
  return t;
}

const certifications = (t: TempDb) =>
  read(t.db, (ix) =>
    all(ix, qb.selectFrom("runner_certifications").selectAll()),
  );
const probes = (t: TempDb) =>
  read(t.db, (ix) => all(ix, qb.selectFrom("conformance_probes").selectAll()));

test("disables, counts the live sessions it leaves alone, and audits it via frm", async () => {
  const t = await db();
  expect(
    unwrap(await setExecutorEnabledFromCli(t.db, SPINE_SEED.executorId, false)),
  ).toEqual({ id: "local", enabled: false, changed: true, live: 1 });
  expect(unwrap(await getExecutor(t.db, "local"))).toMatchObject({
    enabled: 0,
  });
  // The session the spine placed on it is untouched: a disable refuses new admissions only.
  const live = unwrap(
    await read(t.db, (ix) =>
      all(ix, qb.selectFrom("sessions").select(["id", "state"])),
    ),
  );
  expect(live).toEqual([{ id: SPINE_SEED.sessionId, state: "idle" }]);
  expect(unwrap(await listAudit(t.db))).toMatchObject([
    {
      ts: T0,
      actor: "operator",
      action: "executor.disable",
      target_kind: "executor",
      target_id: "local",
      payload_json: JSON.stringify({
        via: "frm",
        from: true,
        to: false,
        live: 1,
      }),
    },
  ]);
});

test("enable puts it back, audited as its own action", async () => {
  const t = await db();
  unwrap(await setExecutorEnabledFromCli(t.db, "spare", false));
  expect(unwrap(await setExecutorEnabledFromCli(t.db, "spare", true))).toEqual({
    id: "spare",
    enabled: true,
    changed: true,
    live: 0,
  });
  expect(unwrap(await getExecutor(t.db, "spare"))).toMatchObject({
    enabled: 1,
  });
  expect(unwrap(await listAudit(t.db)).map((a) => a.action)).toEqual([
    "executor.disable",
    "executor.enable",
  ]);
});

test("the state it already has writes nothing and audits nothing, and still counts", async () => {
  const t = await db();
  expect(
    unwrap(await setExecutorEnabledFromCli(t.db, SPINE_SEED.executorId, true)),
  ).toEqual({ id: "local", enabled: true, changed: false, live: 1 });
  expect(unwrap(await listAudit(t.db))).toEqual([]);
  unwrap(await setExecutorEnabledFromCli(t.db, "spare", false));
  expect(unwrap(await setExecutorEnabledFromCli(t.db, "spare", false))).toEqual(
    {
      id: "spare",
      enabled: false,
      changed: false,
      live: 0,
    },
  );
  expect(unwrap(await listAudit(t.db))).toHaveLength(1);
});

test("disabling keeps the certifications and probes: it is not decertifying", async () => {
  const t = await db();
  unwrap(
    await seedRows(t.db, {
      models: [modelRow(SPINE_SEED.runnerId, "cheap")],
      runner_certifications: [
        {
          runner_id: SPINE_SEED.runnerId,
          executor_id: "local",
          model_id: `${SPINE_SEED.runnerId}.cheap`,
          model: `${SPINE_SEED.runnerId}-cheap-model`,
          runner_version: "1",
          suite_version: "1",
          kit_hash: "sha256:kit",
          caps_hash: "sha256:caps",
          result_json: "{}",
          gate_eligible: 1,
          passed_at: T0,
          certified_at: T0,
        },
      ],
      conformance_probes: [
        {
          id: "probe-1",
          token_hash: "hash-1",
          toolset_hash: "sha256:tools",
          runner_id: SPINE_SEED.runnerId,
          executor_id: "local",
          created_at: T0,
          expires_at: T0 + 1_000,
        },
      ],
    }),
  );
  const before = {
    certs: unwrap(await certifications(t)),
    p: unwrap(await probes(t)),
  };
  unwrap(await setExecutorEnabledFromCli(t.db, "local", false));
  expect(unwrap(await certifications(t))).toEqual(before.certs);
  expect(unwrap(await probes(t))).toEqual(before.p);
  expect(unwrap(await certifications(t))).toMatchObject([
    { gate_eligible: 1, passed_at: T0, decertified_at: null },
  ]);
});

test("an ended session on it is not live; a live one on another executor is not counted", async () => {
  const t = await db();
  unwrap(
    await seedRows(t.db, {
      sessions: [
        {
          ...newSessionInput(),
          id: "s-exited",
          executor_id: "local",
          state: "exited",
          created_at: T0,
        },
        {
          ...newSessionInput(),
          id: "s-elsewhere",
          executor_id: "spare",
          state: "running",
          created_at: T0,
        },
      ],
    }),
  );
  expect(
    unwrap(await setExecutorEnabledFromCli(t.db, "local", false)),
  ).toMatchObject({ live: 1 });
  expect(
    unwrap(await setExecutorEnabledFromCli(t.db, "spare", false)),
  ).toMatchObject({ live: 1 });
});

test("an unknown executor is not_found, an unnamed one validation; neither writes", async () => {
  const t = await db();
  expect(await setExecutorEnabledFromCli(t.db, "nobody", false)).toMatchObject({
    ok: false,
    error: { class: "not_found", message: "executor nobody does not exist" },
  });
  expect(await setExecutorEnabledFromCli(t.db, "  ", false)).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect(unwrap(await listAudit(t.db))).toEqual([]);
  expect(unwrap(await getExecutor(t.db, "local"))).toMatchObject({
    enabled: 1,
  });
});
