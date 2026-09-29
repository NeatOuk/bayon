import { FakeClock } from "@bayon/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  SPINE_SEED,
  listAudit,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "../testing.js";
import { listRoleBindings } from "./gates.js";
import { putRoleBinding } from "./role-bindings.js";

// PUT /role-bindings' writer (§9.8): ids from rows, one role per call, audited; no certification.

let t: TempDb;
beforeEach(async () => {
  t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(t.db, 8));
  unwrap(
    await seedRows(t.db, {
      runners: [
        { id: "other", kind: "script", adapter: "fixture", caps_json: "{}" },
      ],
    }),
  );
});
afterEach(() => t.cleanup());

test("a binding upserts, round-trips, and is audited", async () => {
  unwrap(
    await putRoleBinding(
      t.db,
      {
        role: "code_reviewer",
        runner_id: "other",
        require_distinct_from: "builder",
      },
      "operator",
    ),
  );
  const row = unwrap(
    await putRoleBinding(
      t.db,
      {
        role: "code_reviewer",
        runner_id: SPINE_SEED.runnerId,
        fallback_runner_id: "other",
        executor_id: SPINE_SEED.executorId,
      },
      "operator",
    ),
  );
  expect(row).toMatchObject({
    role: "code_reviewer",
    runner_id: SPINE_SEED.runnerId,
    fallback_runner_id: "other",
    executor_id: SPINE_SEED.executorId,
    require_distinct_from: null,
    updated_by: "operator",
    updated_at: 1_700_000_000_000,
  });
  expect(unwrap(await listRoleBindings(t.db))).toEqual([row]);
  const audit = unwrap(await listAudit(t.db));
  expect(audit.map((a) => [a.actor, a.action, a.target_id])).toEqual([
    ["operator", "role_binding.put", "code_reviewer"],
    ["operator", "role_binding.put", "code_reviewer"],
  ]);
});

test("an uncertified runner is accepted: pickReviewer checks certification when a gate runs", async () => {
  expect(
    (
      await putRoleBinding(
        t.db,
        { role: "plan_reviewer", runner_id: "other" },
        "operator",
      )
    ).ok,
  ).toBe(true);
});

test.each<[string, Parameters<typeof putRoleBinding>[1], string]>([
  ["an unknown runner", { role: "builder", runner_id: "ghost" }, "not_found"],
  [
    "an unknown fallback",
    { role: "builder", runner_id: "other", fallback_runner_id: "ghost" },
    "not_found",
  ],
  [
    "an unknown executor",
    { role: "builder", runner_id: "other", executor_id: "ghost" },
    "not_found",
  ],
  [
    "an unknown profile",
    { role: "builder", runner_id: "other", profile_id: "ghost" },
    "not_found",
  ],
  [
    "a fallback equal to the runner",
    { role: "builder", runner_id: "other", fallback_runner_id: "other" },
    "validation",
  ],
  ["an unknown role", { role: "wizard", runner_id: "other" }, "validation"],
  [
    "require_distinct_from naming no role",
    {
      role: "code_reviewer",
      runner_id: "other",
      require_distinct_from: "wizard",
    },
    "validation",
  ],
])("%s is refused and writes nothing", async (_name, b, cls) => {
  expect(await putRoleBinding(t.db, b, "operator")).toMatchObject({
    ok: false,
    error: { class: cls },
  });
  expect(unwrap(await listRoleBindings(t.db))).toEqual([]);
  expect(unwrap(await listAudit(t.db))).toEqual([]);
});

test("a blank actor is refused", async () => {
  expect(
    await putRoleBinding(t.db, { role: "builder", runner_id: "other" }, " "),
  ).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});
