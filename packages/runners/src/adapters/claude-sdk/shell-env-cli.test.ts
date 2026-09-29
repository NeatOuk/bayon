// an earlier change on the real CLI: the env the model's Bash tool runs with, on the pinned bundled binary,
// through the adapter. One turn against a local stand-in for the Messages API (the session's
// ANTHROPIC_BASE_URL, as the M12 proxy points the CLI), whose reply is one Bash call running `env`;
// the tool result the CLI sends back is the model shell's env. The session env is shaped like the
// supervisor's buildEnv: the agent identity, the git floor, a credential, HOME, TMPDIR,
// PATH and the tags; the session's MCP server is a local stand-in answering a planted bearer, mounted
// over the control channel, so it is seen nowhere the model's shell can look. No model
// call, no credential (both secrets are fakes), no spend, no Keychain, nothing past 127.0.0.1.
// Skipped where this platform bundles no binary: the stub CLI cannot be the evidence, since what is
// tested is the CLI's own env handling.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_GIT_ENV } from "@bayon/executors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { SpawnSpec } from "../../adapter.js";
import { bundledBinary } from "./adapter.js";
import { DEFAULTS } from "./registration.js";
import { mcpStandIn, type McpStandIn } from "./testing/mcp-stand-in.js";
import {
  ENV_PROMPT,
  MODEL,
  QUIET,
  closeStandIn,
  isMessages,
  oneTurn,
  standIn,
  type Hit,
  type StandIn,
} from "./testing/real-cli.js";

const BINARY = bundledBinary();
const PRESENT = BINARY !== undefined && existsSync(BINARY);

const IDENTITY = {
  GIT_AUTHOR_NAME: "Bayon Agent",
  GIT_AUTHOR_EMAIL: "agent@bayon.invalid",
  GIT_COMMITTER_NAME: "Bayon Agent",
  GIT_COMMITTER_EMAIL: "agent@bayon.invalid",
};
/** Fakes, never real credentials: each is only ever searched for in what the model's shell printed. */
const OAUTH = "sk-ant-oat01-fake-oauth-for-the-shell-env-test";
const API_KEY = "sk-ant-api03-fake-key-for-the-shell-env-test";
const MCP_BEARER = "frm-fake-mcp-bearer-for-the-shell-env-test";
/** The name the bearer went by in the CLI's env before an earlier change. */
const OLD_BEARER_ENV = "FRM_MCP_TOKEN";

/** The files under `dir` whose bytes hold `needle`, as paths relative to it. */
const filesHolding = (dir: string, needle: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .filter((path) => readFileSync(path).includes(needle))
    .map((path) => path.slice(dir.length + 1));

/** `NAME=value` lines as a map; the first spelling of a name wins, as a shell's env has one. */
const envOf = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split("\n")
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ])
      .reverse(),
  );

/** A tool_result's content as text: a string, or its text blocks joined. */
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((b: unknown) =>
            typeof b === "object" && b !== null && "text" in b
              ? String((b as { text: unknown }).text)
              : "",
          )
          .join("\n")
      : "";

/** Every tool result the CLI sent back to the stand-in, as text. */
const shellOutputs = (hits: readonly Hit[]): string[] => [
  ...new Set(
    hits.filter(isMessages).flatMap((hit) => {
      const body = JSON.parse(hit.body) as {
        messages?: { content?: unknown }[];
      };
      return (body.messages ?? []).flatMap((m) =>
        Array.isArray(m.content)
          ? m.content.flatMap((b: unknown) =>
              typeof b === "object" &&
              b !== null &&
              (b as { type?: unknown }).type === "tool_result"
                ? [textOf((b as { content?: unknown }).content)]
                : [],
            )
          : [],
      );
    }),
  ),
];

/** The names a shell env holds, each secret's value replaced, for the report. */
const redacted = (env: Readonly<Record<string, string>>): string[] =>
  Object.entries(env)
    .map(([name, value]) =>
      [OAUTH, API_KEY, MCP_BEARER].some((secret) => value.includes(secret))
        ? `${name}=<planted secret>`
        : value === ""
          ? `${name}=""`
          : name,
    )
    .sort();

/** The two credentials a session runs on (DEFAULTS.secretEnvAnyOf), each a planted fake. */
const OAUTH_CREDENTIAL = {
  name: "CLAUDE_CODE_OAUTH_TOKEN",
  value: OAUTH,
  header: "authorization",
} as const;
const API_KEY_CREDENTIAL = {
  name: "ANTHROPIC_API_KEY",
  value: API_KEY,
  header: "x-api-key",
} as const;

/**
 * Each session shape, and whether its model shell is seen to hold its credential today. The CLI
 * strips CLAUDE_CODE_OAUTH_TOKEN from its Bash tool's env, but not ANTHROPIC_API_KEY: that case is
 * `test.fails`, so it turns red, and must be flipped, the day the leak is gone.
 * TODO: the API key reaches the model's shell. The CLI's only switch that strips it,
 * CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, also forces the permission mode to "default" (Bayon runs
 * acceptEdits), sandboxes subprocesses and scrubs every secret-shaped name a profile sets; settings
 * env or an apiKeyHelper would reach the same shell. The fix keeps the key out of the CLI: the
 * context proxy injects it upstream and the CLI holds a dummy (the design).
 * The MCP bearer (FRM_MCP_TOKEN in the CLI's env before) no longer leaks on either.
 */
const CASES = [
  {
    label: "CLAUDE_CODE_OAUTH_TOKEN",
    credential: OAUTH_CREDENTIAL,
    leaksCredential: false,
  },
  {
    label: "ANTHROPIC_API_KEY",
    credential: API_KEY_CREDENTIAL,
    leaksCredential: true,
  },
] as const;

describe.skipIf(!PRESENT).each(CASES)(
  "the pinned CLI's model shell env, through the adapter, on $label",
  { timeout: 120_000 },
  ({ label, credential, leaksCredential }) => {
    const hits: Hit[] = [];
    let api: StandIn | undefined;
    let mcp: McpStandIn | undefined;
    let root = "";
    let output = "";
    let seen: Record<string, string> = {};

    beforeAll(async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "frm-claude-env-")));
      api = await standIn(hits);
      // The session's MCP server, answering the planted bearer alone.
      mcp = await mcpStandIn(MCP_BEARER, []);
      const cwd = join(root, "work");
      const homeDir = join(root, "home");
      const home = join(root, "os-home");
      const tmp = join(root, "tmp");
      for (const dir of [cwd, homeDir, home, tmp]) {
        mkdirSync(dir, { recursive: true });
      }
      const spec: SpawnSpec = {
        sessionId: "01SHELLENV",
        cwd,
        homeDir,
        // buildEnv's order: identity, the profile's env and the secrets, the floor, then the rest.
        env: {
          ...IDENTITY,
          ...QUIET,
          ANTHROPIC_BASE_URL: api.url,
          [credential.name]: credential.value,
          ...SESSION_GIT_ENV,
          HOME: home,
          TMPDIR: tmp,
          // With the vitest setup's stand-in `security` first: nothing reaches the real Keychain.
          PATH: process.env["PATH"] ?? "",
          FRM_SESSION_ID: "01SHELLENV",
          FRM_HOME_TAG: "shell-env-test",
        },
        model: MODEL,
        flags: { ...DEFAULTS, allowedTools: ["Bash"] },
        mcp: {
          url: mcp.url,
          token: MCP_BEARER,
          tools: [],
        },
      };
      const turn = await oneTurn(spec, ENV_PROMPT);
      expect(turn.outcome).toBe("ok");
      const outputs = shellOutputs(hits);
      expect(outputs).toHaveLength(1);
      output = outputs[0] ?? "";
      seen = envOf(output);
      process.stdout.write(
        `claude-sdk model shell env on ${label} (${Object.keys(seen).length} names):\n  ${redacted(seen).join("\n  ")}\n`,
      );
    });
    afterAll(async () => {
      await closeStandIn(api);
      await mcp?.close();
      rmSync(root, { recursive: true, force: true });
    });

    test("the turn ran on the session's credential, against the stand-in alone", () => {
      const calls = hits.filter(isMessages);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(String(call.headers[credential.header])).toContain(
          credential.value,
        );
      }
      // The MCP bearer reached the MCP server, expanded: the one place it is for.
      expect(mcp?.authorizations).toContain(`Bearer ${MCP_BEARER}`);
    });

    test("the model's Bash sees the floor and the identity, as the session env holds them", () => {
      expect(seen).toMatchObject({ ...SESSION_GIT_ENV, ...IDENTITY });
    });

    (leaksCredential ? test.fails : test)(
      "the session's credential is not in the model's shell, under any name",
      () => {
        expect(output).not.toContain(credential.value);
      },
    );

    test("the MCP bearer is not in the model's shell, by name or by value", () => {
      expect(seen).not.toHaveProperty(OLD_BEARER_ENV);
      expect(output).not.toContain(MCP_BEARER);
    });

    test("no file the model's shell can read holds the MCP bearer: not the session home, not HOME", () => {
      expect(filesHolding(root, MCP_BEARER)).toEqual([]);
    });
  },
);
