import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";

// Invariant 1 (CLAUDE.md): no runner or provider string outside packages/runners/<adapter>. Every
// file of every workspace is scanned, not only src/ (package.json deps and db migrations too). The
// adapter exemption is by directory: a new adapters/<id>/ is exempt with no edit here.
const PATTERN =
  /claude|codex|anthropic|openai|ollama|opencode|qwen|gpt-oss|openrouter/i;
const RUNNERS = "packages/runners";
const SKIP = new Set(["node_modules", "dist", "coverage"]);
/** Inside packages/runners, the only paths that may name a runner. */
const ALLOWED_IN_RUNNERS = [
  /^src\/adapters\/[^/]+\//,
  /^src\/adapters\/registry(\.test)?\.ts$/,
  // Each runner's validateModel hook by id, for the API and frm, which never load an adapter.
  /^src\/adapters\/registry-models(\.test)?\.ts$/,
  /^fixtures\//,
  /^package\.json$/,
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/** Every hit as `path:line` (or the bare path when the name itself leaks), relative to `root`. */
export function findLeaks(root: string): string[] {
  const workspaces = ["apps", "packages", "tools"].flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${group}/${entry.name}`),
  );
  return workspaces.flatMap((workspace) =>
    walk(join(root, workspace)).flatMap((file) => {
      const path = relative(join(root, workspace), file).split(sep).join("/");
      if (
        workspace === RUNNERS &&
        ALLOWED_IN_RUNNERS.some((allowed) => allowed.test(path))
      ) {
        return [];
      }
      const named = PATTERN.test(path) ? [`${workspace}/${path}`] : [];
      const lines = readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          PATTERN.test(line) ? [`${workspace}/${path}:${i + 1}`] : [],
        );
      return [...named, ...lines];
    }),
  );
}

const repo = dirname(fileURLToPath(import.meta.url));

test("no runner strings leak outside packages/runners/src/adapters", () => {
  expect(findLeaks(repo)).toEqual([]);
});

const planted = mkdtempSync(join(tmpdir(), "frm-leak-"));
afterAll(() => rmSync(planted, { recursive: true, force: true }));

test("the scan catches planted strings, so it cannot pass vacuously", () => {
  const plant = (path: string, text: string) => {
    mkdirSync(dirname(join(planted, path)), { recursive: true });
    writeFileSync(join(planted, path), text);
  };
  plant("apps/api/src/ok.ts", "export const fine = 1;\n");
  plant("apps/api/src/leak.ts", "// fine\nconst runner = 'Claude';\n");
  plant(
    "apps/api/package.json",
    '{ "dependencies": { "@anthropic-ai/sdk": "1" } }',
  );
  plant(
    "packages/db/migrations/003_x.sql",
    "INSERT INTO runners VALUES ('codex-exec');\n",
  );
  plant("tools/frm/src/codex.ts", "export {};\n");
  plant("packages/runners/src/spend.ts", "// anthropic\n");
  // The open-weight and gateway names, each outside an adapter.
  plant("apps/web/src/models.ts", "const m = 'qwen3-coder';\n");
  plant("apps/supervisor/src/route.ts", "// via OpenRouter\n// or Ollama\n");
  plant("packages/core/src/x.ts", "// OPENAI_API_KEY\n// gpt-oss-120b\n");
  plant("tools/frm/src/opencode.ts", "export {};\n");
  // A new adapter's own directory, which no list names: exempt by being one.
  plant(
    "packages/runners/src/adapters/opencode/adapter.ts",
    "// opencode serve, ollama, openrouter, qwen, gpt-oss, openai\n",
  );
  plant(
    "packages/runners/src/adapters/some-runner/a.ts",
    "// claude is fine here\n",
  );
  plant(
    "packages/runners/src/adapters/registry.ts",
    "// claude is fine here\n",
  );
  plant(
    "packages/runners/src/adapters/registry-models.ts",
    "// opencode is fine here\n",
  );
  plant("packages/runners/fixtures/some-runner/x.jsonl", "claude\n");
  plant("packages/runners/package.json", '{ "@anthropic-ai/x": "1" }');
  plant("apps/api/node_modules/dep/index.js", "claude\n");
  plant("apps/api/dist/index.js", "claude\n");

  expect(findLeaks(planted).toSorted()).toEqual([
    "apps/api/package.json:1",
    "apps/api/src/leak.ts:2",
    "apps/supervisor/src/route.ts:1",
    "apps/supervisor/src/route.ts:2",
    "apps/web/src/models.ts:1",
    "packages/core/src/x.ts:1",
    "packages/core/src/x.ts:2",
    "packages/db/migrations/003_x.sql:1",
    "packages/runners/src/spend.ts:1",
    "tools/frm/src/codex.ts",
    "tools/frm/src/opencode.ts",
  ]);
});
