import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// The Keychain store belongs to its install. One module reads it: hostSecrets, in
// packages/executors, derives the service from the install's home. So no other source may run a
// `security` binary or call the raw Keychain readers, or the API's token read, a spawn's secrets,
// QA or a backup could name another install's service (the live install's `foreman`) by hand.
const root = new URL("./", import.meta.url);
const SKIP = new Set(["node_modules", "dist", "coverage"]);

function filesUnder(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    return entry.isDirectory()
      ? filesUnder(new URL(`${entry.name}/`, dir))
      : [new URL(entry.name, dir)];
  });
}

const relative = (file: URL) => file.pathname.slice(root.pathname.length);
const SOURCE = /\.(?:[cm]?[jt]sx?|sh)$/;
const isTest = (rel: string) =>
  /\.test\.[cm]?[jt]sx?$/.test(rel) || rel.includes("/testing/");
const sources = ["apps", "packages", "tools"]
  .flatMap((dir) => filesUnder(new URL(`${dir}/`, root)).map(relative))
  .filter((rel) => SOURCE.test(rel) && !isTest(rel));
const read = (rel: string) => readFileSync(new URL(rel, root), "utf8");

/** Where vitest.setup.ts puts the stand-in: computed here, not imported (importing it sets PATH). */
const TEST_BIN = fileURLToPath(new URL("./test-bin", root));

/** The one module that runs `security`. */
const STORE = "packages/executors/src/secrets.ts";

const RULES = [
  {
    rule: "only the host store runs a `security` binary",
    // A process call whose program is `security`, or the bare name as a quoted string (an argv[0],
    // a bin default). Commands shown to the operator are whole sentences, never the bare word.
    banned:
      /(?:\b(?:execFile|execFileSync|spawn|spawnSync|exec|execSync)\(\s*["'`]security\b|["']security["'])/,
    allowed: new Set([STORE]),
  },
  {
    rule: "no script runs `security … -generic-password` itself",
    banned: /^[^#\n]*\bsecurity\s+(?:find|add|delete)-generic-password/m,
    applies: (rel: string) => rel.endsWith(".sh"),
    allowed: new Set<string>(),
  },
  {
    rule: "only the host store calls keychainSecrets(): everyone else goes through hostSecrets",
    banned: /\bkeychainSecrets\(/,
    allowed: new Set([STORE]),
  },
  {
    rule: "only the host store, frm backup init-key and frm init call putKeychainSecret()",
    banned: /\bputKeychainSecret\(/,
    allowed: new Set([
      STORE,
      "tools/frm/src/backup.ts",
      "tools/frm/src/init.ts",
    ]),
  },
] as const;

test.each(RULES)("$rule", (r) => {
  const offenders = sources.filter(
    (rel) =>
      !r.allowed.has(rel) &&
      ("applies" in r ? r.applies(rel) : true) &&
      r.banned.test(read(rel)),
  );
  expect(offenders).toEqual([]);
});

test("frm backup writes only under the service hostSecrets derived, never a literal one", () => {
  const backup = read("tools/frm/src/backup.ts");
  expect(backup).not.toMatch(/service:\s*["'`]/);
  expect(backup).toMatch(/host\.value\.keychain\?\.service/);
});

test("frm init writes only under the service hostSecrets derived, never a literal one", () => {
  const init = read("tools/frm/src/init.ts");
  expect(init).not.toMatch(/service:\s*["'`]/);
  expect(init).toMatch(/host\.value\.keychain\?\.service/);
});

test("every hostSecrets caller passes no service: the store derives it", () => {
  const callers = sources.filter((rel) => /\bhostSecrets\(/.test(read(rel)));
  expect(callers.length).toBeGreaterThanOrEqual(4);
  for (const rel of callers) {
    expect(read(rel), rel).not.toMatch(/keychainService/);
  }
});

test("the guard sees the real callers, so an empty result means something", () => {
  expect(sources).toContain(STORE);
  expect(sources).toContain("apps/api/src/jira/token.ts");
  expect(sources).toContain("apps/supervisor/src/main.ts");
  expect(RULES[0].banned.test(read(STORE))).toBe(true);
  expect(RULES[2].banned.test(read(STORE))).toBe(true);
});

test("a vitest worker's first `security` on PATH is the stand-in, never the real one", () => {
  const first = (process.env.PATH ?? "")
    .split(delimiter)
    .map((dir) => join(dir, "security"))
    .find((candidate) => {
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  expect(first).toBe(join(TEST_BIN, "security"));
  expect(read("test-bin/security")).toMatch(/^exit 44$/m);
  expect(read("vitest.config.ts")).toContain(
    'setupFiles: ["./vitest.setup.ts"]',
  );
});
