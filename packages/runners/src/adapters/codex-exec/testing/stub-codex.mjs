// A stand-in for the Codex CLI 0.154.0, so CI drives the real turn host and
// the real local executor without a credential. It speaks `exec` and `exec resume <id>` with
// `--json`, reads the prompt from stdin, and writes exec_events.rs-shaped JSONL. It keeps its
// threads under $CODEX_HOME/stub/threads, records its argv and the sha-256 digests of the
// credentials it got (never a value) under $CODEX_HOME/stub, and touches logs_2.sqlite and
// sessions/ as Codex does. What a turn does comes from its prompt (the codex-exec conformance
// kit's), or from env:
//   FRM_STUB_HANG=1         hold before turn.completed; on SIGINT print nothing and exit 1, as
//                           0.154.0 does on an interrupted turn
//   FRM_STUB_REVIEW_HANG=1  the known review hang: a stream error, then silence, ignoring SIGINT
//   FRM_STUB_CRASH=1        exit 0 mid-turn, with no terminal
//   FRM_STUB_REFRESH_AUTH=x rewrite $CODEX_HOME/auth.json with x, as a token refresh does
//   FRM_STUB_LINGER_MS=N    leave a process in the session's group, as a tool's child can, that
//                           takes no signal but SIGKILL and writes into $CODEX_HOME/stub/linger
//                           for N ms (its pid in $CODEX_HOME/stub/linger.pid)
// `--frm-stub-version=X` (a bin argument, before exec) makes --version report another version.
/* global fetch -- Node 22's own */
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { setInterval, setTimeout } from "node:timers";

const argv = process.argv.slice(2);
const version =
  argv.find((a) => a.startsWith("--frm-stub-version="))?.split("=")[1] ??
  "0.154.0";
if (argv.includes("--version")) {
  process.stdout.write(`codex-cli ${version}\n`);
  process.exit(0);
}

const fail = (message) => {
  process.stderr.write(`stub: ${message}\n`);
  process.exit(1);
};

// --- argv -------------------------------------------------------------------------------------

const at = argv.indexOf("exec");
if (at === -1) fail("only exec is supported");
const rest = argv.slice(at + 1);
const resume = rest[0] === "resume";
const opts = resume ? rest.slice(1) : rest;
const TAKES = new Set(["-c", "-m", "-C", "--output-schema", "-o", "-s"]);
const overrides = new Map();
const positionals = [];
let model;
let cwd = process.cwd();
let schemaPath;
let outPath;
for (let i = 0; i < opts.length; i += 1) {
  const a = opts[i];
  if (TAKES.has(a)) {
    const v = opts[(i += 1)];
    if (a === "-c")
      overrides.set(v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1));
    if (a === "-m") model = v;
    if (a === "-C") cwd = v;
    if (a === "--output-schema") schemaPath = v;
    if (a === "-o") outPath = v;
  } else if (a === "-" || !a.startsWith("-")) {
    positionals.push(a);
  }
}
if (!opts.includes("--json")) fail("--json is required");
if (positionals.at(-1) !== "-") fail("the prompt must come on stdin (-)");
if (model === undefined) fail("-m is required");
/** A `-c` value, as the TOML the CLI would parse. */
const setting = (key) => {
  const raw = overrides.get(key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

// --- home -------------------------------------------------------------------------------------

const home = process.env.CODEX_HOME;
if (home === undefined) fail("CODEX_HOME is not set");
const stubDir = join(home, "stub");
mkdirSync(join(stubDir, "threads"), { recursive: true });
mkdirSync(join(home, "sessions"), { recursive: true });
const n = readdirSync(stubDir).filter((f) => f.startsWith("argv-")).length;
writeFileSync(join(stubDir, `argv-${n}.json`), JSON.stringify(argv));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const creds = {};
for (const name of [
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_AUTH_JSON",
  "FRM_MCP_TOKEN",
]) {
  if (process.env[name] !== undefined) creds[name] = digest(process.env[name]);
}
if (existsSync(join(home, "auth.json")))
  creds["auth.json"] = digest(readFileSync(join(home, "auth.json")));
writeFileSync(join(stubDir, `env-${n}.json`), JSON.stringify(creds));
// The git env this process runs under: Codex's own git calls inherit it. Not secret.
writeFileSync(
  join(stubDir, `git-env-${n}.json`),
  JSON.stringify(
    Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.startsWith("GIT_")),
    ),
  ),
);
// FRM_STUB_REFRESH_AUTH=<text>: rewrite auth.json, as the CLI does when it mints a fresh access
// token and rotates the refresh token with it. Written verbatim, so a test can hand it
// a truncated file and see that none of it reaches the operator's own login.
const refreshedAuth = process.env.FRM_STUB_REFRESH_AUTH;
if (refreshedAuth !== undefined && existsSync(join(home, "auth.json")))
  writeFileSync(join(home, "auth.json"), refreshedAuth, { mode: 0o600 });
appendFileSync(join(home, "logs_2.sqlite"), "stub log db\n");
const lingerMs = Number(process.env.FRM_STUB_LINGER_MS ?? "0");
if (lingerMs > 0) {
  // It keeps (re)creating its dir in the home, as a straggler writing into a tree being removed
  // does. Its stdio is not the stub's, so the turn host sees this Codex close on time.
  const lingerer = spawn(
    process.execPath,
    [
      "-e",
      `const { appendFileSync, mkdirSync } = require("node:fs");
const [dir, ms] = process.argv.slice(1);
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => {});
const tick = setInterval(() => {
  mkdirSync(dir, { recursive: true });
  appendFileSync(dir + "/ticks", "tick\\n");
}, 20);
setTimeout(() => {
  clearInterval(tick);
  process.exit(0);
}, Number(ms));`,
      join(stubDir, "linger"),
      String(lingerMs),
    ],
    { stdio: "ignore" },
  );
  lingerer.unref();
  writeFileSync(join(stubDir, "linger.pid"), String(lingerer.pid));
}

const threadFile = (id) => join(stubDir, "threads", `${id}.json`);
const ZERO = {
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
};
let thread;
if (resume) {
  const id = positionals[0];
  if (id === undefined || !existsSync(threadFile(id))) fail(`no thread ${id}`);
  thread = JSON.parse(readFileSync(threadFile(id), "utf8"));
} else {
  thread = { id: randomUUID(), usage: ZERO, remembered: null, turns: 0 };
}
const save = () => writeFileSync(threadFile(thread.id), JSON.stringify(thread));

// --- a turn -----------------------------------------------------------------------------------

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const hold = () => setInterval(() => {}, 1 << 30);
let items = 0;
const nextId = () => `item_${(items += 1)}`;
let lastMessage = "";

function reply(text) {
  lastMessage = text;
  emit({
    type: "item.completed",
    item: { id: nextId(), type: "agent_message", text },
  });
}

function command(line, output, code) {
  const id = nextId();
  const item = {
    id,
    type: "command_execution",
    command: `/bin/zsh -lc '${line}'`,
  };
  emit({
    type: "item.started",
    item: {
      ...item,
      aggregated_output: "",
      exit_code: null,
      status: "in_progress",
    },
  });
  emit({
    type: "item.completed",
    item: {
      ...item,
      aggregated_output: output,
      exit_code: code,
      status: code === 0 ? "completed" : "failed",
    },
  });
}

async function rpc(url, token, id, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(
      id === undefined
        ? { jsonrpc: "2.0", method, params }
        : { jsonrpc: "2.0", id, method, params },
    ),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  if (id === undefined) return undefined;
  const text = await res.text();
  const body = (res.headers.get("content-type") ?? "").includes(
    "text/event-stream",
  )
    ? (text
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice(5) ?? "{}")
    : text;
  const message = JSON.parse(body);
  if (message.error !== undefined)
    throw new Error(`${method}: ${message.error.message}`);
  return message.result;
}

/**
 * 0.154.0's MCP tool-approval gate (codex-rs @ rust-v0.154.0: core/src/mcp_tool_call.rs,
 * codex-mcp/src/mcp/mod.rs, codex-mcp/src/server.rs). A tool's mode is its own
 * `approval_mode`, else the server's `default_tools_approval_mode`, else `auto`. Only `approve`, or
 * `approval_policy = never` under full disk access, skips the gate. Every other mode needs approval
 * for a tool with no annotations, which is every tool the probe and the API serve. Under `never`
 * that approval is denied, and the call never leaves the CLI. The reason, or null when the call goes.
 */
function approvalRefusal(tool) {
  const mode =
    setting(`mcp_servers.foreman.tools.${tool}.approval_mode`) ??
    setting("mcp_servers.foreman.default_tools_approval_mode") ??
    "auto";
  const policy = setting("approval_policy");
  if (mode === "approve") return null;
  if (policy === "never" && setting("sandbox_mode") === "danger-full-access")
    return null;
  return policy === "never"
    ? "MCP tool call requires approval, but approval policy is never"
    : `stub: approval policy ${String(policy)} would prompt, which the stub does not model`;
}

async function mcpCall(tool, args) {
  const url = setting("mcp_servers.foreman.url");
  const tokenEnv = setting("mcp_servers.foreman.bearer_token_env_var");
  const id = nextId();
  const item = {
    id,
    type: "mcp_tool_call",
    server: "foreman",
    tool,
    arguments: args,
  };
  emit({
    type: "item.started",
    item: { ...item, result: null, error: null, status: "in_progress" },
  });
  try {
    if (typeof url !== "string" || typeof tokenEnv !== "string")
      throw new Error("no MCP server configured");
    const refused = approvalRefusal(tool);
    if (refused !== null) throw new Error(refused);
    const token = process.env[tokenEnv] ?? "";
    await rpc(url, token, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "codex-stub", version },
    });
    await rpc(url, token, undefined, "notifications/initialized", undefined);
    const result = await rpc(url, token, 2, "tools/call", {
      name: tool,
      arguments: args,
    });
    emit({
      type: "item.completed",
      item: {
        ...item,
        result: { content: result?.content ?? [], structured_content: null },
        error: null,
        status: "completed",
      },
    });
  } catch (e) {
    emit({
      type: "item.completed",
      item: {
        ...item,
        result: null,
        error: { message: e instanceof Error ? e.message : String(e) },
        status: "failed",
      },
    });
  }
}

async function slow() {
  const id = nextId();
  emit({
    type: "item.started",
    item: {
      id,
      type: "command_execution",
      command: "/bin/zsh -lc 'sleep 30'",
      aggregated_output: "",
      exit_code: null,
      status: "in_progress",
    },
  });
  // 0.154.0 prints nothing on an interrupted turn and exits 1 (design fact 2).
  process.on("SIGINT", () => process.exit(1));
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  emit({
    type: "item.completed",
    item: {
      id,
      type: "command_execution",
      command: "/bin/zsh -lc 'sleep 30'",
      aggregated_output: "",
      exit_code: 0,
      status: "completed",
    },
  });
  reply("DONE");
}

/** add.js under the cwd exists and no longer returns a - b. */
function addFixed() {
  const path = join(cwd, "add.js");
  return existsSync(path) && !/\ba\s*-\s*b\b/.test(readFileSync(path, "utf8"));
}

async function turn(prompt) {
  const remember = /Remember this word for later: (\S+?)\./.exec(prompt);
  if (remember !== null) {
    thread.remembered = remember[1];
    return reply("OK");
  }
  if (prompt.includes("What was the word"))
    return reply(thread.remembered ?? "I do not remember.");
  if (prompt.includes("sleep 30")) return slow();
  if (prompt.includes("NOTES.md")) {
    const path = join(cwd, "NOTES.md");
    writeFileSync(path, "conformance\n");
    emit({
      type: "item.completed",
      item: {
        id: nextId(),
        type: "file_change",
        changes: [{ path, kind: "add" }],
        status: "completed",
      },
    });
    command("cat NOTES.md", "conformance\n", 0);
    return reply("DONE");
  }
  const touch = /`touch (\S+?)`/.exec(prompt);
  if (touch !== null) {
    if (setting("sandbox_mode") === "read-only") {
      command(
        `touch ${touch[1]}`,
        `touch: ${touch[1]}: Read-only file system\n`,
        1,
      );
      return reply("CANNOT");
    }
    writeFileSync(join(cwd, touch[1]), "");
    command(`touch ${touch[1]}`, "", 0);
    return reply("DONE");
  }
  const nonce = /argument nonce set to "([^"]+)"/.exec(prompt);
  if (nonce !== null) {
    await mcpCall(
      /Call the (\S+) tool/.exec(prompt)?.[1] ?? "conformance_echo",
      { nonce: nonce[1] },
    );
    return reply("DONE");
  }
  // A clean review, for a gate that must pass (engine tests put this in the ticket).
  if (schemaPath !== undefined && prompt.includes("frm-stub: clean review")) {
    return reply(
      JSON.stringify({ summary: "No problems found.", findings: [] }),
    );
  }
  // The planted bug below, fixed in the tree under review: a clean review (the M3 smoke's round 2
  // reviews the builder's fix at head).
  if (schemaPath !== undefined && addFixed()) {
    return reply(JSON.stringify({ summary: "add() adds.", findings: [] }));
  }
  if (schemaPath !== undefined || prompt.includes("Review the file add.js")) {
    return reply(
      JSON.stringify({
        summary: "add() subtracts instead of adding.",
        findings: [
          {
            severity: "major",
            summary: "add returns a - b instead of a + b",
            file: "add.js",
            line: 2,
            category: "correctness",
            detail_md: null,
          },
        ],
      }),
    );
  }
  return reply("OK");
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
appendFileSync(
  join(home, "sessions", `${thread.id}.jsonl`),
  `${JSON.stringify({ prompt })}\n`,
);
save();

emit({ type: "thread.started", thread_id: thread.id });
emit({ type: "turn.started" });
if (process.env.FRM_STUB_CRASH === "1") process.exit(0);
if (process.env.FRM_STUB_REVIEW_HANG === "1") {
  process.on("SIGINT", () => {});
  emit({
    type: "item.completed",
    item: { id: nextId(), type: "reasoning", text: "**Reviewing**" },
  });
  emit({
    type: "error",
    message: "stream disconnected before completion: error sending request",
  });
  hold();
} else {
  await turn(prompt);
  const add = {
    input_tokens: 1200,
    cached_input_tokens: 900,
    cache_write_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 5,
  };
  thread.usage = Object.fromEntries(
    Object.entries(thread.usage).map(([k, v]) => [k, v + (add[k] ?? 0)]),
  );
  thread.turns += 1;
  save();
  if (outPath !== undefined) writeFileSync(outPath, lastMessage);
  if (process.env.FRM_STUB_HANG === "1") {
    process.on("SIGINT", () => process.exit(1));
    hold();
  } else {
    emit({ type: "turn.completed", usage: thread.usage });
  }
}
