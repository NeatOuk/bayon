// an earlier change on the real CLI: the shell env securityArgs gives the model, on the pinned version. No
// model call, no credential, no spend. Skipped unless the pinned version is on PATH (CI has none):
// the stub CLI cannot be the evidence here, since what is tested is Codex's own env handling.
//
// Two paths, because 0.154.0 has two:
//   - `codex sandbox` builds a command's env from `shell_environment_policy` alone. `inherit = "core"`
//     drops everything else before `include_only`, so the floor and the identity arrive by `set`
//     or not at all.
//   - `codex exec`'s shell tool (`exec_command`) lays that same policy env over Codex's own inherited
//     env. There `set` is what makes the floor's values win over whatever the turn host's env holds.
// The second runs a real `codex exec` turn against a local stand-in for the model API, which asks
// for one `env` and reads back what the model's shell printed.
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SESSION_GIT_ENV } from "@bayon/executors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MCP_TOKEN_ENV, securityArgs, turnArgv } from "./argv.js";
import { CHEAP_MODEL } from "./testing/cheap-model.js";
import { VERSION_LINE } from "./registration.js";

function pinnedOnPath(): boolean {
  try {
    const line = execFileSync("codex", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    return line === VERSION_LINE;
  } catch {
    return false;
  }
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "Bayon Agent",
  GIT_AUTHOR_EMAIL: "agent@bayon.invalid",
  GIT_COMMITTER_NAME: "Bayon Agent",
  GIT_COMMITTER_EMAIL: "agent@bayon.invalid",
};
/** What a turn host's env could hold that would hand the host's git config back. */
const HOSTILE = {
  GIT_CONFIG_GLOBAL: "/home/operator/.gitconfig",
  GIT_CONFIG_COUNT: "0",
};

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

describe.skipIf(!pinnedOnPath())(
  "the pinned CLI's shell env under securityArgs",
  { timeout: 60_000 },
  () => {
    let root = "";
    let codexHome = "";
    beforeAll(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "frm-codex-env-")));
      codexHome = join(root, "codex");
      mkdirSync(codexHome);
      mkdirSync(join(root, "home"));
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    /** Codex's own env: the npm CLI is a node script, so the node running this is on its PATH. */
    const codexEnv = (env: Readonly<Record<string, string>>) => ({
      PATH: `${dirname(process.execPath)}:${process.env["PATH"] ?? ""}`,
      HOME: join(root, "home"),
      CODEX_HOME: codexHome,
      ...env,
    });

    /** The shell_environment_policy overrides securityArgs puts on a turn whose session env is `env`. */
    const policyOf = (env: Readonly<Record<string, string>>): string[] =>
      securityArgs({
        bin: ["codex"],
        cwd: root,
        model: CHEAP_MODEL,
        sandbox: "workspace-write",
        shellEnv: env,
      }).flatMap((arg, i, all) =>
        all[i - 1] === "-c" && arg.startsWith("shell_environment_policy.")
          ? ["-c", arg]
          : [],
      );

    /** `env` as `codex sandbox` runs it under `policy`. */
    function sandboxEnv(
      policy: readonly string[],
      env: Readonly<Record<string, string>>,
    ): Record<string, string> {
      const r = spawnSync(
        "codex",
        ["sandbox", ...policy, "--", "/usr/bin/env"],
        { cwd: root, encoding: "utf8", timeout: 30_000, env: codexEnv(env) },
      );
      expect(r.status, r.stderr).toBe(0);
      return envOf(r.stdout);
    }

    test("sandbox: the floor and the identity reach the shell by set; a secret does not", () => {
      const env = {
        ...IDENTITY,
        ...HOSTILE,
        CODEX_API_KEY: "sk-never-in-the-shell",
        [MCP_TOKEN_ENV]: "frm-never-in-the-shell",
      };
      const seen = sandboxEnv(policyOf(env), env);
      expect(seen).toMatchObject({ ...SESSION_GIT_ENV, ...IDENTITY });
      expect(seen).not.toHaveProperty("CODEX_API_KEY");
      expect(seen).not.toHaveProperty(MCP_TOKEN_ENV);
    });

    test("sandbox: without set, inherit=core drops them both, whatever include_only names", () => {
      const before = policyOf(IDENTITY).filter(
        (arg, i, all) =>
          !arg.startsWith("shell_environment_policy.set=") &&
          !all[i + 1]?.startsWith("shell_environment_policy.set="),
      );
      const seen = sandboxEnv(before, { ...IDENTITY, ...SESSION_GIT_ENV });
      for (const name of [
        ...Object.keys(IDENTITY),
        ...Object.keys(SESSION_GIT_ENV),
      ]) {
        expect(seen).not.toHaveProperty(name);
      }
    });

    describe("exec: one real turn whose model runs `env`", () => {
      let server: Server;
      let base = "";
      const bodies: string[] = [];
      beforeAll(async () => {
        server = createServer((req, res) => {
          let body = "";
          req.on("data", (chunk: Buffer) => (body += chunk.toString()));
          req.on("end", () => {
            bodies.push(body);
            const answered = body.includes('"function_call_output"');
            const id = `resp_${bodies.length}`;
            const item = answered
              ? {
                  type: "message",
                  role: "assistant",
                  id: "msg_1",
                  content: [{ type: "output_text", text: "done" }],
                }
              : {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_1",
                  name: "exec_command",
                  arguments: JSON.stringify({ cmd: "env" }),
                };
            const usage = {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            };
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const e of [
              { type: "response.created", response: { id } },
              { type: "response.output_item.done", item },
              { type: "response.completed", response: { id, usage } },
            ]) {
              res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
            }
            res.end();
          });
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("the stand-in has no port");
        }
        base = `http://127.0.0.1:${address.port}/v1`;
      });
      afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });

      test("the model's shell gets the floor and the identity, over hostile values in Codex's own env", async () => {
        const work = join(root, "work");
        mkdirSync(work, { recursive: true });
        const argv = turnArgv({
          bin: ["codex"],
          cwd: work,
          model: CHEAP_MODEL,
          sandbox: "workspace-write",
          shellEnv: IDENTITY,
        });
        // The stand-in is the model provider: config for this run only, before the cwd flag.
        const at = argv.indexOf("-C");
        const provider = [
          'model_provider="standin"',
          'model_providers.standin.name="standin"',
          `model_providers.standin.base_url="${base}"`,
          'model_providers.standin.wire_api="responses"',
        ].flatMap((kv) => ["-c", kv]);
        const args = [...argv.slice(1, at), ...provider, ...argv.slice(at)];
        await new Promise<void>((resolve, reject) => {
          const child = execFile(
            "codex",
            args,
            {
              cwd: work,
              timeout: 45_000,
              env: codexEnv({ ...IDENTITY, ...HOSTILE }),
            },
            (error) => (error === null ? resolve() : reject(error)),
          );
          child.stdin?.end("Run env.");
        });
        const output = bodies
          .map((b) => JSON.parse(b) as { input?: unknown[] })
          .flatMap((b) => b.input ?? [])
          .flatMap((i) => {
            const item = i as { type?: string; output?: unknown };
            return item.type === "function_call_output"
              ? [String(item.output)]
              : [];
          });
        expect(output).toHaveLength(1);
        expect(envOf(output[0] ?? "")).toMatchObject({
          ...SESSION_GIT_ENV,
          ...IDENTITY,
        });
      });
    });
  },
);
