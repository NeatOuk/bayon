import { FakeClock, TEMPLATES, templateRecord } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { tempDb, unwrap } from "../testing.js";
import {
  getPromptTemplate,
  upsertPromptTemplates,
  type NewPromptTemplate,
} from "./prompt-templates.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());

const template = (
  name: string,
  version: number,
  hash = "a".repeat(64),
): NewPromptTemplate => ({
  id: `${name}.v${version}`,
  name,
  version,
  body: `the ${name} body`,
  hash,
  section_order_json: '[{"name":"task"}]',
  budget_json: '{"truncation_order":[]}',
});

test("inserts every template, stamped by the clock", async () => {
  const rows = [template("build", 1), template("pulse", 1)];
  unwrap(await upsertPromptTemplates(t.db, rows));
  for (const row of rows) {
    expect(unwrap(await getPromptTemplate(t.db, row.id))).toEqual({
      ...row,
      created_at: T0,
    });
  }
});

test("the same templates again, as at every boot, change nothing", async () => {
  const row = template("spike", 1);
  unwrap(await upsertPromptTemplates(t.db, [row]));
  unwrap(await upsertPromptTemplates(t.db, [row]));
  expect(unwrap(await getPromptTemplate(t.db, row.id))).toEqual({
    ...row,
    created_at: T0,
  });
});

test("a stored template under another hash is a conflict, and nothing of the batch is written", async () => {
  unwrap(await upsertPromptTemplates(t.db, [template("fix", 1)]));
  const edited = template("fix", 1, "b".repeat(64));
  expect(
    await upsertPromptTemplates(t.db, [template("review", 1), edited]),
  ).toMatchObject({
    ok: false,
    error: {
      class: "conflict",
      message:
        "prompt template fix.v1 is stored with another hash: bump its version",
    },
  });
  expect(await getPromptTemplate(t.db, "review.v1")).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
  expect(unwrap(await getPromptTemplate(t.db, "fix.v1")).hash).toBe(
    "a".repeat(64),
  );
});

test("a database holding pulse.v1 boots with every current template: v1 stays as stored, the current version beside it", async () => {
  const v1 = {
    ...template("pulse", 1),
    hash: "3ff26d0556ae7a9274c902d75a09b09e4d55573b6416073fff2ceec9881ae205",
  };
  const db = unwrap(await tempDb(clock));
  try {
    unwrap(await upsertPromptTemplates(db.db, [v1]));
    const current = await Promise.all(
      Object.values(TEMPLATES).map(templateRecord),
    );
    unwrap(await upsertPromptTemplates(db.db, current));
    expect(unwrap(await getPromptTemplate(db.db, "pulse.v1")).hash).toBe(
      v1.hash,
    );
    const { version } = TEMPLATES.pulse;
    expect(version).toBeGreaterThan(1);
    expect(
      unwrap(await getPromptTemplate(db.db, `pulse.v${String(version)}`))
        .version,
    ).toBe(version);
  } finally {
    db.cleanup();
  }
});

test("a new version is a new row beside the old one", async () => {
  unwrap(await upsertPromptTemplates(t.db, [template("operator", 1)]));
  unwrap(
    await upsertPromptTemplates(t.db, [
      template("operator", 2, "c".repeat(64)),
    ]),
  );
  expect(unwrap(await getPromptTemplate(t.db, "operator.v1")).version).toBe(1);
  expect(unwrap(await getPromptTemplate(t.db, "operator.v2")).hash).toBe(
    "c".repeat(64),
  );
});
