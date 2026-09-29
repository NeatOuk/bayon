// an earlier change on the real CLI: a repository's own .claude/settings.json is not loaded at all, and its
// CLAUDE.md still reaches the model, in the system prompt. The pinned bundled binary against a local
// stand-in for the Messages API, a dummy key, no model call, no spend, no Keychain; skipped where
// this platform bundles no binary. The repo's settings are harmless on purpose: an env entry the
// model's Bash call echoes, and hooks that leave a marker file in the worktree. The control runs the
// same binary with the project source the adapter used to pass, so the test cannot pass vacuously.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { SpawnSpec } from "../../adapter.js";
import { bundledBinary } from "./adapter.js";
import { DEFAULTS } from "./registration.js";
import {
  ECHO_PROMPT,
  KEY,
  MODEL,
  QUIET,
  closeStandIn,
  mainLoop,
  messagesOf,
  oneTurn,
  runCli,
  standIn,
  systemOf,
  toolResults,
  type Hit,
  type StandIn,
} from "./testing/real-cli.js";

const BINARY = bundledBinary();
const PRESENT = BINARY !== undefined && existsSync(BINARY);

const DOCTRINE = "FRM-DOCTRINE-MARKER: the repository's own rules.";
const MARKER = "hook-ran.txt";

/** The repo's settings: an env entry, and a hook at session start and before Bash, each harmless. */
const repoSettings = (marker: string) => {
  const touch = { type: "command", command: `touch '${marker}'` };
  return {
    env: { FRM_TEST_FROM_REPO: "1" },
    hooks: {
      SessionStart: [{ hooks: [touch] }],
      PreToolUse: [{ matcher: "Bash", hooks: [touch] }],
    },
  };
};

describe.skipIf(!PRESENT)(
  "the real CLI in a worktree with its own settings",
  { timeout: 120_000 },
  () => {
    const hits: Hit[] = [];
    let api: StandIn | undefined;
    let root = "";
    let sessions = 0;

    beforeAll(async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "frm-repo-settings-")));
      api = await standIn(hits);
    });
    afterAll(async () => {
      await closeStandIn(api);
      rmSync(root, { recursive: true, force: true });
    });

    function session(): {
      cwd: string;
      homeDir: string;
      env: Record<string, string>;
      marker: string;
    } {
      hits.length = 0;
      const base = join(root, `s${++sessions}`);
      const cwd = join(base, "work");
      const homeDir = join(base, "home");
      const home = join(base, "os-home");
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(home, { recursive: true });
      const marker = join(cwd, MARKER);
      writeFileSync(
        join(cwd, ".claude", "settings.json"),
        JSON.stringify(repoSettings(marker)),
      );
      writeFileSync(join(cwd, "CLAUDE.md"), `${DOCTRINE}\n`);
      const env = {
        // With the vitest setup's stand-in `security` first: nothing reaches the real Keychain.
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        ...QUIET,
        ANTHROPIC_API_KEY: KEY,
        ANTHROPIC_BASE_URL: api?.url ?? "",
      };
      return { cwd, homeDir, env, marker };
    }

    test("control: with the project source, the repo's hooks run and its env reaches the model's Bash", async () => {
      const s = session();
      await runCli(
        BINARY ?? "",
        [
          "-p",
          ECHO_PROMPT,
          "--output-format",
          "json",
          "--setting-sources=project",
          "--allowedTools",
          "Bash",
          "--model",
          MODEL,
          "--max-turns",
          "3",
        ],
        s.cwd,
        { ...s.env, CLAUDE_CONFIG_DIR: s.homeDir },
      );
      expect(existsSync(s.marker)).toBe(true);
      expect(toolResults(hits).join("\n")).toContain("repo=[1]");
      // The project source delivers CLAUDE.md as context in the messages.
      const [first] = mainLoop(hits);
      if (first === undefined) throw new Error("no main-loop request");
      expect(messagesOf(first)).toContain(DOCTRINE);
    });

    test("the adapter: no hook runs, the model's Bash sees no repo env, and CLAUDE.md is in the system prompt", async () => {
      const s = session();
      const spec: SpawnSpec = {
        sessionId: "01REPOSETTINGS",
        cwd: s.cwd,
        homeDir: s.homeDir,
        env: s.env,
        model: MODEL,
        flags: { ...DEFAULTS, allowedTools: ["Bash"] },
      };
      const turn = await oneTurn(spec, ECHO_PROMPT);
      expect(turn.outcome).toBe("ok");
      expect(existsSync(s.marker)).toBe(false);
      const results = toolResults(hits).join("\n");
      // The Bash call ran, and the variable the repo's settings name was empty in it.
      expect(results).toContain("repo=[]");
      expect(results).not.toContain("repo=[1]");
      const calls = mainLoop(hits);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.headers["x-api-key"]).toBe(KEY);
        expect(systemOf(call)).toContain(DOCTRINE);
        expect(systemOf(call)).toContain(
          "Contents of CLAUDE.md (project instructions, checked into the codebase):",
        );
      }
    });
  },
);
