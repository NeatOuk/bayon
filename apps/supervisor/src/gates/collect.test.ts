// Reading a reviewer's output file back through the executor: cat
// must exit 0, and the read stops at MAX_REVIEW_OUTPUT_CHARS + 1, killing cat, so an oversized
// output is never held whole in memory; the gate then fails reviewer_error.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, MAX_REVIEW_OUTPUT_CHARS } from "@bayon/core";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { afterAll, expect, test } from "vitest";
import type { ExecCtx } from "../lifecycle/exec.js";
import { DEFAULT_SETTINGS } from "../lifecycle/settings.js";
import { readReviewFile } from "./collect.js";

const dir = mkdtempSync(join(tmpdir(), "frm-collect-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const exec: ExecCtx = {
  settings: DEFAULT_SETTINGS,
  clock: new FakeClock(1_700_000_000_000),
  frmHome: dir,
  path: process.env["PATH"] ?? "/usr/bin:/bin",
  log: quiet,
};
const executor = new LocalExecutor({ id: "local", slots: new SlotCounter(2) });

test("a review file within the cap is read whole", async () => {
  const file = join(dir, "ok.json");
  writeFileSync(file, '{"summary":"fine","findings":[]}');
  expect(await readReviewFile(exec, executor, file)).toEqual({
    ok: true,
    value: '{"summary":"fine","findings":[]}',
  });
});

test("an oversized review file stops the read at the cap: a validation error, never the whole file", async () => {
  const file = join(dir, "big.json");
  writeFileSync(file, "x".repeat(MAX_REVIEW_OUTPUT_CHARS * 3));
  const read = await readReviewFile(exec, executor, file);
  expect(read).toMatchObject({
    ok: false,
    error: {
      class: "validation",
      message: expect.stringContaining(`over the ${MAX_REVIEW_OUTPUT_CHARS}`),
    },
  });
});

test("a missing review file is runner_error: cat did not exit 0", async () => {
  expect(
    await readReviewFile(exec, executor, join(dir, "missing.json")),
  ).toMatchObject({ ok: false, error: { class: "runner_error" } });
});
