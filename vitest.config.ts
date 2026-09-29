import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defaultClientConditions, defaultServerConditions } from "vite";
import { configDefaults, defineConfig } from "vitest/config";

// Every packages/* export map lists "@bayon/source" (./src/index.ts) ahead of "types"/"default"
// (./dist). Resolving that condition makes tests import the sources, never a stale dist/.
// Setting conditions replaces Vitest's defaults, so they are kept ("module" off, as Vitest does).
const SOURCE = "@bayon/source";
const conditions = [
  SOURCE,
  ...defaultServerConditions.filter((condition) => condition !== "module"),
];
const WEB_SRC = "apps/web/src";

export default defineConfig({
  ssr: { resolve: { conditions } },
  test: {
    // tsc also compiles tests into dist/; run only the sources.
    exclude: [...configDefaults.exclude, "**/dist/**"],
    coverage: {
      provider: "v8",
      include: ["{apps,packages,tools}/*/src/**/*.{ts,tsx}"],
      // fixtures.ts: builders for tests, not product code.
      exclude: ["**/*.test.{ts,tsx}", "**/fixtures.ts", `${WEB_SRC}/test/**`],
      reporter: [["text", { skipFull: false }]],
      thresholds: {
        "packages/core/src/events/**": { branches: 100 },
        "packages/core/src/hash/**": { branches: 100 },
        "packages/core/src/laws/**": { branches: 100 },
        "packages/core/src/complexity/**": { branches: 100 },
        "packages/core/src/context/**": { branches: 100 },
        "packages/core/src/tickets/**": { branches: 100 },
        "packages/core/src/prompt/**": { branches: 100 },
        "packages/core/src/gates/**": { branches: 100 },
        "packages/core/src/conformance.ts": { branches: 100 },
        "packages/core/src/admission.ts": { branches: 100 },
        "packages/core/src/jira/**": { branches: 100 },
        "packages/core/src/model-steps.ts": { branches: 100 },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          exclude: [`${WEB_SRC}/**`],
          // A stand-in `security` first on PATH: no test reaches the real Keychain.
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        // The browser app: jsdom, React, the "@/" alias of its tsconfig, browser export conditions.
        extends: true,
        plugins: [react()],
        resolve: {
          alias: {
            "@": fileURLToPath(new URL(`./${WEB_SRC}`, import.meta.url)),
          },
          conditions: [SOURCE, ...defaultClientConditions],
        },
        test: {
          name: "web",
          environment: "jsdom",
          include: [`${WEB_SRC}/**/*.test.{ts,tsx}`],
          setupFiles: [`${WEB_SRC}/test/setup.ts`],
          // CSS imports are empty in tests, `?raw` ones included; let those carry their text (the
          // Tabs test compiles theme.css with Tailwind).
          css: { include: [/\.css\?raw$/] },
        },
      },
    ],
  },
});
