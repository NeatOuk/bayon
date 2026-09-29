// A project's tier per step against a real temp database (048): the API's settings write
// (one project.set row naming only the steps that moved; the same values again write nothing) and
// the read a spawn and a gate pick share (bindingModelOn): the role binding's tier, else the
// project's for the step, else the profile's.
import { FakeClock, NO_STEP_TIERS, type ModelStep } from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import {
  SPINE_SEED,
  listAudit,
  modelRow,
  putRoleBinding,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "../testing.js";
import { setProjectSettings } from "./project-settings.js";
import { listProjects } from "./project-reads.js";
import { bindingModelOn } from "./role-models.js";
import { stepTiersOf } from "./step-tiers.js";

const T0 = 1_700_000_000_000;
const PROFILE = "profile-std";
const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

async function fresh() {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  opened.push(t);
  unwrap(await seedSpine(t.db, 1));
  const { runnerId } = SPINE_SEED;
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single" },
        { id: "P-B", name: "P-B", kind: "single" },
      ],
      models: [
        modelRow(runnerId, "complex"),
        modelRow(runnerId, "standard"),
        modelRow(runnerId, "cheap"),
      ],
      profiles: [
        {
          id: PROFILE,
          name: PROFILE,
          runner_id: runnerId,
          model_tier: "standard",
          version: 1,
          hash: "0".repeat(64),
          created_at: 0,
        },
      ],
    }),
  );
  return t.db;
}

const tiersOf = async (db: TempDb["db"]) =>
  Object.fromEntries(
    unwrap(await listProjects(db)).map((p) => [
      p.workspace.id,
      stepTiersOf(p.workspace),
    ]),
  );

const stepAudits = async (db: TempDb["db"]) =>
  unwrap(await listAudit(db))
    .filter((row) => row.action === "project.set")
    .map((row) => JSON.parse(row.payload_json ?? "null") as unknown);

test("step tiers: set, the same again, one changed, one inherited; one project.set row naming only what moved", async () => {
  const db = await fresh();
  expect(await tiersOf(db)).toEqual({
    "P-A": NO_STEP_TIERS,
    "P-B": NO_STEP_TIERS,
  });

  const set = unwrap(
    await setProjectSettings(
      db,
      "P-A",
      { step_tiers: { plan: "complex", build: "standard", review: "complex" } },
      "operator",
    ),
  );
  expect(set).toMatchObject({
    project: "P-A",
    step_tiers: { plan: "complex", build: "standard", review: "complex" },
    changed: true,
  });

  const again = unwrap(
    await setProjectSettings(
      db,
      "P-A",
      { step_tiers: { plan: "complex", review: "complex" } },
      "operator",
    ),
  );
  expect(again.changed).toBe(false);

  const moved = unwrap(
    await setProjectSettings(
      db,
      "P-A",
      { step_tiers: { build: "cheap", review: null } },
      "operator",
    ),
  );
  expect(moved.step_tiers).toEqual({
    plan: "complex",
    build: "cheap",
    review: null,
  });
  expect(await tiersOf(db)).toEqual({
    "P-A": { plan: "complex", build: "cheap", review: null },
    "P-B": NO_STEP_TIERS,
  });
  expect(await stepAudits(db)).toEqual([
    {
      step_tiers: { plan: "complex", build: "standard", review: "complex" },
    },
    { step_tiers: { build: "cheap", review: null } },
  ]);
});

test("another setting's write keeps the step tiers as they are", async () => {
  const db = await fresh();
  unwrap(
    await setProjectSettings(
      db,
      "P-A",
      { step_tiers: { plan: "complex" } },
      "operator",
    ),
  );
  const other = unwrap(
    await setProjectSettings(db, "P-A", { staff_approval: true }, "operator"),
  );
  expect(other.step_tiers).toEqual({ ...NO_STEP_TIERS, plan: "complex" });
  expect((await tiersOf(db))["P-A"]).toEqual({
    ...NO_STEP_TIERS,
    plan: "complex",
  });
});

/** What a builder session on the spine's runner with PROFILE would run in `P-A`'s `step`. */
const modelIn = async (
  db: TempDb["db"],
  step: ModelStep | null,
  workspaceId: string | null = "P-A",
) =>
  unwrap(
    await bindingModelOn(db, "builder", SPINE_SEED.runnerId, PROFILE, {
      workspaceId,
      step,
    }),
  );

test("bindingModelOn: the project's step tier over the profile's; another step, or none, the profile's", async () => {
  const db = await fresh();
  unwrap(
    await setProjectSettings(
      db,
      "P-A",
      { step_tiers: { plan: "complex", review: "cheap" } },
      "operator",
    ),
  );
  const { runnerId } = SPINE_SEED;
  expect(await modelIn(db, "plan")).toMatchObject({
    tier: "complex",
    model: { id: `${runnerId}.complex` },
  });
  expect(await modelIn(db, "review")).toMatchObject({
    tier: "cheap",
    model: { id: `${runnerId}.cheap` },
  });
  // build inherits, a step-less class has no project tier, and so does a spawn with no project or
  // an unknown one: the profile's standard tier each time.
  for (const [step, ws] of [
    ["build", "P-A"],
    [null, "P-A"],
    ["plan", null],
    ["plan", "P-B"],
    ["plan", "no-such-project"],
  ] as const) {
    expect(await modelIn(db, step, ws), `${step} in ${ws}`).toMatchObject({
      tier: "standard",
      model: { id: `${runnerId}.standard` },
    });
  }
  // No step at all: as before 048.
  expect(
    unwrap(await bindingModelOn(db, "builder", runnerId, PROFILE)),
  ).toMatchObject({ tier: "standard" });
});

test("bindingModelOn: a role binding's own tier still wins over the project's step tier", async () => {
  const db = await fresh();
  unwrap(
    await setProjectSettings(
      db,
      "P-A",
      { step_tiers: { plan: "complex" } },
      "operator",
    ),
  );
  unwrap(
    await putRoleBinding(
      db,
      { role: "builder", runner_id: SPINE_SEED.runnerId, model_tier: "cheap" },
      "operator",
    ),
  );
  expect(await modelIn(db, "plan")).toMatchObject({
    tier: "cheap",
    model: { id: `${SPINE_SEED.runnerId}.cheap` },
  });
});

test("bindingModelOn: a step tier with no active model of it is a tier and no model (admission's no_model)", async () => {
  const db = await fresh();
  unwrap(
    await setProjectSettings(
      db,
      "P-A",
      { step_tiers: { build: "complex" } },
      "operator",
    ),
  );
  // A profile for another runner counts for nothing; the step tier still names the tier.
  expect(
    unwrap(
      await bindingModelOn(db, "builder", "no-such-runner", PROFILE, {
        workspaceId: "P-A",
        step: "build",
      }),
    ),
  ).toEqual({ tier: "complex", model: null });
});
