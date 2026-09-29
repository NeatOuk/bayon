// CI checks as a project's QA source through the one settings door, against a real temp
// database: `ci` needs delivery to open a pull request when review passes. The refusal is core's
// one sentence, on the QA change that asks for it and on the delivery change that would take it
// away, and a refusal writes nothing — neither the columns nor a `project.set` row.
import {
  FakeClock,
  NO_QA_CONFIG,
  QA_CI_NEEDS_PR,
  type DeliveryConfigFields,
  type QaConfigFields,
} from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import {
  dumpAllRows,
  listAudit,
  seedRows,
  tempDb,
  unwrap,
  type TempDb,
} from "../testing.js";
import { setProjectSettings } from "./project-settings.js";

const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

const PR: DeliveryConfigFields = {
  mode: "pull_request",
  when: "review_passed",
  close_on_merge: true,
};

const CI: QaConfigFields = {
  ...NO_QA_CONFIG,
  mode: "ci",
  ci_checks: ["build", "test"],
  ci_timeout_ms: 1_800_000,
};

async function fresh(delivery: Partial<DeliveryConfigFields> = {}) {
  const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  opened.push(t);
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        {
          id: "P",
          name: "P",
          kind: "single",
          delivery_mode: delivery.mode ?? "none",
          delivery_when: delivery.when ?? "review_passed",
        },
      ],
    }),
  );
  return t.db;
}

const workspace = async (db: TempDb["db"]) =>
  (
    unwrap(await dumpAllRows(db)).workspaces as {
      qa_mode: string;
      qa_ci_checks_json: string | null;
      qa_ci_timeout_ms: number | null;
      delivery_mode: string;
    }[]
  )[0];

const projectSets = async (db: TempDb["db"]) =>
  unwrap(await listAudit(db))
    .filter((a) => a.action === "project.set")
    .map((a) => JSON.parse(a.payload_json ?? "{}") as unknown);

test("ci without pull requests at review is refused with the one sentence, and writes nothing", async () => {
  for (const delivery of [
    {},
    { mode: "push" as const },
    { mode: "pull_request" as const, when: "done" as const },
  ]) {
    const db = await fresh(delivery);
    const set = await setProjectSettings(db, "P", { qa: CI }, "operator");
    expect(set.ok ? null : set.error).toMatchObject({
      class: "validation",
      message: QA_CI_NEEDS_PR,
    });
    expect((await workspace(db))?.qa_mode).toBe("none");
    expect(await projectSets(db)).toEqual([]);
  }
});

test("ci beside pull requests at review is stored with its checks and wait, and audited", async () => {
  const db = await fresh({ mode: "pull_request" });
  const set = unwrap(await setProjectSettings(db, "P", { qa: CI }, "operator"));
  expect(set).toMatchObject({ changed: true, qa: CI });
  expect(await workspace(db)).toMatchObject({
    qa_mode: "ci",
    qa_ci_checks_json: '["build","test"]',
    qa_ci_timeout_ms: 1_800_000,
  });
  expect(await projectSets(db)).toEqual([
    {
      qa: {
        mode: "ci",
        cmd: null,
        timeout_ms: null,
        secrets: [],
        reports: [],
        junit: null,
        ci_checks: ["build", "test"],
        ci_timeout_ms: 1_800_000,
      },
    },
  ]);
  // The same again changes nothing; a new required name is a change.
  expect(
    unwrap(await setProjectSettings(db, "P", { qa: CI }, "operator")).changed,
  ).toBe(false);
  expect(
    unwrap(
      await setProjectSettings(
        db,
        "P",
        { qa: { ...CI, ci_checks: ["build"] } },
        "operator",
      ),
    ).changed,
  ).toBe(true);
});

test("delivery cannot be moved away from pull requests at review while QA is ci", async () => {
  const db = await fresh({ mode: "pull_request" });
  unwrap(await setProjectSettings(db, "P", { qa: CI }, "operator"));
  for (const delivery of [
    { ...PR, mode: "push" as const },
    { ...PR, mode: "none" as const },
    { ...PR, when: "done" as const },
  ]) {
    const set = await setProjectSettings(db, "P", { delivery }, "operator");
    expect(set.ok ? null : set.error.message).toBe(QA_CI_NEEDS_PR);
  }
  expect((await workspace(db))?.delivery_mode).toBe("pull_request");
  // Both in one call is the way out: QA off, and then delivery may go.
  const both = unwrap(
    await setProjectSettings(
      db,
      "P",
      { qa: NO_QA_CONFIG, delivery: { ...PR, mode: "push" } },
      "operator",
    ),
  );
  expect(both).toMatchObject({
    qa: { mode: "none" },
    delivery: { mode: "push" },
  });
});

// Review CRITICAL 1: a required entry may name one repo's check as `<repo_id>:<name>`. A prefix that
// is no repo of the project is refused in one sentence, which says how to require a check whose
// own name has a colon; a prefix that could not be a repo id is simply part of the name.
test("a required check's repo prefix must be one of the project's repos", async () => {
  const db = await fresh({ mode: "pull_request" });
  unwrap(
    await seedRows(db, {
      repos: [
        { id: "web", name: "web", mirror_path: "/m/web.git" },
        { id: "api", name: "api", mirror_path: "/m/api.git" },
      ],
      workspace_repos: [
        { workspace_id: "P", repo_id: "web", rel_path: "web", role: "primary" },
        { workspace_id: "P", repo_id: "api", rel_path: "api", role: "dep" },
      ],
    }),
  );
  const refused = await setProjectSettings(
    db,
    "P",
    { qa: { ...CI, ci_checks: ["build", "lint:eslint"] } },
    "operator",
  );
  expect(refused.ok ? null : refused.error).toMatchObject({
    class: "validation",
    message:
      "The required check “lint:eslint” reads as repo “lint”, which is not one of this project's repos (api, web): to require a check whose name has a colon, put its repo first, as “api:lint:eslint”.",
  });
  expect(await projectSets(db)).toEqual([]);
  const kept = unwrap(
    await setProjectSettings(
      db,
      "P",
      {
        qa: {
          ...CI,
          ci_checks: ["build", "web:e2e", "api:lint:eslint", "ci/x: y"],
        },
      },
      "operator",
    ),
  );
  expect(kept.qa.ci_checks).toEqual([
    "build",
    "web:e2e",
    "api:lint:eslint",
    "ci/x: y",
  ]);
});
