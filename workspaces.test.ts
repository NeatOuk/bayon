import { existsSync, readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

// The workspace layout from CLAUDE.md. Every workspace must exist, be built by the root `tsc -b`
// (a reference in tsconfig.json), carry its @bayon/ name, and export at least one type.
const LAYOUT = [
  "apps/api",
  "apps/supervisor",
  "apps/web",
  "packages/core",
  "packages/db",
  "packages/executors",
  "packages/proto",
  "packages/runners",
  "tools/frm",
];
const root = new URL("./", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

test("workspaces match the CLAUDE.md layout and are all wired", () => {
  const found = ["apps", "packages", "tools"].flatMap((dir) =>
    readdirSync(new URL(`${dir}/`, root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${dir}/${entry.name}`),
  );
  expect(found.sort()).toEqual(LAYOUT);

  const references = [
    ...read("tsconfig.json").matchAll(/"path":\s*"(?:\.\/)?([^"]+)"/g),
  ].map((m) => m[1]);
  expect(references.sort()).toEqual(LAYOUT);

  for (const dir of LAYOUT) {
    expect(JSON.parse(read(`${dir}/package.json`)).name).toBe(
      `@bayon/${dir.split("/")[1]}`,
    );
    expect(existsSync(new URL(`${dir}/tsconfig.json`, root))).toBe(true);
    expect(read(`${dir}/src/index.ts`)).toMatch(/^export (type|interface) /m);
  }
});

// vitest.config.ts resolves "@bayon/source", so tests import sources instead of a stale dist/.
// It has to come first: the first matching condition in an export map wins.
test("every package exports its sources under @bayon/source, ahead of dist", () => {
  for (const dir of LAYOUT.filter((d) => d.startsWith("packages/"))) {
    const exports = JSON.parse(read(`${dir}/package.json`)).exports["."];
    expect(Object.entries(exports)).toEqual([
      ["@bayon/source", "./src/index.ts"],
      ["types", "./dist/index.d.ts"],
      ["default", "./dist/index.js"],
    ]);
  }
});
