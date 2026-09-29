// an earlier change on the real opencode: the env its model's `bash` tool runs with, on the pinned binary,
// under its real Seatbelt profile, through the adapter and its turn host. One turn against a local
// stand-in for the OpenAI-compatible provider (the session's OLLAMA_BASE_URL), whose reply is one
// `bash` call running `env`; the tool message opencode sends back is the model shell's env. The
// session env is shaped like the supervisor's buildEnv (the agent identity, the git floor, a secret,
// PATH and the tags) and the session's MCP server is a local stand-in with a planted bearer. No
// model, no network past 127.0.0.1, no spend, no Keychain. Skipped unless the pinned opencode is on
// PATH and Seatbelt is here: the stub cannot be the evidence, since what is tested is opencode's
// own env handling inside its sandbox.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor, SESSION_GIT_ENV, SlotCounter } from "@bayon/executors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { MappedEvent, SpawnSpec } from "../../adapter.js";
import { createOpencodeAdapter } from "./adapter.js";
import {
  DEFAULTS,
  MODELS,
  OLLAMA_BASE_URL_ENV,
  VERSION_LINE,
} from "./registration.js";
import { SANDBOX_EXEC } from "./sandbox.js";
import { MCP_TOKEN_ENV } from "./tool-names.js";

function pinnedOnPath(): boolean {
  try {
    const line = execFileSync("opencode", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    return line === VERSION_LINE;
  } catch {
    return false;
  }
}

const PRESENT =
  process.platform === "darwin" && existsSync(SANDBOX_EXEC) && pinnedOnPath();

const IDENTITY = {
  GIT_AUTHOR_NAME: "Bayon Agent",
  GIT_AUTHOR_EMAIL: "agent@bayon.invalid",
  GIT_COMMITTER_NAME: "Bayon Agent",
  GIT_COMMITTER_EMAIL: "agent@bayon.invalid",
};
/** Fakes, never real credentials: each is only ever searched for in what the model's shell printed. */
const SECRET_NAME = "FRM_TEST_PROFILE_SECRET";
const SECRET = "fake-profile-secret-for-the-shell-env-test";
const MCP_BEARER = "frm-fake-mcp-bearer-for-the-shell-env-test";
const MODEL = MODELS.find((m) => m.tier === "cheap")?.model ?? "";

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

/** The names a shell env holds, each planted secret's value replaced, for the report. */
const redacted = (env: Readonly<Record<string, string>>): string[] =>
  Object.entries(env)
    .map(([name, value]) =>
      [SECRET, MCP_BEARER].some((secret) => value.includes(secret))
        ? `${name}=<planted secret>`
        : name,
    )
    .sort();

type ChatRequest = {
  readonly tools?: readonly {
    readonly function?: { readonly name?: string };
  }[];
  readonly messages?: readonly {
    readonly role?: string;
    readonly content?: unknown;
  }[];
};

/** A tool message's content as text: a string, or its text parts joined. */
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((p: unknown) =>
            typeof p === "object" && p !== null && "text" in p
              ? String((p as { text: unknown }).text)
              : "",
          )
          .join("\n")
      : "";

/**
 * An OpenAI-compatible chat endpoint: a request that offers `bash` and holds no tool result yet gets
 * one `bash` call running `env`; anything else (the answer after it, a title) gets "OK".
 */
function provider(bodies: ChatRequest[]): Promise<{
  readonly server: Server;
  readonly url: string;
}> {
  const chunk = (delta: object, finish: string | null, usage?: object) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-standin",
      object: "chat.completion.chunk",
      created: 1,
      model: "standin",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\n`;
  const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const request = JSON.parse(body || "{}") as ChatRequest;
      bodies.push(request);
      const offersBash = (request.tools ?? []).some(
        (t) => t.function?.name === "bash",
      );
      const answered = (request.messages ?? []).some((m) => m.role === "tool");
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (offersBash && !answered) {
        res.write(
          chunk(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_env",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({
                      command: "env",
                      description: "Print the environment",
                    }),
                  },
                },
              ],
            },
            null,
          ),
        );
        res.write(chunk({}, "tool_calls", usage));
      } else {
        res.write(chunk({ role: "assistant", content: "OK" }, null));
        res.write(chunk({}, "stop", usage));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      }),
    ),
  );
}

/** Just enough of an MCP server to be mounted: initialize, one tool; records each Authorization. */
function mcpServer(headers: (string | undefined)[]): Promise<{
  readonly server: Server;
  readonly url: string;
}> {
  const server = createServer((req, res) => {
    headers.push(req.headers.authorization);
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const m = JSON.parse(body || "{}") as {
        id?: number;
        method?: string;
        params?: { protocolVersion?: string };
      };
      if (req.method !== "POST" || m.id === undefined) {
        res.writeHead(req.method === "POST" ? 202 : 405);
        res.end();
        return;
      }
      const result =
        m.method === "initialize"
          ? {
              protocolVersion: m.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "stand-in", version: "1" },
            }
          : m.method === "tools/list"
            ? { tools: [{ name: "probe", inputSchema: { type: "object" } }] }
            : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
      }),
    ),
  );
}

describe.skipIf(!PRESENT)(
  "the pinned opencode's model shell env, under Seatbelt, through the adapter",
  { timeout: 180_000 },
  () => {
    const bodies: ChatRequest[] = [];
    const mcpHeaders: (string | undefined)[] = [];
    let api: Awaited<ReturnType<typeof provider>> | undefined;
    let mcp: Awaited<ReturnType<typeof mcpServer>> | undefined;
    let root = "";
    let outcome: unknown;
    let output = "";
    let seen: Record<string, string> = {};

    beforeAll(async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "frm-oc-env-")));
      api = await provider(bodies);
      mcp = await mcpServer(mcpHeaders);
      const cwd = join(root, "work");
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, "README.md"), "# fixture\n");
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          ["-c", "user.name=frm", "-c", "user.email=frm@localhost", ...args],
          { cwd, stdio: "ignore" },
        );
      git("init", "-q");
      git("add", ".");
      git("commit", "-qm", "init");
      const spec: SpawnSpec = {
        sessionId: "01OCSHELLENV",
        cwd,
        homeDir: join(root, "home"),
        // buildEnv's order: identity, the profile's env and the secrets, the floor, then the rest.
        env: {
          ...IDENTITY,
          [OLLAMA_BASE_URL_ENV]: `${api.url}/v1`,
          [SECRET_NAME]: SECRET,
          ...SESSION_GIT_ENV,
          PATH: process.env["PATH"] ?? "",
          FRM_SESSION_ID: "01OCSHELLENV",
          FRM_HOME_TAG: "shell-env-test",
        },
        model: MODEL,
        flags: { ...DEFAULTS },
        mcp: { url: mcp.url, token: MCP_BEARER, tools: ["probe"] },
      };
      const local = new LocalExecutor({
        id: "local",
        slots: new SlotCounter(2),
      });
      const adapter = createOpencodeAdapter({ graceMs: 5_000 });
      const home = await adapter.prepareHome(spec, local);
      if (!home.ok) throw new Error(home.error.message);
      const h = await adapter.spawn(spec, local);
      if (!h.ok) throw new Error(h.error.message);
      try {
        const records = adapter.records(h.value)[Symbol.asyncIterator]();
        const mapper = adapter.createMapper({ prices: MODELS });
        const sent = await adapter.send(h.value, {
          runId: "shell-env",
          text: "Run env with your bash tool.",
          promptPath: "/dev/null",
        });
        if (!sent.ok) throw new Error(sent.error.message);
        const events: MappedEvent[] = [];
        for (let offset = 0; ;) {
          const next = await records.next();
          if (next.done === true) break;
          events.push(
            ...mapper.map({ offset, bytes: next.value.bytes, ts: 1 }),
          );
          offset += next.value.bytes.length + 1;
          if (events.some((e) => e.kind === "terminal")) break;
        }
        outcome = events.find((e) => e.kind === "terminal")?.payload["outcome"];
      } finally {
        await adapter.stop(h.value, "graceful");
      }
      const outputs = bodies.flatMap((b) =>
        (b.messages ?? []).flatMap((m) =>
          m.role === "tool" ? [textOf(m.content)] : [],
        ),
      );
      output = [...new Set(outputs)].join("\n");
      seen = envOf(output);
      process.stdout.write(
        `opencode model shell env (${Object.keys(seen).length} names):\n  ${redacted(seen).join("\n  ")}\n`,
      );
    });
    afterAll(async () => {
      await Promise.all(
        [api?.server, mcp?.server].map(
          (s) =>
            new Promise<void>((resolve) =>
              s === undefined ? resolve() : s.close(() => resolve()),
            ),
        ),
      );
      if (root !== "") rmSync(root, { recursive: true, force: true });
    });

    test("the turn ran its one bash call and ended ok; the MCP server saw the bearer", () => {
      expect(outcome).toBe("ok");
      expect(Object.keys(seen).length).toBeGreaterThan(0);
      expect(mcpHeaders).toContain(`Bearer ${MCP_BEARER}`);
    });

    test("the model's bash sees the floor and the identity, as the session env holds them", () => {
      expect(seen).toMatchObject({ ...SESSION_GIT_ENV, ...IDENTITY });
    });

    test("no secret of the session's reaches the model's shell: not the profile's, not the MCP bearer", () => {
      expect(seen).not.toHaveProperty(SECRET_NAME);
      expect(seen).not.toHaveProperty(MCP_TOKEN_ENV);
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain(MCP_BEARER);
    });
  },
);
