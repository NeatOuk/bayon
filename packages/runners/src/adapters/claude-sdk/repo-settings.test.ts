// an earlier change through the real SDK and the stub CLI: the adapter starts the CLI with no settings
// source, so a repository's own .claude/settings.json (its env, its hooks) is never read, and the
// repository's CLAUDE.md reaches the agent as the system prompt's append instead: on spawn, on adopt
// and on a takeover. What the real CLI does with those options is pinned-env-cli.test.ts and
// repo-settings-cli.test.ts; this is what the adapter asks of it.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { afterAll, describe, expect, test } from "vitest";
import type { SessionHandle, SpawnSpec } from "../../adapter.js";
import { createClaudeSdkAdapter } from "./adapter.js";
import { DOCTRINE_HOME_FILE, readDoctrine } from "./doctrine.js";
import { DEFAULTS } from "./registration.js";

const STUB = fileURLToPath(new URL("./testing/stub-cli.mjs", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-sdk-repo-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const local = new LocalExecutor({ id: "local", slots: new SlotCounter(8) });
const adapter = createClaudeSdkAdapter({
  pathToExecutable: STUB,
  executable: "node",
});

/** Real processes run on real time: a deadline, never a sleep. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`deadline: ${what}`)),
          20_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const ROOT_DOCTRINE = "Root doctrine: run the tests before you claim.";
const DOT_DOCTRINE = "Dot-claude doctrine: never delete a dirty worktree.";

/** A repo's settings that would reach the agent if the project source were loaded. */
const REPO_SETTINGS = {
  env: { FRM_TEST_FROM_REPO: "1" },
  hooks: {
    SessionStart: [
      { hooks: [{ type: "command", command: "touch hook-ran.txt" }] },
    ],
  },
};

let n = 0;
/** A worktree with the repo's settings and, unless `bare`, both doctrine files. */
function spec(bare = false, extra: Partial<SpawnSpec> = {}): SpawnSpec {
  const base = join(root, `s${++n}`);
  const cwd = join(base, "work");
  const homeDir = join(base, "home");
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(
    join(cwd, ".claude", "settings.json"),
    JSON.stringify(REPO_SETTINGS),
  );
  if (!bare) {
    writeFileSync(join(cwd, "CLAUDE.md"), `${ROOT_DOCTRINE}\n`);
    writeFileSync(join(cwd, ".claude", "CLAUDE.md"), `${DOT_DOCTRINE}\n`);
  }
  return {
    sessionId: `01REPO${n}`,
    cwd,
    homeDir,
    env: { PATH: process.env["PATH"] ?? "" },
    model: "claude-haiku-4-5",
    flags: { ...DEFAULTS },
    ...extra,
  };
}

async function spawned(
  s: SpawnSpec,
  how: "spawn" | "adopt" = "spawn",
): Promise<SessionHandle> {
  const result = await within(adapter[how](s, local), how);
  if (!result.ok) throw new Error(`${how} failed: ${result.error.message}`);
  return result.value;
}

const homeJson = (s: SpawnSpec, file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(s.homeDir, file), "utf8")) as Record<
    string,
    unknown
  >;
const argvOf = (s: SpawnSpec): string[] =>
  JSON.parse(readFileSync(join(s.homeDir, "argv.json"), "utf8")) as string[];
/** What the SDK sent in its initialize request as the system prompt's append. */
const appendOf = (s: SpawnSpec): unknown =>
  homeJson(s, "initialize.json")["appendSystemPrompt"];

describe("a repo's settings and doctrine", { timeout: 60_000 }, () => {
  // Where the CLI records a conversation's system prompt (its default), a resume keeps the one it
  // started with and ignores a later append; the adapter still passes the files as they are now, for
  // where it does not.
  test("spawn loads no settings file and appends both doctrine files; adopt passes them as they are now", async () => {
    const s = spec();
    const h = await spawned(s);
    expect(argvOf(s)).toContain("--setting-sources=");
    expect(argvOf(s).some((a) => a.startsWith("--setting-sources=p"))).toBe(
      false,
    );
    // The stub applies settings env for the sources on argv: none, so only the pins.
    expect(homeJson(s, "settings-env.json")).not.toHaveProperty(
      "FRM_TEST_FROM_REPO",
    );
    const first = appendOf(s);
    expect(first).toEqual(expect.stringContaining(ROOT_DOCTRINE));
    expect(first).toEqual(expect.stringContaining(DOT_DOCTRINE));
    expect(String(first).indexOf(ROOT_DOCTRINE)).toBeLessThan(
      String(first).indexOf(DOT_DOCTRINE),
    );
    // On stdin, never argv.
    expect(argvOf(s).join(" ")).not.toContain(ROOT_DOCTRINE);
    const doctrine = await readDoctrine(local, s.cwd);
    expect(doctrine).toEqual({ ok: true, value: first });
    await within(adapter.stop(h, "graceful"), "graceful stop");

    // The agent edited CLAUDE.md before its process died: an adopt appends what is there now.
    writeFileSync(join(s.cwd, "CLAUDE.md"), "Edited doctrine.\n");
    const again = { ...s, resumeRunnerSessionId: h.runnerSessionId };
    const h2 = await spawned(again, "adopt");
    expect(argvOf(again)).toContain("--setting-sources=");
    expect(appendOf(again)).toEqual(
      expect.stringContaining("Edited doctrine."),
    );
    expect(appendOf(again)).not.toEqual(expect.stringContaining(ROOT_DOCTRINE));
    await within(adapter.stop(h2, "kill"), "kill");
  });

  test("a worktree with no doctrine appends nothing", async () => {
    const s = spec(true);
    const h = await spawned(s);
    expect(appendOf(s)).toBeNull();
    await within(adapter.stop(h, "graceful"), "graceful stop");
  });

  test("a profile that names a settings source is refused, spawn and takeover alike", async () => {
    for (const sources of [["project"], ["local"], ["user"]]) {
      const s = spec(false, {
        flags: { ...DEFAULTS, settingSources: sources },
      });
      const spawnedResult = await within(adapter.spawn(s, local), "spawn");
      expect(spawnedResult).toMatchObject({
        ok: false,
        error: { class: "validation" },
      });
      if (!spawnedResult.ok) {
        expect(spawnedResult.error.message).toContain("settingSources");
        expect(spawnedResult.error.message).toContain(
          "no settings file is loaded",
        );
      }
      expect(existsSync(join(s.homeDir, "argv.json"))).toBe(false);
      expect(await adapter.interactiveResume(s, "rsid-1", local)).toMatchObject(
        { ok: false, error: { class: "validation" } },
      );
    }
  });

  test("a CLAUDE.md that resolves outside the worktree is refused before anything starts", async () => {
    const s = spec(true);
    const elsewhere = join(root, `secret-${n}.txt`);
    writeFileSync(elsewhere, "not the repo's to read\n");
    symlinkSync(elsewhere, join(s.cwd, "CLAUDE.md"));
    const result = await within(adapter.spawn(s, local), "spawn");
    expect(result).toMatchObject({
      ok: false,
      error: {
        class: "validation",
        message: "CLAUDE.md resolves outside the worktree",
      },
    });
    expect(existsSync(join(s.homeDir, "argv.json"))).toBe(false);
    // The takeover reads the same files the same way.
    expect(await adapter.interactiveResume(s, "rsid-2", local)).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });

  test("the takeover names a 0600 copy of the doctrine in the home, never the text on argv", async () => {
    const s = spec();
    const resumed = await adapter.interactiveResume(s, "rsid-9", local);
    if (!resumed.ok) throw new Error(resumed.error.message);
    const path = join(s.homeDir, DOCTRINE_HOME_FILE);
    const { argv } = resumed.value;
    expect(argv.slice(0, 4)).toEqual([
      STUB,
      "--resume",
      "rsid-9",
      "--setting-sources=",
    ]);
    expect(argv.slice(-2)).toEqual(["--append-system-prompt-file", path]);
    expect(argv.join(" ")).not.toContain(ROOT_DOCTRINE);
    const doctrine = await readDoctrine(local, s.cwd);
    if (!doctrine.ok) throw new Error(doctrine.error.message);
    expect(readFileSync(path, "utf8")).toBe(doctrine.value);
    expect(readFileSync(path, "utf8")).toContain(DOT_DOCTRINE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
