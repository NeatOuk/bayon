// A stand-in for `opencode acp` 1.18.32, so CI drives the real turn host
// and the real local executor with no model and no network. It speaks the ACP subset the host uses
// (initialize, session/new, session/resume, session/set_config_option, session/prompt,
// session/cancel), in the shapes the spike recorded (fixtures/opencode/), and answers from the
// opencode conformance kit's prompts. It reads OPENCODE_CONFIG_CONTENT as opencode does:
// `{env:NAME}` substituted, the permission rules evaluated last-match-wins, the `foreman` MCP
// server called with its bearer. It keeps its sessions under $XDG_DATA_HOME/opencode/stub, and
// records its argv and the sha-256 digests of the credentials it got there (never a value).
// Modes (env):
//   FRM_STUB_CRASH=1  exit mid-turn, after the tool call starts: no answer to the prompt
//   FRM_STUB_ASK=1    a denied command first asks the client (session/request_permission)
// "Read exactly: `<path>`" runs its read tool as opencode's does: a path outside the cwd needs the
// `external_directory` rule for `<its dir>/*` (the context store's, while proxied), and the read
// itself runs in this process, so inside whatever sandbox it was started in.
// `--frm-stub-version=X` (a bin argument) makes --version report another version.
// Behind a context proxy (spec M12: its provider's headers carry x-frm-proxy), each prompt POSTs its
// history to <baseURL>/chat/completions, appending each answer's status to model-calls.jsonl in its
// stub dir. Asked to `cat` two files and find an error code and a TAG- (conformance test 17), it plays
// the model: cats both, reads back what the proxy forwarded (the test's upstream echoes it), takes the
// code from the compressed log and the original's path from the JSON block's marker, greps the tag
// out of that original, and answers "<code> <tag>".
/* global fetch -- Node 22's own */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers";

const argv = process.argv.slice(2);
const version =
  argv.find((a) => a.startsWith("--frm-stub-version="))?.split("=")[1] ??
  "1.18.33";
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}
const fail = (message) => {
  process.stderr.write(`stub: ${message}\n`);
  process.exit(1);
};
if (!argv.includes("acp")) fail("only acp is supported");

// --- config, as opencode loads it ---------------------------------------------------------------

const substitute = (value) => {
  if (typeof value === "string")
    return value.replace(
      /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_, n) => process.env[n] ?? "",
    );
  if (Array.isArray(value)) return value.map(substitute);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substitute(v)]),
    );
  return value;
};
const rawConfig = process.env.OPENCODE_CONFIG_CONTENT;
if (rawConfig === undefined) fail("OPENCODE_CONFIG_CONTENT is not set");
const config = substitute(JSON.parse(rawConfig));
const providerOptions =
  config.provider?.[String(config.model ?? "").split("/")[0]]?.options ?? {};
const proxied =
  typeof providerOptions.baseURL === "string" &&
  providerOptions.baseURL.startsWith("http://127.0.0.1:") &&
  (providerOptions.headers?.["x-frm-proxy"] ?? "") !== "";

const wildcard = (input, pattern) => {
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s").test(input);
};
const rules = Object.entries(config.permission ?? {}).flatMap(
  ([permission, value]) =>
    typeof value === "string"
      ? [{ permission, pattern: "*", action: value }]
      : Object.entries(value).map(([pattern, action]) => ({
          permission,
          pattern,
          action,
        })),
);
/** opencode's evaluate: the last matching rule, or ask. */
const decide = (permission, pattern) =>
  rules.findLast(
    (r) => wildcard(permission, r.permission) && wildcard(pattern, r.pattern),
  )?.action ?? "ask";

// --- home ---------------------------------------------------------------------------------------

const data = process.env.XDG_DATA_HOME;
if (data === undefined) fail("XDG_DATA_HOME is not set");
const stubDir = join(data, "opencode", "stub");
mkdirSync(join(stubDir, "sessions"), { recursive: true });
appendFileSync(join(data, "opencode", "opencode.db"), "stub db\n");
const n = readdirSync(stubDir).filter((f) => f.startsWith("argv-")).length;
writeFileSync(join(stubDir, `argv-${n}.json`), JSON.stringify(argv));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const creds = {};
for (const name of [
  "FRM_MCP_TOKEN",
  "OPENCODE_SERVER_PASSWORD",
  "FRM_CTX_TOKEN",
]) {
  if (process.env[name] !== undefined) creds[name] = digest(process.env[name]);
}
writeFileSync(join(stubDir, `env-${n}.json`), JSON.stringify(creds));
// What a model's `env` would print, names only: every tool inherits this process's env.
writeFileSync(
  join(stubDir, `env-names-${n}.json`),
  JSON.stringify(Object.keys(process.env).sort()),
);
writeFileSync(join(stubDir, `config-${n}.json`), rawConfig);
// The git env every tool inherits, values included: none of it is secret.
writeFileSync(
  join(stubDir, `git-env-${n}.json`),
  JSON.stringify(
    Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.startsWith("GIT_")),
    ),
  ),
);

const sessionFile = (id) => join(stubDir, "sessions", `${id}.json`);
const load = (id) =>
  existsSync(sessionFile(id))
    ? JSON.parse(readFileSync(sessionFile(id), "utf8"))
    : undefined;
const save = (s) => writeFileSync(sessionFile(s.id), JSON.stringify(s));

// --- the wire -----------------------------------------------------------------------------------

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const respond = (id, result) => emit({ jsonrpc: "2.0", id, result });
const refuse = (id, code, message, data) =>
  emit({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
const update = (sessionId, u) =>
  emit({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: u },
  });

let mcpServers = [];
let nextOut = 0;
const waiting = new Map();
/** A request to the client (the host); resolves with its answer. */
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextOut++;
    waiting.set(id, resolve);
    emit({ jsonrpc: "2.0", id, method, params });
  });

// --- a turn -------------------------------------------------------------------------------------

let current = null; // { id, sessionId, cancelled, wake }
let messages = 0;
let calls = 0;

function reply(sessionId, text) {
  const messageId = `msg_stub${(messages += 1)}`;
  const cut = Math.ceil(text.length / 2);
  for (const piece of [text.slice(0, cut), text.slice(cut)]) {
    if (piece !== "")
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: piece },
      });
  }
}

function tool(sessionId, name, input) {
  const toolCallId = `call_stub${(calls += 1)}`;
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId,
    title: name,
    kind: name === "bash" ? "execute" : name === "write" ? "edit" : "other",
    status: "pending",
    locations: [],
    rawInput: {},
  });
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "in_progress",
    title: name === "bash" ? input.command : name,
    locations: [],
    rawInput: input,
  });
  return {
    done: (output, metadata = {}) =>
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: output } }],
        rawOutput: { output, metadata },
      }),
    failed: (error) =>
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: error } }],
        rawOutput: { error },
      }),
  };
}

const DENIED =
  "The user has specified a rule which prevents you from using this specific tool call.";

async function shell(turn, command, run) {
  const t = tool(turn.sessionId, "bash", {
    command,
    description: command,
    cwd: process.cwd(),
  });
  const action = decide("bash", command);
  if (
    action === "ask" ||
    (action === "deny" && process.env.FRM_STUB_ASK === "1")
  ) {
    const answer = await ask("session/request_permission", {
      sessionId: turn.sessionId,
      toolCall: {
        toolCallId: "ask",
        status: "pending",
        title: "bash",
        rawInput: { command },
      },
      options: [{ optionId: "reject", kind: "reject_once", name: "Reject" }],
    });
    void answer;
    t.failed("The user rejected permission to use this specific tool call.");
    return false;
  }
  if (action === "deny") {
    t.failed(DENIED);
    return false;
  }
  const output = run();
  t.done(output, { output, exit: 0, truncated: false });
  return true;
}

async function slow(turn) {
  // A real command in a process group of its own, as opencode's shell tool runs one.
  const sleeper = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  sleeper.unref();
  writeFileSync(join(stubDir, "tool-pid"), String(sleeper.pid));
  const t = tool(turn.sessionId, "bash", {
    command: "sleep 30",
    description: "wait",
  });
  if (process.env.FRM_STUB_CRASH === "1") process.exit(0);
  // A cancel may already be in: read in the same stdin chunk as its prompt, it landed while this
  // turn was still on its way here, before there was anything to wake.
  if (!turn.cancelled) {
    await new Promise((resolve) => {
      turn.wake = resolve;
      setTimeout(resolve, 30_000);
    });
  }
  try {
    process.kill(-sleeper.pid, "SIGKILL");
  } catch {
    // already gone
  }
  if (turn.cancelled) {
    const text =
      "(no output)\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>";
    t.done(text, { output: text, exit: null, truncated: false });
    return;
  }
  t.done("", { output: "", exit: 0, truncated: false });
  reply(turn.sessionId, "DONE");
}

async function rpc(url, headers, id, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
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

async function mcpCall(turn, wire, args) {
  const name = `foreman_${wire.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const t = tool(turn.sessionId, name, args);
  // opencode keeps ACP-given MCP servers in memory (acp/service.ts registerMcpServers).
  const server = mcpServers.find((m) => m.name === "foreman");
  try {
    if (server === undefined || server.type !== "http")
      throw new Error("no foreman MCP server");
    if (decide(name, "*") !== "allow") throw new Error(DENIED);
    const headers = Object.fromEntries(
      (server.headers ?? []).map((h) => [h.name, h.value]),
    );
    await rpc(server.url, headers, 1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "opencode-stub", version },
    });
    await rpc(
      server.url,
      headers,
      undefined,
      "notifications/initialized",
      undefined,
    );
    const result = await rpc(server.url, headers, 2, "tools/call", {
      name: wire,
      arguments: args,
    });
    const text = (result?.content ?? []).map((c) => c.text ?? "").join("");
    t.done(text, { truncated: false });
  } catch (e) {
    t.failed(e instanceof Error ? e.message : String(e));
  }
}

/** POSTs a chat history as opencode's provider would; the answer's JSON (an echo's: the body forwarded). */
async function modelCall(messages) {
  if (!proxied) return undefined;
  const res = await fetch(`${providerOptions.baseURL}/chat/completions`, {
    method: "POST",
    headers: { ...providerOptions.headers, "content-type": "application/json" },
    body: JSON.stringify({ model: config.model, messages, stream: false }),
  });
  const text = await res.text();
  appendFileSync(
    join(stubDir, "model-calls.jsonl"),
    `${JSON.stringify({ status: res.status })}\n`,
  );
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const bashCall = (id, command) => ({
  id,
  type: "function",
  function: { name: "bash", arguments: JSON.stringify({ command }) },
});

/** Test 17's turn: the model's part, played from what the proxy forwarded. */
async function contextWork(turn, text, files) {
  const messages = [{ role: "user", content: text }];
  await modelCall(messages);
  const outputs = [];
  for (const file of files) {
    await shell(turn, `cat ${file}`, () => {
      const out = readFileSync(join(process.cwd(), file), "utf8");
      outputs.push(out);
      return out;
    });
  }
  messages.push(
    {
      role: "assistant",
      content: "",
      tool_calls: files.map((f, i) => bashCall(`call_ctx${i}`, `cat ${f}`)),
    },
    ...outputs.map((content, i) => ({
      role: "tool",
      tool_call_id: `call_ctx${i}`,
      content,
    })),
  );
  const forwarded = ((await modelCall(messages))?.messages ?? [])
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : ""));
  const code = forwarded.join("\n").match(/ERROR (E-\d+)/)?.[1] ?? "no-code";
  const original = forwarded[1]?.match(/Original: (.+?) — read it/)?.[1];
  let tag = "no-tag";
  const grep = `grep -o 'TAG-[A-Za-z0-9-]*' ${original ?? "?"}`;
  await shell(turn, grep, () => {
    tag =
      original === undefined
        ? "no-tag"
        : (readFileSync(original, "utf8").match(/TAG-[A-Za-z0-9-]+/)?.[0] ??
          "no-tag");
    return tag;
  });
  messages.push(
    {
      role: "assistant",
      content: "",
      tool_calls: [bashCall("call_ctx9", grep)],
    },
    { role: "tool", tool_call_id: "call_ctx9", content: tag },
  );
  await modelCall(messages);
  return reply(turn.sessionId, `${code} ${tag}`);
}

/** add.js under the cwd exists and no longer returns a - b. */
const addFixed = () => {
  const path = join(process.cwd(), "add.js");
  return existsSync(path) && !/\ba\s*-\s*b\b/.test(readFileSync(path, "utf8"));
};

async function work(turn, session, text) {
  const remember = /Remember this word for later: (\S+?)\./.exec(text);
  if (remember !== null) {
    session.remembered = remember[1];
    return reply(turn.sessionId, "OK");
  }
  if (text.includes("What was the word"))
    return reply(turn.sessionId, session.remembered ?? "I do not remember.");
  if (text.includes("sleep 30")) return slow(turn);
  if (text.includes("NOTES.md")) {
    const path = join(process.cwd(), "NOTES.md");
    const existed = existsSync(path);
    const t = tool(turn.sessionId, "write", {
      filePath: "NOTES.md",
      content: "conformance\n",
    });
    if (decide("edit", "NOTES.md") !== "allow") t.failed(DENIED);
    else {
      writeFileSync(path, "conformance\n");
      t.done("Wrote file successfully.", {
        filepath: path,
        exists: existed,
        truncated: false,
      });
    }
    await shell(turn, "cat NOTES.md", () => readFileSync(path, "utf8"));
    return reply(turn.sessionId, "DONE");
  }
  const cats = [...text.matchAll(/`cat (\S+?)`/g)].map((m) => m[1]);
  if (cats.length === 2 && text.includes("TAG-")) {
    return contextWork(turn, text, cats);
  }
  const readExactly = /^Read exactly: `([^`]+)`$/.exec(
    text.split("\n")[0] ?? "",
  );
  if (readExactly !== null) {
    const path = readExactly[1];
    const t = tool(turn.sessionId, "read", { filePath: path });
    const rel = relative(process.cwd(), path);
    const outside = isAbsolute(rel) || rel.startsWith("..");
    const allowed = outside
      ? decide("external_directory", join(dirname(path), "*")) === "allow"
      : decide("read", path) === "allow";
    if (!allowed) {
      t.failed(DENIED);
      return reply(turn.sessionId, "CANNOT");
    }
    try {
      const output = readFileSync(path, "utf8");
      t.done(output, { preview: output.slice(0, 100), truncated: false });
      return reply(turn.sessionId, "DONE");
    } catch (e) {
      t.failed(e instanceof Error ? e.message : String(e));
      return reply(turn.sessionId, "FAILED");
    }
  }
  // Any command, run by the shell as opencode's bash tool runs it (the sandbox tests use this).
  const exact = /^Run exactly: `([^`]+)`$/.exec(text.split("\n")[0] ?? "");
  if (exact !== null) {
    let status = 0;
    await shell(turn, exact[1], () => {
      const r = spawnSync("/bin/sh", ["-c", exact[1]], { encoding: "utf8" });
      status = r.status ?? 1;
      return `${r.stdout ?? ""}${r.stderr ?? ""}exit ${status}`;
    });
    return reply(turn.sessionId, status === 0 ? "DONE" : "FAILED");
  }
  const touch = /`touch (\S+?)`/.exec(text);
  if (touch !== null) {
    const ran = await shell(turn, `touch ${touch[1]}`, () => {
      writeFileSync(join(process.cwd(), touch[1]), "");
      return "";
    });
    return reply(turn.sessionId, ran ? "DONE" : "CANNOT");
  }
  const nonce = /argument nonce set to "([^"]+)"/.exec(text);
  if (nonce !== null) {
    await mcpCall(
      turn,
      /Call the (\S+) tool/.exec(text)?.[1] ?? "conformance_echo",
      {
        nonce: nonce[1],
      },
    );
    return reply(turn.sessionId, "DONE");
  }
  if (
    text.includes("frm-stub: clean review") ||
    (text.includes("opencode-output/1") && addFixed())
  )
    return reply(
      turn.sessionId,
      JSON.stringify({ summary: "No problems found.", findings: [] }),
    );
  if (
    text.includes("Review the file add.js") ||
    text.includes("opencode-output/1")
  ) {
    return reply(
      turn.sessionId,
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
  return reply(turn.sessionId, "OK");
}

const USAGE = {
  inputTokens: 1200,
  outputTokens: 20,
  totalTokens: 3270,
  cachedReadTokens: 2050,
};

async function prompt(id, params) {
  const session = load(params?.sessionId);
  if (session === undefined)
    return refuse(
      id,
      -32602,
      `Invalid params: session not found: ${params?.sessionId}`,
    );
  if (current !== null)
    return refuse(id, -32603, "Internal error: session is busy");
  const text = (params.prompt ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  const turn = { id, sessionId: session.id, cancelled: false, wake: undefined };
  current = turn;
  try {
    // Every other turn's one model call; test 17's turn makes its own.
    if (!text.includes("TAG-"))
      await modelCall([{ role: "user", content: text }]);
    await work(turn, session, text);
    session.turns += 1;
    save(session);
    current = null;
    respond(
      id,
      turn.cancelled
        ? {
            stopReason: "cancelled",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            _meta: {},
          }
        : { stopReason: "end_turn", usage: USAGE, _meta: {} },
    );
  } catch (e) {
    current = null;
    refuse(
      id,
      -32603,
      `Internal error: ${e instanceof Error ? e.message : String(e)}`,
      {
        service: "session",
        errorName: "UnknownError",
      },
    );
  }
}

function modelKnown(value) {
  const at = typeof value === "string" ? value.indexOf("/") : -1;
  if (at < 1) return false;
  const provider = config.provider?.[value.slice(0, at)];
  return provider?.models?.[value.slice(at + 1)] !== undefined;
}

function onMessage(m) {
  if (m.method === undefined) {
    const resolve = waiting.get(m.id);
    waiting.delete(m.id);
    resolve?.(m);
    return;
  }
  const { id, method, params } = m;
  switch (method) {
    case "initialize":
      return respond(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {} },
        },
        authMethods: [],
        agentInfo: { name: "OpenCode", version },
      });
    case "session/new": {
      mcpServers = Array.isArray(params?.mcpServers) ? params.mcpServers : [];
      // For tests: where the MCP server is, never its headers.
      writeFileSync(
        join(stubDir, "mcp-urls.json"),
        JSON.stringify(mcpServers.map((m) => m.url)),
      );
      const s = {
        id: `ses_stub${randomUUID().replaceAll("-", "")}`,
        remembered: null,
        turns: 0,
        model: config.model,
      };
      save(s);
      respond(id, { sessionId: s.id, configOptions: [] });
      return update(s.id, {
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      });
    }
    case "session/resume":
      mcpServers = Array.isArray(params?.mcpServers) ? params.mcpServers : [];
      return load(params?.sessionId) === undefined
        ? refuse(
            id,
            -32602,
            `Invalid params: session not found: ${params?.sessionId}`,
            {
              sessionId: params?.sessionId,
            },
          )
        : respond(id, { configOptions: [] });
    case "session/set_config_option": {
      const s = load(params?.sessionId);
      if (s === undefined)
        return refuse(id, -32602, "Invalid params: session not found");
      if (params.configId !== "model" || !modelKnown(params.value))
        return refuse(
          id,
          -32602,
          `Invalid params: model not found: ${params.value}`,
        );
      save({ ...s, model: params.value });
      return respond(id, { configOptions: [] });
    }
    case "session/prompt":
      return void prompt(id, params);
    case "session/cancel":
      if (current !== null && current.sessionId === params?.sessionId) {
        current.cancelled = true;
        current.wake?.();
      }
      return;
    default:
      if (id !== undefined) refuse(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  onMessage(m);
});
rl.on("close", () => process.exit(0));
