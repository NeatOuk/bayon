// One project's pause against a real temp database: each change written with its audit
// row in one transaction, the same state again writes nothing, a refusal writes nothing, and the
// other projects are never touched.
import { FakeClock } from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import {
  listAudit,
  seedRows,
  tempDb,
  unwrap,
  type TempDb,
} from "../testing.js";
import { getWorkspace } from "./config.js";
import { setProjectPaused } from "./project-pause.js";
import { listProjects } from "./project-reads.js";

const T0 = 1_700_000_000_000;
const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

async function fresh() {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  opened.push(t);
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single" },
        { id: "P-B", name: "P-B", kind: "single" },
      ],
    }),
  );
  return { db: t.db, clock };
}

const pausedOf = async (db: TempDb["db"]) =>
  Object.fromEntries(
    unwrap(await listProjects(db)).map((p) => [
      p.workspace.id,
      p.workspace.paused,
    ]),
  );

test("pause writes workspaces.paused=1 and one project.pause audit row; only that project", async () => {
  const { db, clock } = await fresh();
  expect(await pausedOf(db)).toEqual({ "P-A": 0, "P-B": 0 });
  await clock.advance(5_000);
  expect(unwrap(await setProjectPaused(db, "P-A", true, "operator"))).toEqual({
    project: "P-A",
    paused: true,
    changed: true,
  });
  expect(await pausedOf(db)).toEqual({ "P-A": 1, "P-B": 0 });
  expect(unwrap(await getWorkspace(db, "P-A")).paused).toBe(1);
  expect(unwrap(await listAudit(db))).toMatchObject([
    {
      ts: T0 + 5_000,
      actor: "operator",
      action: "project.pause",
      target_kind: "project",
      target_id: "P-A",
      payload_json: JSON.stringify({ via: "rest" }),
    },
  ]);
});

test("the same state again changes nothing: no write, no audit row", async () => {
  const { db } = await fresh();
  unwrap(await setProjectPaused(db, "P-A", true, "operator"));
  expect(unwrap(await setProjectPaused(db, "P-A", true, "operator"))).toEqual({
    project: "P-A",
    paused: true,
    changed: false,
  });
  // Resuming a project that is not paused is the same no-op.
  expect(unwrap(await setProjectPaused(db, "P-B", false, "operator"))).toEqual({
    project: "P-B",
    paused: false,
    changed: false,
  });
  expect(unwrap(await listAudit(db))).toHaveLength(1);
  expect(await pausedOf(db)).toEqual({ "P-A": 1, "P-B": 0 });
});

test("resume writes 0 and project.resume", async () => {
  const { db, clock } = await fresh();
  unwrap(await setProjectPaused(db, "P-A", true, "operator"));
  await clock.advance(2_000);
  expect(unwrap(await setProjectPaused(db, "P-A", false, "operator"))).toEqual({
    project: "P-A",
    paused: false,
    changed: true,
  });
  expect(await pausedOf(db)).toEqual({ "P-A": 0, "P-B": 0 });
  expect(
    unwrap(await listAudit(db)).map((a) => [a.ts, a.action, a.target_id]),
  ).toEqual([
    [T0, "project.pause", "P-A"],
    [T0 + 2_000, "project.resume", "P-A"],
  ]);
});

test("an unknown project is not_found and an empty actor is refused; neither writes anything", async () => {
  const { db } = await fresh();
  expect(await setProjectPaused(db, "P-X", true, "operator")).toMatchObject({
    ok: false,
    error: { class: "not_found", message: "project P-X does not exist" },
  });
  expect(await setProjectPaused(db, "P-A", true, " ")).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect(unwrap(await listAudit(db))).toEqual([]);
  expect(await pausedOf(db)).toEqual({ "P-A": 0, "P-B": 0 });
});
