import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

// CLAUDE.md Invariant 1: no runner or provider names outside packages/runners/<adapter>. This
// guards packages/db, migrations included: runner and model rows come from registration().
const db = new URL("packages/db/", import.meta.url);
const SKIP = new Set(["node_modules", "dist", "coverage"]);
const RUNNER_NAMES =
  /claude|codex|anthropic|gemini|openai|ollama|opencode|qwen|gpt-oss|openrouter/i;

function filesUnder(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    return entry.isDirectory()
      ? filesUnder(new URL(`${entry.name}/`, dir))
      : [new URL(entry.name, dir)];
  });
}

test("the detector catches a planted runner name", () => {
  expect(
    RUNNER_NAMES.test("id TEXT PRIMARY KEY, -- 'Claude-sdk','codex-exec'"),
  ).toBe(true);
  expect(RUNNER_NAMES.test("'ANTHROPIC_API_KEY'")).toBe(true);
  // The open-weight and gateway names.
  for (const name of [
    "OPENAI_API_KEY",
    "ollama",
    "OpenCode",
    "qwen3-coder",
    "gpt-oss-20b",
    "openrouter/auto",
  ])
    expect(RUNNER_NAMES.test(name), name).toBe(true);
  expect(RUNNER_NAMES.test("-- adapter-defined id, from registration()")).toBe(
    false,
  );
});

test("no runner names anywhere in packages/db, migrations included", () => {
  const files = filesUnder(db);
  expect(files.some((file) => file.pathname.endsWith(".sql"))).toBe(true);
  expect(files.some((file) => file.pathname.endsWith("package.json"))).toBe(
    true,
  );
  const offenders = files
    .filter((file) => RUNNER_NAMES.test(readFileSync(file, "utf8")))
    .map((file) => file.pathname.slice(db.pathname.length));
  expect(offenders).toEqual([]);
});
