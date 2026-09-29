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
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, expect, test } from "vitest";

// A file that starts the supervisor's built entry point as a child hands it an FRM_MCP_URL of its
// own. Without one the child falls back to DEFAULT_MCP_URL, the default port of the operator's live
// API, and gates every MCP-mounting spawn and adopt on that answering: a real-process test then
// passes only while a live install happens to run beside it, and fails everywhere else.
const SUPERVISOR_MAIN = "apps/supervisor/dist/main.js";
const SKIP = new Set(["node_modules", "dist", "coverage"]);
const SOURCE = /\.[cm]?[jt]sx?$/;
/** Starting a process: node's family, and the smoke harness's startChild. */
const SPAWNS = /\b(?:spawn|spawnSync|execFile|execFileSync|fork|startChild)\(/;
/** `new URL("<relative>", import.meta.url)`: the way a test names a built file beside it. */
const URL_BESIDE =
  /new URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g;
/** The default the child would fall back to, spelled out: its port, or the constant. */
const DEFAULT = /:3010\b|\bDEFAULT_MCP_URL\b/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/** Code only: a comment naming the entry point, or FRM_MCP_URL, is neither a spawn nor a URL. */
const code = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join("\n");

/** Names the supervisor's dist main: as a repo path, or as a URL resolved beside the file. */
function namesSupervisorMain(root: string, file: string, text: string) {
  if (text.includes(SUPERVISOR_MAIN)) return true;
  const target = join(root, SUPERVISOR_MAIN);
  return [...text.matchAll(URL_BESIDE)].some(
    (m) => fileURLToPath(new URL(m[1] ?? "", pathToFileURL(file))) === target,
  );
}

/** Every file under apps, packages and tools that starts the supervisor's dist main, relative. */
export function supervisorSpawners(root: string): string[] {
  return ["apps", "packages", "tools"]
    .flatMap((group) => walk(join(root, group)))
    .filter((file) => SOURCE.test(file))
    .filter((file) => {
      const text = code(readFileSync(file, "utf8"));
      return SPAWNS.test(text) && namesSupervisorMain(root, file, text);
    })
    .map((file) => relative(root, file).split(sep).join("/"));
}

/** The spawners whose child could reach the default URL: no FRM_MCP_URL, or the default named. */
export function unownedMcpUrls(root: string): string[] {
  return supervisorSpawners(root).filter((rel) => {
    const text = code(readFileSync(join(root, rel), "utf8"));
    return !/\bFRM_MCP_URL\b/.test(text) || DEFAULT.test(text);
  });
}

const repo = dirname(fileURLToPath(import.meta.url));

test("every file that starts the supervisor's dist main gives its child an FRM_MCP_URL of its own", () => {
  expect(unownedMcpUrls(repo)).toEqual([]);
});

test("the guard sees the real spawners, so an empty result means something", () => {
  expect(supervisorSpawners(repo)).toEqual(
    expect.arrayContaining([
      "apps/supervisor/src/lifecycle/phase-restart.test.ts",
      "apps/supervisor/src/lifecycle/plug.test.ts",
      "apps/supervisor/src/lifecycle/restart.test.ts",
      "tools/frm/src/smoke/stack.ts",
    ]),
  );
  // A comment naming dist/main.js is not a spawn; the frm CLI's dist main is not the supervisor's.
  expect(supervisorSpawners(repo)).not.toContain(
    "apps/supervisor/src/relay.e2e.test.ts",
  );
  expect(supervisorSpawners(repo)).not.toContain(
    "apps/supervisor/src/lifecycle/container.live.test.ts",
  );
});

const planted = mkdtempSync(join(tmpdir(), "frm-mcp-url-guard-"));
afterAll(() => rmSync(planted, { recursive: true, force: true }));

test("a planted spawner with no FRM_MCP_URL, or with the default one, is caught", () => {
  const dir = join(planted, "apps/supervisor/src/lifecycle");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(planted, "packages"));
  mkdirSync(join(planted, "tools"));
  const spawner = (env: string) =>
    [
      'const MAIN = fileURLToPath(new URL("../../dist/main.js", import.meta.url));',
      `spawn(process.execPath, [MAIN], { env: { FRM_HOME: home${env} } });`,
    ].join("\n");
  writeFileSync(join(dir, "bare.test.ts"), spawner(""));
  writeFileSync(join(dir, "owned.test.ts"), spawner(", FRM_MCP_URL: mcp.url"));
  writeFileSync(
    join(dir, "default.test.ts"),
    spawner(', FRM_MCP_URL: "http://127.0.0.1:3010/mcp"'),
  );
  writeFileSync(
    join(dir, "commented.test.ts"),
    `${spawner("")}\n// FRM_MCP_URL is set elsewhere`,
  );
  // Not a supervisor: the frm CLI's dist main.
  writeFileSync(
    join(dir, "cli.test.ts"),
    'execFileSync(process.execPath, [join(ROOT, "tools/frm/dist/main.js")]);',
  );
  expect(supervisorSpawners(planted).toSorted()).toEqual([
    "apps/supervisor/src/lifecycle/bare.test.ts",
    "apps/supervisor/src/lifecycle/commented.test.ts",
    "apps/supervisor/src/lifecycle/default.test.ts",
    "apps/supervisor/src/lifecycle/owned.test.ts",
  ]);
  expect(unownedMcpUrls(planted).toSorted()).toEqual([
    "apps/supervisor/src/lifecycle/bare.test.ts",
    "apps/supervisor/src/lifecycle/commented.test.ts",
    "apps/supervisor/src/lifecycle/default.test.ts",
  ]);
});
