// The plain-JS files a container executor ships to the docker host (the exec-shim, the gateway's
// /mcp relay) are read at run time next to container.js, from dist/. tsc emits a `.mjs` only when no
// same-named declaration file shadows it: a hand-written `exec-shim.d.mts` once dropped the shim
// from dist/. Their types come from their JSDoc (`// @ts-check`) instead.
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));

test("no declaration file shadows a shipped .mjs, so tsc emits each into dist/", () => {
  const shipped = readdirSync(here).filter((f) => f.endsWith(".mjs"));
  expect(shipped.toSorted()).toEqual(["exec-shim.mjs", "mcp-relay.mjs"]);
  for (const file of shipped) {
    const declaration = file.replace(/\.mjs$/, ".d.mts");
    expect(existsSync(`${here}/${declaration}`), declaration).toBe(false);
  }
});
