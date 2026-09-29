import { FakeClock, ok } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { execute, qb, write } from "../connection.js";
import { tempDb, unwrap } from "../testing.js";
import { listMissionsForExport } from "./exports-read.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());

async function mission(agent: string, version: number) {
  await write(t.db, (ix) => {
    execute(
      ix,
      qb.insertInto("missions").values({
        id: `mission-${agent}-${version}`,
        agent_name: agent,
        version,
        who_md: "who",
        what_md: "what",
        how_md: "how",
        laws_md: "laws",
        rendered_md: "rendered",
        hash: `hash-${version}`,
        created_at: clock.now(),
        created_by: "operator",
      }),
    );
    return ok(undefined);
  });
}

test("listMissionsForExport orders by agent then version", async () => {
  await mission("builder", 2);
  await mission("builder", 1);
  await mission("orchestrator", 1);
  const rows = unwrap(await listMissionsForExport(t.db));
  expect(rows.map((r) => [r.agent_name, r.version])).toEqual([
    ["builder", 1],
    ["builder", 2],
    ["orchestrator", 1],
  ]);
});
