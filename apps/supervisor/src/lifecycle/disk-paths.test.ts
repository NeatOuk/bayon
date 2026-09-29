// What the local executor's health measures: FRM_HOME/work and each repo's mirror,
// read from the db on every check.
import { FakeClock } from "@bayon/core";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { afterAll, expect, test } from "vitest";
import { localDiskPaths } from "./disk-paths.js";

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

test("before the db is handed over: the work root alone", async () => {
  expect(await localDiskPaths("/frm", () => undefined)()).toEqual([
    "/frm/work",
  ]);
});

test("the work root and every repo's mirror, a repo added later included", async () => {
  const t = unwrap(await tempDb(new FakeClock(1)));
  cleanups.push(t.cleanup);
  const paths = localDiskPaths("/frm", () => t.db);
  expect(await paths()).toEqual(["/frm/work"]);
  unwrap(
    await seedRows(t.db, {
      repos: [
        { id: "r1", name: "r1", origin_url: null, mirror_path: "/m/r1.git" },
      ],
    }),
  );
  expect(await paths()).toEqual(["/frm/work", "/m/r1.git"]);
});
