// A stand-in for the runner CLI (design §9), so CI runs the real SDK and the real local executor
// without an API key. It speaks just enough stream-json: it answers the SDK's control requests,
// replays one fixture run per user message under the session id from its argv, writes its argv to
// $CLAUDE_CONFIG_DIR/argv.json and the credential env vars it got, as sha-256 digests so a test
// never prints a value, to $CLAUDE_CONFIG_DIR/auth.json, and exits on stdin EOF. It also writes the
// settings env the CLI would lay over its own env to $CLAUDE_CONFIG_DIR/settings-env.json:
// the cwd's .claude/settings.json and settings.local.json for the sources --setting-sources names,
// then --settings, later winning per name, as the CLI applies them; credentials as digests again.
// The initialize request's system prompt append (the SDK's systemPrompt.append) goes to
// $CLAUDE_CONFIG_DIR/initialize.json.
//   FRM_STUB_FIXTURE   a fixture .jsonl to replay (default: one plain text run)
//   FRM_STUB_HANG=1    hold each run open before its result, until interrupted
//   FRM_STUB_SILENT=1  never answer control requests: a handshake that never completes
//   FRM_STUB_MCP_SET=error  refuse mcp_set_servers with an error that quotes the request's headers
//   FRM_STUB_MCP_SET=hang   never answer mcp_set_servers (it still writes mcp-set.json)
// Its pid goes to $CLAUDE_CONFIG_DIR/pid.json, so a test can see the process is gone.
// With --json-schema (SDK outputFormat) every run ends on a StructuredOutput call, its answer in the
// result's structured_output, decided from the prompt as the codex stand-in decides a review: clean
// for "frm-stub: clean review" or a fixed add.js in the cwd, else the planted add.js bug. And:
//   FRM_STUB_STRUCTURED=missing    a success result with no structured_output
//   FRM_STUB_STRUCTURED=exhausted  the CLI's retries at the schema ran out
// Given a server by an mcp_set_servers control request (the adapter's mount) or by
// --mcp-config, it is an MCP client too: it writes what was set to $CLAUDE_CONFIG_DIR/mcp-set.json
// (the Authorization header as a digest), initializes with the headers as given, lists the tools
// into $CLAUDE_CONFIG_DIR/mcp-tools.json and, per user message, runs:
//   FRM_STUB_MCP       a JSON array of {tool, args}: each a tool_use/tool_result frame pair
//   FRM_STUB_ECHO      env names to echo in tool results (test 15): a small one, one that spills,
//                      and one carrying a truncation marker that points outside logs/tool/
// Behind a context proxy (spec M12: its effective ANTHROPIC_BASE_URL a loopback http URL and an
// x-frm-proxy line in ANTHROPIC_CUSTOM_HEADERS, --settings applied over its env as the CLI does), it
// POSTs each run's history to <base>/v1/messages, appending each answer's status to
// $CLAUDE_CONFIG_DIR/model-calls.jsonl. With FRM_STUB_CTX={"log":…,"json":…} (conformance test 17)
// it plays the model: cats both files, reads back what the proxy forwarded (the test's upstream echoes
// it), takes the error code from the compressed log and the original's path from the JSON block's
// marker, greps the tag out of that original, and answers "<code> <tag>".
// With FRM_STUB_MODEL_400=<have>:<need> every run answers a synthetic API-error result
// frame instead of a reply: `is_error`, `api_error_status: 400`, and an `errors` entry reading
// "Claude Code <have> does not support this model; version <need> or newer is required", the CLI's
// own words for a model too new for the pinned version.
/* global fetch -- Node 22's own, which the MCP client mode uses */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

const CREDENTIALS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "FRM_MCP_TOKEN",
];

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("2.1.284 (stub)\n");
  process.exit(0);
}

const flag = (name) =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const sessionId = flag("session-id") ?? flag("resume") ?? "stub-session";
const home = process.env.CLAUDE_CONFIG_DIR;
if (home !== undefined) {
  writeFileSync(join(home, "pid.json"), JSON.stringify(process.pid));
  writeFileSync(join(home, "argv.json"), JSON.stringify(argv));
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const auth = CREDENTIALS.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, digest(value)]];
  });
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify(Object.fromEntries(auth)),
  );
  const applied = settingsEnv().map(([name, value]) => [
    name,
    CREDENTIALS.includes(name) ? digest(String(value)) : value,
  ]);
  writeFileSync(
    join(home, "settings-env.json"),
    JSON.stringify(Object.fromEntries(applied)),
  );
}

/** The `env` block of a settings JSON, or none: a missing or unreadable file is no settings. */
function envOf(text) {
  try {
    const env = JSON.parse(text)?.env;
    return typeof env === "object" && env !== null ? env : {};
  } catch {
    return {};
  }
}

/** The repo's files for the sources on argv, then --settings: the CLI's order, later wins. */
function settingsEnv() {
  const sources = (flag("setting-sources") ?? "").split(",");
  const file = (name) => {
    const path = join(process.cwd(), ".claude", name);
    return existsSync(path) ? envOf(readFileSync(path, "utf8")) : {};
  };
  const at = argv.indexOf("--settings");
  const layers = [
    sources.includes("project") ? file("settings.json") : {},
    sources.includes("local") ? file("settings.local.json") : {},
    at === -1 ? {} : envOf(argv[at + 1] ?? ""),
  ];
  return Object.entries(Object.assign({}, ...layers));
}
/** What the CLI's env holds for `name` once --settings is laid over it; "" is unset, as for it. */
const applied = Object.fromEntries(settingsEnv());
const effective = (name) => {
  const value = applied[name] ?? process.env[name];
  return value === undefined || value === "" ? undefined : String(value);
};
/** ANTHROPIC_CUSTOM_HEADERS as the CLI parses it: one `Name: value` per line. */
const customHeaders = Object.fromEntries(
  (effective("ANTHROPIC_CUSTOM_HEADERS") ?? "")
    .split("\n")
    .map((line) => [
      line.slice(0, line.indexOf(":")).trim(),
      line.slice(line.indexOf(":") + 1).trim(),
    ])
    .filter(([name]) => name !== ""),
);
const modelBase = effective("ANTHROPIC_BASE_URL");
const proxied =
  modelBase !== undefined &&
  modelBase.startsWith("http://127.0.0.1:") &&
  customHeaders["x-frm-proxy"] !== undefined;
const hang = process.env.FRM_STUB_HANG === "1";
const silent = process.env.FRM_STUB_SILENT === "1";
// FRM_STUB_SLOW_RUNS=n: the first n runs start a Bash tool call and hold open until interrupted.
const slowRuns = Number(process.env.FRM_STUB_SLOW_RUNS ?? "0");
const modelBlock400 = process.env.FRM_STUB_MODEL_400;

const usage = {
  input_tokens: 10,
  output_tokens: 2,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const PLAIN = [
  {
    type: "system",
    subtype: "init",
    session_id: "",
    cwd: process.cwd(),
    tools: [],
    mcp_servers: [],
    model: "stub-model",
    permissionMode: "acceptEdits",
    claude_code_version: "2.1.284",
  },
  {
    type: "assistant",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      id: "msg_stub",
      model: "stub-model",
      content: [{ type: "text", text: "stub reply" }],
      stop_reason: "end_turn",
      usage,
    },
  },
  {
    type: "result",
    subtype: "success",
    session_id: "",
    is_error: false,
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    result: "stub reply",
    stop_reason: "end_turn",
    total_cost_usd: 0.0001,
    usage,
    modelUsage: {
      "stub-model": {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.0001,
        contextWindow: 200000,
        maxOutputTokens: 8000,
      },
    },
    permission_denials: [],
    terminal_reason: "completed",
  },
];

/** A fixture's runs: its frames split after each result, without the hand-authored marker. */
function loadRuns(path) {
  const frames = readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return []; // blank lines and the partial last line of a crash fixture
      }
    })
    .filter((frame) => frame.type !== "fixture_meta");
  const runs = [[]];
  for (const frame of frames) {
    runs.at(-1).push(frame);
    if (frame.type === "result") runs.push([]);
  }
  return runs.filter((run) => run.length > 0);
}

const fixture = process.env.FRM_STUB_FIXTURE;
const runs = fixture === undefined ? [PLAIN] : loadRuns(fixture);

// --- structured output (--json-schema) ---------------------------------------------------------

const schemaAt = argv.indexOf("--json-schema");
const jsonSchema = schemaAt === -1 ? undefined : argv[schemaAt + 1];
const STRUCTURED_TOOL = "StructuredOutput";

/** add.js under the cwd exists and no longer returns a - b (the codex stand-in's rule). */
function addFixed() {
  const path = join(process.cwd(), "add.js");
  return existsSync(path) && !/\ba\s*-\s*b\b/.test(readFileSync(path, "utf8"));
}

/** The review this prompt gets, as the codex stand-in answers one. */
function review(prompt) {
  if (prompt.includes("frm-stub: clean review")) {
    return { summary: "No problems found.", findings: [] };
  }
  if (addFixed()) return { summary: "add() adds.", findings: [] };
  return {
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
  };
}

/** One run of a process started with a schema: init lists the tool, the run ends on its call. */
function structuredRun(prompt) {
  const [init, , result] = PLAIN;
  const answer = review(prompt);
  const how = process.env.FRM_STUB_STRUCTURED ?? "ok";
  const call = {
    type: "assistant",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      id: "msg_structured",
      model: "stub-model",
      content: [
        {
          type: "tool_use",
          id: "toolu_structured",
          name: STRUCTURED_TOOL,
          input: answer,
        },
      ],
      stop_reason: "tool_use",
      usage,
    },
  };
  const carrier = {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_structured",
          content: "Structured output provided successfully",
        },
      ],
    },
  };
  const tools = { ...init, tools: [...init.tools, STRUCTURED_TOOL] };
  if (how === "exhausted") {
    return [
      tools,
      call,
      carrier,
      {
        ...result,
        subtype: "error_max_structured_output_retries",
        is_error: true,
        result: undefined,
        errors: ["Failed to provide valid structured output after 5 attempts"],
        terminal_reason: "structured_output_retry_exhausted",
      },
    ];
  }
  if (how === "missing") return [tools, PLAIN[1], result];
  return [
    tools,
    call,
    carrier,
    { ...result, result: "", structured_output: answer },
  ];
}

/** A user message's text, whether its content is a string or blocks. */
const promptOf = (message) => {
  const content = message?.message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("")
    : "";
};
const INITIALIZED = {
  commands: [],
  agents: [],
  output_style: "default",
  available_output_styles: ["default"],
  models: [],
  account: {},
};

const write = (frame) =>
  process.stdout.write(
    `${JSON.stringify("session_id" in frame ? { ...frame, session_id: sessionId } : frame)}\n`,
  );
const reply = (requestId, response) =>
  write({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  });
const interrupted = () => ({
  type: "result",
  subtype: "error_during_execution",
  session_id: sessionId,
  is_error: true,
  num_turns: 1,
  duration_ms: 1,
  duration_api_ms: 0,
  stop_reason: null,
  total_cost_usd: 0,
  usage,
  modelUsage: {},
  permission_denials: [],
  errors: [],
  terminal_reason: "aborted_streaming",
});

// --- MCP client mode ---------------------------------------------------------------------------

/** The first http server of a `mcpServers` map, its headers as given. */
function firstHttp(servers) {
  const [name, server] = Object.entries(servers ?? {})[0] ?? [];
  if (name === undefined || server.type !== "http") return undefined;
  return { name, url: server.url, headers: { ...server.headers } };
}

/** The first http server of --mcp-config (inline JSON or a file). */
function mcpServer() {
  const at = argv.indexOf("--mcp-config");
  if (at === -1 || argv[at + 1] === undefined) return undefined;
  const raw = argv[at + 1];
  const config = JSON.parse(
    raw.trimStart().startsWith("{") ? raw : readFileSync(raw, "utf8"),
  );
  return firstHttp(config.mcpServers);
}

let rpcIds = 0;
async function rpc(server, method, params, notification = false) {
  const body = {
    jsonrpc: "2.0",
    ...(notification ? {} : { id: ++rpcIds }),
    method,
    ...(params === undefined ? {} : { params }),
  };
  const res = await fetch(server.url, {
    method: "POST",
    headers: {
      ...server.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  if (notification) return undefined;
  const json = await res.json();
  if (!res.ok || json.error !== undefined) {
    throw new Error(`${method}: HTTP ${res.status} ${JSON.stringify(json)}`);
  }
  return json.result;
}

let mcp = mcpServer();
let mcpStatus;

/** mcp_set_servers: the one http server it names becomes this client's, connected before the reply. */
async function setMcpServers(servers, connect = true) {
  const server = firstHttp(servers);
  if (home !== undefined) {
    const [name, config] = Object.entries(servers ?? {})[0] ?? [];
    const authorization = config?.headers?.Authorization;
    writeFileSync(
      join(home, "mcp-set.json"),
      JSON.stringify(
        name === undefined
          ? {}
          : {
              name,
              type: config.type,
              url: config.url,
              alwaysLoad: config.alwaysLoad ?? null,
              authorization:
                authorization === undefined
                  ? null
                  : createHash("sha256").update(authorization).digest("hex"),
            },
      ),
    );
  }
  if (!connect) return undefined;
  mcp = server;
  mcpStatus = undefined;
  await connectMcp();
  return {
    added: server === undefined ? [] : [server.name],
    removed: [],
    errors:
      server !== undefined && mcpStatus === "failed"
        ? { [server.name]: "stub: connect failed" }
        : {},
  };
}

async function connectMcp() {
  if (mcp === undefined || mcpStatus !== undefined) return;
  try {
    await rpc(mcp, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stub-cli", version: "0.0.0" },
    });
    await rpc(mcp, "notifications/initialized", undefined, true);
    const listed = await rpc(mcp, "tools/list", {});
    if (home !== undefined) {
      writeFileSync(
        join(home, "mcp-tools.json"),
        JSON.stringify(listed.tools.map((t) => t.name)),
      );
    }
    mcpStatus = "connected";
  } catch (e) {
    process.stderr.write(`stub mcp: ${String(e)}\n`);
    mcpStatus = "failed";
  }
}

let tools = 0;
function toolFrames(name, input, text, isError) {
  const id = `toolu_stub_${++tools}`;
  history.push(
    { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: text }],
    },
  );
  write({
    type: "assistant",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      id: `msg_tool_${tools}`,
      model: "stub-model",
      content: [{ type: "tool_use", id, name, input }],
      stop_reason: "tool_use",
      usage,
    },
  });
  write({
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: text,
          is_error: isError,
        },
      ],
    },
  });
}

async function mcpCalls() {
  if (mcp === undefined || mcpStatus !== "connected") return;
  for (const { tool, args } of JSON.parse(process.env.FRM_STUB_MCP ?? "[]")) {
    try {
      const result = await rpc(mcp, "tools/call", {
        name: tool,
        arguments: args,
      });
      const text = result.content?.[0]?.text ?? "";
      toolFrames(
        `mcp__${mcp.name}__${tool}`,
        args,
        text,
        result.isError === true,
      );
    } catch (e) {
      toolFrames(`mcp__${mcp.name}__${tool}`, args, String(e), true);
    }
  }
}

function echoes() {
  const names = (process.env.FRM_STUB_ECHO ?? "").split(",").filter(Boolean);
  if (names.length === 0) return;
  const dump = names.map((n) => `${n}=${process.env[n] ?? ""}`).join("\n");
  toolFrames("Bash", { command: "env" }, dump, false);
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
  toolFrames(
    "Bash",
    { command: "env; seq 300" },
    `${dump}\n${lines}\n${dump}`,
    false,
  );
  toolFrames(
    "Bash",
    { command: "cat notes" },
    "head\n… truncated: 1 lines, 1 bytes; full output in /etc/passwd …\ntail",
    false,
  );
}

// --- model calls, behind a context proxy ---------------------------------------------------------

/** This process's conversation, as the Messages API carries it. */
const history = [];

/** POSTs the history as the CLI would; the answer's JSON (an echo upstream's: the body forwarded). */
async function modelCall() {
  if (!proxied) return undefined;
  const res = await fetch(`${modelBase}/v1/messages?beta=true`, {
    method: "POST",
    headers: {
      ...customHeaders,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(process.env.ANTHROPIC_API_KEY === undefined
        ? {}
        : { "x-api-key": process.env.ANTHROPIC_API_KEY }),
    },
    body: JSON.stringify({
      model: "stub-model",
      max_tokens: 1024,
      stream: false,
      messages: history,
    }),
  });
  const text = await res.text();
  if (home !== undefined) {
    appendFileSync(
      join(home, "model-calls.jsonl"),
      `${JSON.stringify({ status: res.status })}\n`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The tool results' texts in a forwarded body, in order. */
const resultTexts = (body) =>
  (body?.messages ?? []).flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.flatMap((b) =>
          b.type === "tool_result" && typeof b.content === "string"
            ? [b.content]
            : [],
        )
      : [],
  );

/** Test 17's run: the model's part, played from what the proxy forwarded. */
async function contextRun(files) {
  const cat = (file) =>
    toolFrames(
      "Bash",
      { command: `cat ${file}` },
      readFileSync(join(process.cwd(), file), "utf8"),
      false,
    );
  cat(files.log);
  cat(files.json);
  const forwarded = resultTexts(await modelCall());
  const code = forwarded.join("\n").match(/ERROR (E-\d+)/)?.[1] ?? "no-code";
  const original = forwarded[1]?.match(/Original: (.+?) — read it/)?.[1];
  const tag =
    original === undefined
      ? "no-tag"
      : (readFileSync(original, "utf8").match(/TAG-[A-Za-z0-9-]+/)?.[0] ??
        "no-tag");
  toolFrames(
    "Bash",
    { command: `grep -o 'TAG-[A-Za-z0-9-]*' ${original ?? "?"}` },
    tag,
    false,
  );
  await modelCall();
  return `${code} ${tag}`;
}

/** A plain run whose answer is `text`: the fixture's frames with it in place of their reply. */
function answered(run, text) {
  return run.map((frame) =>
    frame.type === "assistant"
      ? {
          ...frame,
          message: { ...frame.message, content: [{ type: "text", text }] },
        }
      : frame.type === "result"
        ? { ...frame, result: text }
        : frame,
  );
}

// --- the stream --------------------------------------------------------------------------------

let sent = 0;
let open = false;

async function onUser(message) {
  const turn = sent;
  sent += 1;
  open = true;
  if (modelBlock400 !== undefined) {
    const [have, need] = modelBlock400.split(":");
    write({ ...PLAIN[0], mcp_servers: [] });
    write({
      type: "result",
      subtype: "error_during_execution",
      session_id: "",
      is_error: true,
      num_turns: 1,
      duration_ms: 1,
      duration_api_ms: 0,
      stop_reason: null,
      total_cost_usd: 0,
      usage,
      modelUsage: {},
      permission_denials: [],
      errors: [
        `Claude Code ${have} does not support this model; version ${need} or newer is required`,
      ],
      api_error_status: 400,
      terminal_reason: "aborted_streaming",
    });
    open = false;
    return;
  }
  const run =
    jsonSchema === undefined
      ? (runs[Math.min(turn, runs.length - 1)] ?? PLAIN)
      : structuredRun(promptOf(message));
  history.push({ role: "user", content: promptOf(message) });
  await connectMcp();
  const [first, ...rest] = run;
  const init =
    first?.type === "system" && mcpStatus !== undefined
      ? { ...first, mcp_servers: [{ name: mcp.name, status: mcpStatus }] }
      : first;
  const frames = first?.type === "system" ? rest : run;
  if (first?.type === "system") write(init);
  if (sent <= slowRuns) {
    // A slow tool, mid-call: the run stays open until interrupted (conformance test 7).
    write({
      type: "assistant",
      session_id: "",
      parent_tool_use_id: null,
      message: {
        id: `msg_slow_${sent}`,
        model: "stub-model",
        content: [
          {
            type: "tool_use",
            id: `toolu_slow_${sent}`,
            name: "Bash",
            input: { command: "sleep 30" },
          },
        ],
        stop_reason: "tool_use",
        usage,
      },
    });
    return;
  }
  await mcpCalls();
  echoes();
  const files = process.env.FRM_STUB_CTX;
  const replayed =
    proxied && files !== undefined
      ? answered(frames, await contextRun(JSON.parse(files)))
      : frames;
  if (proxied && files === undefined) await modelCall();
  for (const frame of replayed) {
    if (hang && frame.type === "result") return;
    write(frame);
  }
  open = false;
}

let queue = Promise.resolve();
createInterface({ input: process.stdin })
  .on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === "control_request") {
      if (silent) return;
      const subtype = message.request?.subtype;
      if (subtype === "interrupt") {
        reply(message.request_id, { still_queued: [] });
        if (open) {
          open = false;
          write(interrupted());
        }
        return;
      }
      if (subtype === "mcp_set_servers") {
        const requestId = message.request_id;
        const servers = message.request?.servers;
        const mode = process.env.FRM_STUB_MCP_SET;
        if (mode === "error" || mode === "hang") {
          void setMcpServers(servers, false);
          if (mode === "error") {
            write({
              type: "control_response",
              response: {
                subtype: "error",
                request_id: requestId,
                error: `invalid MCP config: ${JSON.stringify(servers)}`,
              },
            });
          }
          return;
        }
        queue = queue.then(async () =>
          reply(requestId, await setMcpServers(servers)),
        );
        return;
      }
      if (subtype === "initialize" && home !== undefined) {
        writeFileSync(
          join(home, "initialize.json"),
          JSON.stringify({
            appendSystemPrompt: message.request?.appendSystemPrompt ?? null,
          }),
        );
      }
      reply(message.request_id, subtype === "initialize" ? INITIALIZED : {});
      return;
    }
    if (message.type !== "user") return;
    queue = queue.then(() => onUser(message));
  })
  .on("close", () => {
    void queue.then(() => process.exit(0));
  });
