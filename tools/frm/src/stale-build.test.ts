// The stale-build notice: a dist/ older than its src/ says so, once, and only in a source checkout.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  STALE_BUILD_NOTICE,
  isStale,
  newestMtimeMs,
  staleBuildNotice,
  type WalkFs,
} from "./stale-build.js";

const dir = mkdtempSync(join(tmpdir(), "frm-stale-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("isStale", () => {
  test("a source newer than every built file is stale", () => {
    expect(isStale({ newestSourceMs: 2_000, newestBuiltMs: 1_000 })).toBe(true);
  });

  test("a build newer than, or as new as, every source is not", () => {
    expect(isStale({ newestSourceMs: 1_000, newestBuiltMs: 2_000 })).toBe(
      false,
    );
    expect(isStale({ newestSourceMs: 1_000, newestBuiltMs: 1_000 })).toBe(
      false,
    );
  });

  test("no source (an installed build) or no build says nothing", () => {
    expect(isStale({ newestSourceMs: null, newestBuiltMs: 1_000 })).toBe(false);
    expect(isStale({ newestSourceMs: 1_000, newestBuiltMs: null })).toBe(false);
  });
});

/** A checkout: src/ and dist/ side by side, each file at the mtime (seconds) given. */
function checkout(
  name: string,
  files: Readonly<Record<string, number>>,
): string {
  const root = join(dir, name);
  for (const [path, seconds] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "");
    utimesSync(file, seconds, seconds);
  }
  return root;
}

describe("newestMtimeMs", () => {
  test("walks subdirectories and skips what the filter refuses", () => {
    const root = checkout("walk", {
      "src/a.ts": 100,
      "src/smoke/b.ts": 300,
      "src/c.test.ts": 900,
    });
    expect(
      newestMtimeMs(join(root, "src"), (f) => !f.endsWith(".test.ts")),
    ).toBe(300_000);
  });

  test("a missing directory has no newest file", () => {
    expect(newestMtimeMs(join(dir, "nowhere"))).toBeNull();
  });
});

describe("staleBuildNotice", () => {
  test("a source edited after the build: the notice", () => {
    const root = checkout("stale", {
      "src/main.ts": 500,
      "dist/main.js": 400,
    });
    expect(staleBuildNotice(join(root, "dist"))).toBe(STALE_BUILD_NOTICE);
    expect(STALE_BUILD_NOTICE).toBe(
      "this frm build is out of date — run: pnpm -w build",
    );
  });

  test("a build after the last edit, or an edited test only: nothing", () => {
    const fresh = checkout("fresh", {
      "src/main.ts": 400,
      "dist/main.js": 500,
    });
    expect(staleBuildNotice(join(fresh, "dist"))).toBeNull();
    const test = checkout("test-only", {
      "src/main.ts": 400,
      "src/main.test.ts": 900,
      "dist/main.js": 500,
    });
    expect(staleBuildNotice(join(test, "dist"))).toBeNull();
  });

  test("no src/ beside dist/ (not a source checkout): nothing", () => {
    const built = checkout("installed", { "dist/main.js": 1 });
    expect(staleBuildNotice(join(built, "dist"))).toBeNull();
  });
});

test("a file that vanishes mid-walk, or any other error, is never a crash: not stale", () => {
  const root = checkout("vanish", {
    "src/main.ts": 500,
    "dist/main.js": 400,
  });
  const gone: WalkFs = {
    entries: (d) => readdirSync(d, { withFileTypes: true }),
    mtimeMs: (file) => {
      if (file.endsWith("main.ts")) throw new Error(`ENOENT: ${file}`);
      return statSync(file).mtimeMs;
    },
  };
  expect(() => newestMtimeMs(join(root, "src"), () => true, gone)).toThrow();
  expect(staleBuildNotice(join(root, "dist"), gone)).toBeNull();
  const broken: WalkFs = {
    entries: () => {
      throw new Error("EACCES");
    },
    mtimeMs: () => 0,
  };
  expect(staleBuildNotice(join(root, "dist"), broken)).toBeNull();
  // The same checkout with node's own fs: stale, so the null above is the error's doing.
  expect(staleBuildNotice(join(root, "dist"))).toBe(STALE_BUILD_NOTICE);
});
