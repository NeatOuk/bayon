// The turn host: one long-lived process per session that owns one
// `opencode acp` process and speaks ACP (JSON-RPC 2.0, one message a line) to it. Its ref, stdout
// and exit are the session handle's, so executor_ref holds across turns (Invariant 12). It relays
// opencode's stdout byte for byte and adds five frames of its own; it is the only writer of the
// session home and of SendSpec.output.path. Its source is inlined and run with `node -e`, so no
// file has to be shipped; it carries no secret on argv (test 11).
import type { Argv } from "@bayon/executors";
import {
  HOST_EXIT,
  HOST_INTERRUPT,
  HOST_OUTPUT,
  HOST_START,
  HOST_TURN,
} from "./frames.js";
import { HOME_DIRS, READ_ONLY_DIR } from "./home.js";
import { LOOPBACK_MARK } from "./sandbox.js";
import { SCHEMA_CHECK_SOURCE } from "./schema-check.js";
import { MCP_SERVER, MCP_TOKEN_ENV } from "./tool-names.js";
import {
  PS_ARGS,
  TOOL_GROUPS_FILE,
  TOOL_GROUPS_SOURCE,
} from "./tool-groups.js";

/** The host's argv config. Never a secret: executors record argv. */
export type HostConfig = {
  readonly v: 1;
  readonly home: string;
  /** opencode's argv prefix; the host appends `acp --hostname 127.0.0.1 --port 0`. */
  readonly bin: readonly string[];
  readonly model: string;
  /** A `ses_…` id to `session/resume`, or null for `session/new`. */
  readonly resume: string | null;
  readonly graceMs: number;
  /** The session's MCP server; the host proxies it on loopback and adds the bearer. */
  readonly mcpUrl: string | null;
  /** The names of the host's env opencode may have: nothing secret (design §4). */
  readonly allow: readonly string[];
};

export type HostOp =
  | {
      readonly op: "turn";
      readonly run_id: string;
      /** The compiled prompt, sent as the prompt's first text block. */
      readonly text: string;
      /** The runner protocol's structured-output instruction (design §6), a second text block. */
      readonly instruction?: string;
      readonly output?: {
        readonly schema: Readonly<Record<string, unknown>>;
        readonly path: string;
      };
    }
  | { readonly op: "interrupt"; readonly run_id: string };

/** The status a host exits with when its own protocol or the ACP handshake fails. */
export const HOST_FAILURE = 70;

export const encodeOp = (op: HostOp): string => `${JSON.stringify(op)}\n`;

const js = (value: unknown): string => JSON.stringify(value);

/** The host program. Plain ES2022 for Node 22: it runs wherever the executor finds `node`. */
export const HOST_SOURCE = `
import { execFile, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { chmodSync, closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { constants } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
${SCHEMA_CHECK_SOURCE}
${TOOL_GROUPS_SOURCE}
const cfg = JSON.parse(process.argv[1]);
// The bearer stays in this process: nothing it starts inherits it.
const TOKEN = process.env[${js(MCP_TOKEN_ENV)}] ?? "";
delete process.env[${js(MCP_TOKEN_ENV)}];
const HOST_DIR = cfg.home.replace(/[/]+$/, "") + ".frm-host";
const GROUPS = join(HOST_DIR, ${js(TOOL_GROUPS_FILE)});
const PS = ${js(PS_ARGS)};
const FAILURE = ${js(HOST_FAILURE)};
const DIRS = ${js(Object.values(HOME_DIRS))};
const READ_ONLY = ${js(READ_ONLY_DIR)};

let atLineStart = true;
let broken = false;
let closing = false;
let forced = null;
let child = null;
let childDone = false;
let sessionId = null;
let started = false;
let nextId = 1;
let turn = null;
const queued = [];
const handlers = new Map();

function out(bytes) {
  if (broken || bytes.length === 0) return true;
  atLineStart = bytes[bytes.length - 1] === 10;
  return process.stdout.write(bytes);
}
function frame(value) {
  if (!atLineStart) out(Buffer.from("\\n"));
  out(Buffer.from(JSON.stringify(value) + "\\n"));
}
function say(message) {
  process.stderr.write("frm host: " + message + "\\n");
}
function prepare() {
  for (const dir of DIRS) mkdirSync(join(cfg.home, dir), { recursive: true, mode: 0o700 });
  const config = join(cfg.home, READ_ONLY);
  mkdirSync(config, { recursive: true });
  chmodSync(config, 0o555);
  // The host's own dir: the sandbox denies it to the model; nothing in it is the model's to write.
  mkdirSync(HOST_DIR, { recursive: true, mode: 0o700 });
  chmodSync(HOST_DIR, 0o700);
}
function durable(path, content) {
  const tmp = path + ".frm-tmp";
  const fd = openSync(tmp, "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
function send(message) {
  if (child === null || childDone || !child.stdin.writable) return false;
  child.stdin.write(JSON.stringify(message) + "\\n");
  return true;
}
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    handlers.set(id, resolve);
    if (!send({ jsonrpc: "2.0", id, method, params })) {
      handlers.delete(id);
      resolve({ error: { message: "opencode is not running" } });
    }
  });
}
function collect(update) {
  if (update.content === null || typeof update.content !== "object" || update.content.type !== "text") return;
  const key = typeof update.messageId === "string" ? update.messageId : "";
  turn.texts.set(key, (turn.texts.get(key) ?? "") + String(update.content.text));
  turn.last = key;
}
function checkOutput(t, message) {
  if (t.output === null) return;
  let ok = false;
  let path = null;
  let issues = [];
  const end = message.result !== null && typeof message.result === "object" ? message.result.stopReason : undefined;
  if (end !== "end_turn") {
    issues = ["the turn ended " + (end ?? "with an error") + ", not end_turn"];
  } else {
    const parsed = parseAnswer(t.last === undefined ? "" : (t.texts.get(t.last) ?? ""));
    issues = parsed.ok ? checkValue(t.output.schema, parsed.value) : ["the final answer is not JSON"];
    if (issues.length === 0) {
      try {
        durable(t.output.path, JSON.stringify(parsed.value));
        ok = true;
        path = t.output.path;
      } catch (e) {
        issues = ["cannot write the output file: " + (e instanceof Error ? e.message : String(e))];
      }
    }
  }
  frame({ type: ${js(HOST_OUTPUT)}, run_id: t.runId, ok, path, issues: issues.slice(0, 20) });
}
function answer(message) {
  if (message.method === "session/request_permission") {
    // Every rule is allow or deny; an ask that got here has no-one to answer it.
    send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not offered by this client" } });
}
function onLine(line) {
  const text = line.toString("utf8");
  let message;
  if (text.startsWith("{")) {
    try {
      message = JSON.parse(text);
    } catch {}
  }
  if (message === null || typeof message !== "object") return out(line);
  if (message.method === undefined && message.id !== undefined && handlers.has(message.id)) {
    const handle = handlers.get(message.id);
    handlers.delete(message.id);
    handle(message);
    return out(line);
  }
  if (message.method === "session/update" && turn !== null && message.params?.update?.sessionUpdate === "agent_message_chunk") {
    collect(message.params.update);
  }
  // A tool just started: record its process group now, not at the next poll.
  if (message.method === "session/update" && message.params?.update?.status === "in_progress") {
    void recordGroups();
    setTimeout(() => void recordGroups(), 150).unref();
  }
  const relayed = out(line);
  if (message.method !== undefined && message.id !== undefined) answer(message);
  return relayed;
}
function relay(proc) {
  let carry = Buffer.alloc(0);
  proc.stdout.on("data", (chunk) => {
    const data = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    let start = 0;
    for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, start)) {
      if (!onLine(data.subarray(start, nl + 1))) {
        proc.stdout.pause();
        process.stdout.once("drain", () => proc.stdout.resume());
      }
      start = nl + 1;
    }
    carry = Buffer.from(data.subarray(start));
  });
  proc.stdout.on("end", () => {
    out(carry);
    carry = Buffer.alloc(0);
  });
}
function statusOf(code, signal) {
  if (typeof code === "number") return code;
  return 128 + (constants.signals[signal] ?? 0);
}
function exitNow(status) {
  process.exitCode = status;
  rl.close();
  process.stdin.destroy();
  setTimeout(() => process.exit(status), 20);
}
function startTurn(op) {
  if (turn !== null) return fail("a turn is already open");
  const rpcId = nextId++;
  const output = op.output !== null && typeof op.output === "object" ? op.output : null;
  turn = { runId: String(op.run_id), rpcId, output, texts: new Map(), last: undefined };
  frame({ type: ${js(HOST_TURN)}, run_id: turn.runId, rpc_id: rpcId, model: cfg.model, output: output !== null });
  handlers.set(rpcId, (message) => {
    const t = turn;
    turn = null;
    // An opencode that died answered nothing: no check, and the run gets no terminal.
    if (t !== null && !childDone) checkOutput(t, message);
  });
  const prompt = [{ type: "text", text: String(op.text ?? "") }];
  if (typeof op.instruction === "string" && op.instruction !== "") prompt.push({ type: "text", text: op.instruction });
  send({ jsonrpc: "2.0", id: rpcId, method: "session/prompt", params: { sessionId, prompt } });
}
function onOp(line) {
  if (closing || line.trim() === "") return;
  let op;
  try {
    op = JSON.parse(line);
  } catch {
    return fail("an op that is not JSON");
  }
  if (!started) return void queued.push(op);
  if (op?.op === "turn") return startTurn(op);
  if (op?.op === "interrupt") {
    if (turn === null || op.run_id !== turn.runId) return;
    frame({ type: ${js(HOST_INTERRUPT)}, run_id: turn.runId });
    send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    return;
  }
  fail("an unknown op");
}
/** Every request must carry this session's proxy bearer, which opencode holds only in memory. */
const PROXY_BEARER = randomBytes(32).toString("hex");
function bearerOk(value) {
  const want = Buffer.from("Bearer " + PROXY_BEARER);
  const got = Buffer.from(typeof value === "string" ? value : "");
  return got.length === want.length && timingSafeEqual(got, want);
}
/**
 * The MCP server on loopback. The real bearer is added here, so opencode, its env and its
 * config never hold it; a caller without this session's proxy bearer is refused (401) and
 * nothing is forwarded.
 */
function startProxy() {
  if (cfg.mcpUrl === null) return Promise.resolve(null);
  const target = new URL(cfg.mcpUrl);
  const client = target.protocol === "https:" ? https : http;
  const path = "/" + randomBytes(16).toString("hex");
  const hop = new Set(["host", "authorization", "connection", "keep-alive", "proxy-authorization", "proxy-connection", "upgrade"]);
  const server = http.createServer((req, res) => {
    if (req.url !== path || !bearerOk(req.headers.authorization)) {
      req.resume();
      res.writeHead(req.url !== path ? 404 : 401);
      return res.end();
    }
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) if (!hop.has(key)) headers[key] = value;
    headers.authorization = "Bearer " + TOKEN;
    const up = client.request(target, { method: req.method, headers }, (answer) => {
      const back = {};
      for (const [key, value] of Object.entries(answer.headers)) if (!hop.has(key)) back[key] = value;
      res.writeHead(answer.statusCode ?? 502, back);
      answer.pipe(res);
    });
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on("close", () => up.destroy());
    req.pipe(up);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve({ url: "http://127.0.0.1:" + server.address().port + path, port: server.address().port });
    });
  });
}
/** A free loopback port for opencode's own server, so the sandbox can name it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}
function ps() {
  return new Promise((resolve) => execFile("ps", PS, { maxBuffer: 16 << 20 }, (e, out) => resolve(e ? null : parsePs(out))));
}
function cwdOf(pid) {
  return new Promise((resolve) => {
    try {
      return resolve(readlinkSync("/proc/" + pid + "/cwd"));
    } catch {}
    execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], (e, out) => resolve(e ? undefined : lsofCwd(out)));
  });
}
let recorded = "[]";
/** While a turn runs: the tool groups under opencode, kept in the host's own dir. */
async function recordGroups() {
  if (child === null || childDone || child.pid === undefined) return;
  const rows = await ps();
  if (rows === null) return;
  const text = JSON.stringify(toolGroups(rows, child.pid, process.pid));
  if (text === recorded) return;
  recorded = text;
  try {
    durable(GROUPS, text);
  } catch {}
}
/**
 * Kills the recorded groups still alive (a host before us died, or opencode left some): only a
 * leader that is still the recorded process and whose cwd is inside this session's worktree or
 * home, whatever the record says.
 */
async function reapGroups() {
  let saved;
  try {
    saved = JSON.parse(readFileSync(GROUPS, "utf8"));
  } catch {
    return;
  }
  const rows = await ps();
  const roots = [realpathSync(process.cwd()), realpathSync(cfg.home)];
  for (const g of rows === null ? [] : stillAlive(rows, saved)) {
    if (!inside(await cwdOf(g.pgid), roots)) continue;
    try {
      process.kill(-g.pgid, "SIGKILL");
    } catch {}
  }
  rmSync(GROUPS, { force: true });
  recorded = "[]";
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function stopChild() {
  // A cancel first, so opencode ends the tool's own process group; then its input, on which it
  // exits by itself; then signals.
  if (turn !== null && sessionId !== null) {
    send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    for (let waited = 0; turn !== null && !childDone && waited < cfg.graceMs; waited += 25) await pause(25);
  }
  try {
    child.stdin.end();
  } catch {}
  for (const signal of [null, "SIGTERM", "SIGKILL"]) {
    if (signal !== null && !childDone) child.kill(signal);
    for (let waited = 0; !childDone && waited < cfg.graceMs; waited += 25) await pause(25);
    if (childDone) return;
  }
}
function shutdown(status) {
  if (status !== undefined && forced === null) forced = status;
  if (closing) return;
  closing = true;
  if (child === null || childDone) return exitNow(forced ?? 0);
  void stopChild();
}
function fail(message) {
  say(message);
  shutdown(FAILURE);
}
async function handshake() {
  const init = await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "frm-host", version: "1" },
  });
  if (init.error !== undefined) throw new Error("initialize: " + init.error.message);
  // The MCP server reaches opencode here, on its stdin: the proxy's URL and this session's proxy
  // bearer live in opencode's memory only, never in its env, argv or a file.
  const mcpServers = proxy === null ? [] : [{ type: "http", name: ${js(MCP_SERVER)}, url: proxy.url, headers: [{ name: "Authorization", value: "Bearer " + PROXY_BEARER }] }];
  const params = { cwd: process.cwd(), mcpServers };
  const opened = cfg.resume === null
    ? await call("session/new", params)
    : await call("session/resume", { ...params, sessionId: cfg.resume });
  if (opened.error !== undefined) throw new Error((cfg.resume === null ? "session/new: " : "session/resume: ") + opened.error.message);
  sessionId = cfg.resume ?? opened.result?.sessionId;
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session/new returned no session id");
  // A resumed session keeps its stored model: the session's is set every time.
  const model = await call("session/set_config_option", { sessionId, configId: "model", value: cfg.model });
  if (model.error !== undefined) throw new Error("model " + cfg.model + ": " + model.error.message);
  started = true;
  frame({ type: ${js(HOST_START)}, v: 1, runner_session_id: sessionId, resumed: cfg.resume !== null, model: cfg.model });
  for (const op of queued.splice(0)) onOp(JSON.stringify(op));
}

process.stdout.on("error", () => {
  broken = true;
  shutdown();
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => shutdown());
process.on("uncaughtException", (e) => fail(e instanceof Error ? e.message : String(e)));
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", onOp);
rl.on("close", () => shutdown());
try {
  prepare();
} catch (e) {
  fail("cannot prepare the home: " + (e instanceof Error ? e.message : String(e)));
}
let proxy = null;
async function launch() {
  await reapGroups();
  proxy = await startProxy();
  const serverPort = await freePort();
  const env = {};
  for (const name of cfg.allow) if (process.env[name] !== undefined) env[name] = process.env[name];
  env.OPENCODE_SERVER_PASSWORD = randomBytes(24).toString("hex");
  if (closing) return exitNow(forced ?? 0);
  // The sandbox's loopback rule names exactly this session's two ports: its MCP proxy and
  // opencode's own server. Another session's opencode cannot reach either (security review).
  const loopback = [serverPort, ...(proxy === null ? [] : [proxy.port])]
    .map((port) => "(allow network-outbound (remote ip " + JSON.stringify("localhost:" + port) + "))")
    .join(" ");
  const argv = cfg.bin.map((a) => a.split(${js(LOOPBACK_MARK)}).join(loopback));
  child = spawn(argv[0], [...argv.slice(1), "acp", "--hostname", "127.0.0.1", "--port", String(serverPort)], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  relay(child);
  child.once("error", (e) => {
    say("cannot start opencode: " + e.message);
    if (child.pid === undefined) {
      childDone = true;
      frame({ type: ${js(HOST_EXIT)}, code: 127, signal: null });
      closing = true;
      exitNow(forced ?? 127);
    }
  });
  // After the exit its stdout closes, unless something else holds it: then stop waiting.
  child.once("exit", () => setTimeout(() => child.stdout.destroy(), cfg.graceMs).unref());
  child.once("close", (code, signal) => {
    if (childDone) return;
    childDone = true;
    frame({ type: ${js(HOST_EXIT)}, code: typeof code === "number" ? code : null, signal: signal ?? null });
    for (const handle of handlers.values()) handle({ error: { message: "opencode exited" } });
    handlers.clear();
    closing = true;
    void reapGroups().finally(() => exitNow(forced ?? statusOf(code, signal)));
  });
  const watch = setInterval(() => {
    if (turn !== null) void recordGroups();
  }, 500);
  watch.unref();
  await handshake();
}
if (!closing) launch().catch((e) => fail(e instanceof Error ? e.message : String(e)));
`;

/** `node -e` the host, its config as the one argument. */
export const hostArgv = (node: string, cfg: HostConfig): Argv => [
  node,
  "--input-type=module",
  "-e",
  HOST_SOURCE,
  JSON.stringify(cfg),
];
