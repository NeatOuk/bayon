// The turn host: one long-lived process per session that runs one Codex
// process per turn. Its ref, stdout and exit are the session handle's, so the supervisor's
// executor_ref stays true across turns (Invariant 12). It is the only writer of the session home's
// files, takes its ops as JSON lines on stdin, relays Codex's stdout byte for byte, and adds four
// frames of its own. Its source is inlined and run with `node -e`, so no file has to be shipped to
// a container; it carries no secret on argv (test 11).
import type { Argv } from "@bayon/executors";
import { AUTH_FILE, CODEX_DIR, THREAD_FILE, type HomeFile } from "./home.js";
import { HOST_EXIT, HOST_INTERRUPT, HOST_START, HOST_TURN } from "./frames.js";

/** The host's argv config. Never a secret: executors record argv. */
export type HostConfig = {
  readonly v: 1;
  readonly rsid: string;
  readonly home: string;
  readonly graceMs: number;
};

export type HostOp =
  | { readonly op: "files"; readonly files: readonly HomeFile[] }
  | {
      readonly op: "turn";
      readonly run_id: string;
      readonly model: string;
      readonly resume: boolean;
      readonly argv: readonly string[];
      /** The compiled prompt, written to Codex's stdin (`-`). */
      readonly stdin: string;
      readonly files: readonly HomeFile[];
    }
  | { readonly op: "interrupt"; readonly run_id: string };

/** The status a host exits with when its own protocol fails, before any Codex status exists. */
export const HOST_FAILURE = 70;

export const encodeOp = (op: HostOp): string => `${JSON.stringify(op)}\n`;

const js = (value: unknown): string => JSON.stringify(value);

/** The host program. Plain ES2022 for Node 22: it runs wherever the executor finds `node`. */
export const HOST_SOURCE = `
import { spawn } from "node:child_process";
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { constants } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { createInterface } from "node:readline";

const cfg = JSON.parse(process.argv[1]);
const HOME = normalize(cfg.home);
const CODEX = join(HOME, ${js(CODEX_DIR)});
const THREAD = join(HOME, ${js(THREAD_FILE)});
const AUTH = join(HOME, ${js(AUTH_FILE)});
const FAILURE = ${js(HOST_FAILURE)};

let atLineStart = true;
let broken = false;
let started = false;
let closing = false;
let child = null;
let pending = [];
let lastStatus = 0;
let thread = { rsid: cfg.rsid, thread_id: null, usage_total: null };

function out(bytes) {
  if (broken || bytes.length === 0) return true;
  atLineStart = bytes[bytes.length - 1] === 10;
  return process.stdout.write(bytes);
}
function frame(value) {
  if (!atLineStart) out(Buffer.from("\\n"));
  out(Buffer.from(JSON.stringify(value) + "\\n"));
}
function durable(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + ".frm-tmp";
  const fd = openSync(tmp, "w", mode);
  try {
    fchmodSync(fd, mode);
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
function inside(rel) {
  if (typeof rel !== "string" || rel === "" || isAbsolute(rel)) throw new Error("not a home-relative path: " + rel);
  const full = normalize(join(HOME, rel));
  if (!full.startsWith(HOME + sep)) throw new Error("path leaves the home: " + rel);
  if (full === THREAD) throw new Error("thread.json is the host's own");
  return full;
}
function applyFiles(files) {
  for (const f of files ?? []) durable(inside(f.path), String(f.content), Number(f.mode));
}
function reap() {
  let names = [];
  try {
    names = readdirSync(CODEX);
  } catch {
    return;
  }
  for (const name of names) {
    if (/^logs_\\d+\\.sqlite(-wal|-shm)?$/.test(name)) rmSync(join(CODEX, name), { force: true });
  }
  rmSync(join(CODEX, "log"), { recursive: true, force: true });
}
function unlinkAuth() {
  try {
    rmSync(AUTH, { force: true });
  } catch {}
}
function readThread() {
  try {
    const t = JSON.parse(readFileSync(THREAD, "utf8"));
    if (t !== null && typeof t === "object" && typeof t.rsid === "string" && t.rsid !== "") {
      thread = {
        rsid: t.rsid,
        thread_id: typeof t.thread_id === "string" && t.thread_id !== "" ? t.thread_id : null,
        usage_total: t.usage_total !== null && typeof t.usage_total === "object" ? t.usage_total : null,
      };
    }
  } catch {}
}
function inspect(line) {
  const text = line.toString("utf8");
  if (!text.includes('"thread.started"') && !text.includes('"turn.completed"') && !text.includes('"turn.failed"')) return;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  // The turn has ended: this Codex is now exiting on its own (see shutdown).
  if ((value?.type === "turn.completed" || value?.type === "turn.failed") && child !== null) child.ended = true;
  if (value?.type === "thread.started" && typeof value.thread_id === "string" && thread.thread_id === null) {
    thread = { ...thread, thread_id: value.thread_id };
    durable(THREAD, JSON.stringify(thread), 0o600);
  } else if (value?.type === "turn.completed" && value.usage !== null && typeof value.usage === "object") {
    // Durable before the line is relayed: a crash in between can only under-bill.
    thread = { ...thread, usage_total: value.usage };
    durable(THREAD, JSON.stringify(thread), 0o600);
  }
}
function relay(proc) {
  let carry = Buffer.alloc(0);
  proc.stdout.on("data", (chunk) => {
    const data = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    let start = 0;
    for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, start)) {
      const line = data.subarray(start, nl + 1);
      inspect(line);
      if (!out(line)) {
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
function terminate(current) {
  current.proc.kill("SIGTERM");
  setTimeout(() => {
    if (!current.done) current.proc.kill("SIGKILL");
  }, cfg.graceMs).unref();
}
function finish(current, code, signal) {
  if (current.done) return;
  current.done = true;
  lastStatus = statusOf(code, signal);
  frame({ type: ${js(HOST_EXIT)}, run_id: current.runId, code: typeof code === "number" ? code : null, signal: signal ?? null });
  child = null;
  if (closing) return exitNow();
  const next = pending.shift();
  if (next !== undefined) startTurn(next);
}
function startTurn(op) {
  reap();
  applyFiles(op.files);
  frame({ type: ${js(HOST_TURN)}, run_id: op.run_id, model: op.model, resume: op.resume === true, argv: op.argv });
  // Codex's stderr is piped and relayed, never inherited: if the host dies alone, the executor's
  // stderr closes with it, so the handle's exit settles even while Codex lives on.
  const proc = spawn(op.argv[0], op.argv.slice(1), { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const current = { proc, runId: op.run_id, done: false, ended: false };
  child = current;
  proc.stdin.on("error", () => {});
  proc.stdin.end(String(op.stdin ?? ""));
  proc.stderr.on("data", (chunk) => process.stderr.write(chunk));
  relay(proc);
  proc.once("error", (e) => {
    process.stderr.write("frm host: " + e.message + "\\n");
    if (proc.pid === undefined) finish(current, 127, null);
  });
  // After the exit, its stdout closes, unless a descendant still holds it: then stop waiting.
  proc.once("exit", () => setTimeout(() => proc.stdout.destroy(), cfg.graceMs).unref());
  // After both the exit and the close of stdout: a late byte of turn n never lands in run n+1.
  proc.once("close", (code, signal) => finish(current, code, signal));
}
function exitNow() {
  unlinkAuth();
  process.exitCode = lastStatus;
  rl.close();
  process.stdin.destroy();
  setTimeout(() => process.exit(lastStatus), cfg.graceMs).unref();
}
function shutdown(status) {
  if (status !== undefined) lastStatus = status;
  if (closing) return;
  closing = true;
  pending = [];
  if (child === null || child.done) return exitNow();
  // A Codex that relayed its turn's end is exiting on its own, flushing its thread: it gets the
  // grace to go, so the host exits with its real status, not the 143 of a SIGTERM that raced its
  // exit (a clean review's stop lands right after its terminal). One still mid-turn is
  // ended at once; either way finish() exits the host when Codex closes.
  if (child.ended) {
    const lingering = child;
    setTimeout(() => {
      if (!lingering.done) terminate(lingering);
    }, cfg.graceMs).unref();
    return;
  }
  terminate(child);
}
function fail(message) {
  process.stderr.write("frm host: " + message + "\\n");
  shutdown(FAILURE);
}
function onOp(line) {
  if (closing || line.trim() === "") return;
  let op;
  try {
    op = JSON.parse(line);
  } catch {
    return fail("an op that is not JSON");
  }
  try {
    if (!started) {
      if (op?.op !== "files") return fail("the first op must be files");
      applyFiles(op.files);
      readThread();
      started = true;
      frame({ type: ${js(HOST_START)}, v: 1, runner_session_id: thread.rsid, thread_id: thread.thread_id, usage_total: thread.usage_total });
      return;
    }
    if (op?.op === "files") return applyFiles(op.files);
    if (op?.op === "turn") {
      if (child === null) return startTurn(op);
      // One Codex process at a time (Invariant 12). The previous one is usually just exiting after
      // its terminal, flushing its thread: it gets the grace to go on its own, then it is ended.
      pending.push(op);
      const lingering = child;
      setTimeout(() => {
        if (!lingering.done) terminate(lingering);
      }, cfg.graceMs).unref();
      return;
    }
    if (op?.op === "interrupt") {
      if (child === null || child.done || (op.run_id !== undefined && op.run_id !== child.runId)) return;
      frame({ type: ${js(HOST_INTERRUPT)}, run_id: child.runId });
      child.proc.kill("SIGINT");
      return;
    }
    fail("an unknown op");
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

process.stdout.on("error", () => {
  broken = true;
  shutdown();
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => shutdown());
process.on("uncaughtException", (e) => fail(e instanceof Error ? e.message : String(e)));
unlinkAuth();
reap();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", onOp);
rl.on("close", () => shutdown());
`;

/** `node -e` the host, its config as the one argument. */
export const hostArgv = (node: string, cfg: HostConfig): Argv => [
  node,
  "--input-type=module",
  "-e",
  HOST_SOURCE,
  JSON.stringify(cfg),
];
