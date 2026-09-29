// @ts-check
// The exec-shim: runs one program for the container executor, on the docker
// host or inside a session container. Zero dependencies, node >= 20; uploaded content-addressed,
// verified on every prepare, mounted read-only into containers.
//
//   run <n> <runDir>        stdin: frames (hello first, then data | eof | kill | ping)
//                           stderr: frames (started | failed, ack, stderr, tick, exit)
//                           stdout: the program's own fd 1, untouched
//   host <n> <remoteRoot>   run on the docker host (run dir remoteRoot/run), confined first: the cwd
//                           must physically lie in remoteRoot/{mirror,bin,run}, and no path in argv
//                           or env may reach remoteRoot/work (or, for arguments, leave it)
//   ctl <runDir> <n> <op>   probe | INT | TERM | KILL | HUP for the program recorded as <n>
//   sweep <runDir> <n...>   in a container only: SIGKILL all but init, the keepalive, docker-exec'd
//                           shim calls and the groups of the listed programs
//
// The program's environment arrives only in the hello frame: never argv, never this process's
// env, never the record file.
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { Socket } from "node:net";
import { basename, isAbsolute, join, normalize } from "node:path";
import process from "node:process";
import { clearTimeout, setInterval, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

// frames.ts carries the same table.
const TYPE = Object.freeze({
  hello: 0x48,
  data: 0x44,
  eof: 0x5a,
  kill: 0x4b,
  ping: 0x50,
  started: 0x53,
  failed: 0x46,
  ack: 0x41,
  stderr: 0x45,
  tick: 0x54,
  exit: 0x58,
});
const MAX_FRAME = 2 * 1024 * 1024;
const TOKEN = /^[0-9a-f]{16}$/;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP"];
/** ctl: no such program, or it has exited. */
const DEAD = 3;
/** A container OOM takes the program, not the shim that reports it. */
const OOM_SCORE_ADJ = "900";
const HAS_PROC = existsSync("/proc/self/stat");

/**
 * @typedef {{ argv: string[], cwd: string, env: Record<string, string>,
 *   stdin: "pipe" | "ignore", killGraceMs: number, deadmanMs: number, heartbeatMs: number }} Hello
 * @typedef {{ shimPid: number, shimStart: string, pgid: number, leaderStart: string }} ProcRecord
 */

/**
 * @param {number} type
 * @param {Uint8Array | string} [payload]
 * @returns {Buffer}
 */
function frame(type, payload = "") {
  const body =
    typeof payload === "string"
      ? Buffer.from(payload, "utf8")
      : Buffer.from(payload);
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

/**
 * @param {(type: number, payload: Buffer) => void} onFrame
 * @returns {(chunk: Buffer) => void}
 */
function decoder(onFrame) {
  /** @type {Buffer} */
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const type = pending.readUInt8(0);
      const length = pending.readUInt32BE(1);
      if (length > MAX_FRAME) throw new Error(`a frame of ${length} bytes`);
      if (pending.length < 5 + length) return;
      const payload = pending.subarray(5, 5 + length);
      pending = pending.subarray(5 + length);
      onFrame(type, payload);
    }
  };
}

/**
 * @param {unknown} err
 * @returns {string | undefined}
 */
function errnoOf(err) {
  return err instanceof Error && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined;
}

/**
 * @param {string} name
 * @returns {name is NodeJS.Signals}
 */
function isSignal(name) {
  return SIGNALS.includes(name);
}

/**
 * Start time and zombie state; null when there is no such process. Linux reads /proc; elsewhere
 * (the loopback test harness) ps, which exits non-zero for a missing pid.
 * @param {number} pid
 * @returns {{ start: string, zombie: boolean } | null}
 */
function procInfo(pid) {
  if (HAS_PROC) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return { start: fields[19] ?? "", zombie: fields[0] === "Z" };
    } catch {
      return null;
    }
  }
  try {
    const line = execFileSync(
      "ps",
      ["-o", "lstart=", "-o", "stat=", "-p", String(pid)],
      {
        encoding: "utf8",
        env: { PATH: "/bin:/usr/bin", LC_ALL: "C", TZ: "UTC" },
      },
    ).trim();
    const stat = line.split(/\s+/).pop() ?? "";
    return line === ""
      ? null
      : {
          start: line.slice(0, line.length - stat.length).trim(),
          zombie: stat.includes("Z"),
        };
  } catch {
    return null;
  }
}

/**
 * @param {number} pgid
 * @param {NodeJS.Signals} signal
 */
function signalGroup(pgid, signal) {
  if (!Number.isSafeInteger(pgid) || pgid < 2) return;
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    // ESRCH: the group is gone. EPERM: what macOS answers when every member left is a zombie, e.g.
    // an orphan init has not reaped yet. Either way no one is left to signal, and a throw here
    // would end the shim before its exit frame.
    const errno = errnoOf(err);
    if (errno !== "ESRCH" && errno !== "EPERM") throw err;
  }
}

/** @returns {number} */
function oomKills() {
  try {
    const events = readFileSync("/sys/fs/cgroup/memory.events", "utf8");
    return Number(/^oom_kill (\d+)$/m.exec(events)?.[1] ?? 0);
  } catch {
    return 0;
  }
}

/** @param {number} pid */
function raiseOomScore(pid) {
  if (!HAS_PROC) return;
  try {
    writeFileSync(`/proc/${pid}/oom_score_adj`, OOM_SCORE_ADJ);
  } catch {
    // Already gone, or a kernel without the knob: nothing to protect.
  }
}

/**
 * @param {string} path
 * @param {ProcRecord} record
 */
function writeRecord(path, record) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string} runDir
 * @param {string} n
 * @returns {ProcRecord | null}
 */
function readRecord(runDir, n) {
  try {
    /** @type {unknown} */
    const value = JSON.parse(readFileSync(join(runDir, `${n}.json`), "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const r = /** @type {Record<string, unknown>} */ (value);
    return typeof r.shimPid === "number" &&
      typeof r.shimStart === "string" &&
      typeof r.pgid === "number" &&
      typeof r.leaderStart === "string"
      ? {
          shimPid: r.shimPid,
          shimStart: r.shimStart,
          pgid: r.pgid,
          leaderStart: r.leaderStart,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * The program leads its group; alive means that leader is the process recorded, not a zombie.
 * @param {ProcRecord} record
 */
function alive(record) {
  const info = procInfo(record.pgid);
  return (
    info !== null &&
    !info.zombie &&
    record.leaderStart !== "" &&
    info.start === record.leaderStart
  );
}

/**
 * @param {Buffer} payload
 * @returns {Hello | string}
 */
function parseHello(payload) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch {
    return "the hello is not JSON";
  }
  if (typeof value !== "object" || value === null)
    return "the hello is not an object";
  const h = /** @type {Record<string, unknown>} */ (value);
  const { argv, cwd, env, stdin, killGraceMs, deadmanMs, heartbeatMs } = h;
  /** @param {unknown} n */
  const positive = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((arg) => typeof arg === "string")
  ) {
    return "hello.argv must be a non-empty list of strings";
  }
  if (typeof cwd !== "string" || !isAbsolute(cwd))
    return "hello.cwd must be absolute";
  if (
    typeof env !== "object" ||
    env === null ||
    !Object.values(env).every((v) => typeof v === "string")
  ) {
    return "hello.env must map names to strings";
  }
  if (stdin !== "pipe" && stdin !== "ignore")
    return "hello.stdin must be pipe or ignore";
  if (
    typeof killGraceMs !== "number" ||
    typeof deadmanMs !== "number" ||
    typeof heartbeatMs !== "number" ||
    !positive(killGraceMs) ||
    !positive(deadmanMs) ||
    !positive(heartbeatMs)
  ) {
    return "hello timers must be positive numbers";
  }
  return {
    argv: /** @type {string[]} */ (argv),
    cwd,
    env: /** @type {Record<string, string>} */ (env),
    stdin,
    killGraceMs,
    deadmanMs,
    heartbeatMs,
  };
}

/**
 * @param {string} n
 * @param {string} runDir
 * @param {string | null} confine  the docker host's remote_root: the program is confined to it first
 */
function run(n, runDir, confine) {
  // A socket, not process.stderr: writes stay asynchronous, so a full pipe never stops this loop
  // (stdin reading and the dead-man below).
  const out = new Socket({ fd: 2, readable: false, writable: true });
  out.on("error", () => {}); // the channel is gone: stdin ends too, and that ends the program
  /**
   * @param {number} type
   * @param {Uint8Array | string} [payload]
   */
  const send = (type, payload) => out.write(frame(type, payload));
  const record = join(runDir, `${n}.json`);
  const oomBefore = oomKills();
  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  /** @type {Hello | null} */
  let hello = null;
  let pgid = 0;
  let done = false;
  /** @type {NodeJS.Timeout | undefined} */
  let deadman;

  /** @param {number} code */
  const quit = (code) => {
    out.end(() => process.exit(code));
    setTimeout(() => process.exit(code), 2000).unref();
  };
  /**
   * @param {string} errno
   * @param {string} message
   */
  const refuse = (errno, message) => {
    done = true;
    send(TYPE.failed, JSON.stringify({ errno, message }));
    quit(127);
  };
  // The dead-man: the channel is gone (EOF) or silent. It never pauses: stdin is always read.
  const terminate = () => {
    if (done) return;
    if (pgid === 0) {
      refuse("ETIMEDOUT", "no program was started");
      return;
    }
    signalGroup(pgid, "SIGTERM");
    setTimeout(
      () => signalGroup(pgid, "SIGKILL"),
      hello?.killGraceMs ?? 5000,
    ).unref();
  };
  const arm = () => {
    clearTimeout(deadman);
    deadman = setTimeout(terminate, hello?.deadmanMs ?? 30_000);
  };

  /** @param {Buffer} payload */
  const feed = (payload) => {
    const ack = () => send(TYPE.ack, JSON.stringify({ bytes: payload.length }));
    const stdin = child?.stdin;
    if (
      stdin === null ||
      stdin === undefined ||
      stdin.destroyed ||
      stdin.writableEnded
    ) {
      ack();
      return;
    }
    stdin.write(payload, () => ack());
  };

  /**
   * @param {import("node:child_process").ChildProcess} proc
   * @param {number | null} code
   * @param {NodeJS.Signals | null} signal
   */
  const onExit = (proc, code, signal) => {
    if (done) return;
    done = true;
    signalGroup(pgid, "SIGKILL"); // what it left in its group: nothing remote reaps it later
    const oom = signal === "SIGKILL" && oomKills() > oomBefore;
    let reported = false;
    const report = () => {
      if (reported) return;
      reported = true;
      try {
        unlinkSync(record);
      } catch {
        // never written, or already gone
      }
      send(TYPE.exit, JSON.stringify({ code, signal, oom }));
      quit(0);
    };
    if (proc.stderr === null || proc.stderr.readableEnded) report();
    else {
      proc.stderr.once("end", report);
      setTimeout(report, 2000).unref();
    }
  };

  /** @param {Hello} h */
  const start = (h) => {
    const proc = spawn(h.argv[0] ?? "", h.argv.slice(1), {
      cwd: h.cwd,
      env: h.env,
      detached: true,
      stdio: [h.stdin, "inherit", "pipe"],
    });
    child = proc;
    proc.stdin?.on("error", () => {}); // EPIPE once it exits: its exit code says what it read
    proc.once("error", (err) => {
      if (pgid === 0 && !done) refuse(errnoOf(err) ?? "EFAIL", err.message);
    });
    proc.once("spawn", () => {
      const pid = proc.pid ?? 0;
      pgid = pid;
      raiseOomScore(pid);
      try {
        writeRecord(record, {
          shimPid: process.pid,
          shimStart: procInfo(process.pid)?.start ?? "",
          pgid: pid,
          leaderStart: procInfo(pid)?.start ?? "",
        });
      } catch (err) {
        signalGroup(pid, "SIGKILL");
        refuse(
          errnoOf(err) ?? "EFAIL",
          `cannot write the record: ${String(err)}`,
        );
        return;
      }
      send(TYPE.started, JSON.stringify({ pgid: pid }));
      setInterval(() => send(TYPE.tick), h.heartbeatMs).unref();
    });
    proc.stderr?.on("data", (chunk) => {
      if (!send(TYPE.stderr, chunk)) {
        proc.stderr?.pause();
        out.once("drain", () => proc.stderr?.resume());
      }
    });
    proc.once("exit", (code, signal) => onExit(proc, code, signal));
  };

  /**
   * @param {number} type
   * @param {Buffer} payload
   */
  const onFrame = (type, payload) => {
    arm();
    if (hello === null) {
      if (type !== TYPE.hello) {
        refuse("EPROTO", "the first frame must be the hello");
        return;
      }
      const parsed = parseHello(payload);
      if (typeof parsed === "string") {
        refuse("EPROTO", parsed);
        return;
      }
      hello = parsed;
      arm();
      const refused = confine === null ? null : confineHost(confine, parsed);
      if (refused !== null) {
        refuse("EACCES", refused);
        return;
      }
      start(parsed);
      return;
    }
    if (type === TYPE.data) feed(payload);
    else if (type === TYPE.eof) child?.stdin?.end();
    else if (type === TYPE.kill) {
      const name = payload.toString("utf8");
      if (isSignal(name) && pgid !== 0 && !done) signalGroup(pgid, name);
    }
    // ping, and anything unknown: the arm() above is all it takes
  };

  const onData = decoder(onFrame);
  process.stdin.on("data", (chunk) => {
    try {
      onData(chunk);
    } catch (err) {
      if (pgid === 0) refuse("EPROTO", String(err));
      else terminate();
    }
  });
  process.stdin.on("end", terminate);
  process.stdin.on("error", terminate);
  arm();
}

/**
 * @param {string} text
 * @param {number} code
 */
function reply(text, code) {
  process.exitCode = code;
  process.stdout.write(`${text}\n`);
}

/**
 * @param {string} runDir
 * @param {string} n
 * @param {string} op
 */
function ctl(runDir, n, op) {
  const signal = op === "probe" ? null : `SIG${op}`;
  if (signal !== null && !isSignal(signal)) {
    reply(`unknown op ${op}`, 2);
    return;
  }
  const record = readRecord(runDir, n);
  if (record === null || !alive(record)) {
    reply("dead", DEAD);
    return;
  }
  if (signal !== null) signalGroup(record.pgid, signal);
  reply(signal === null ? "alive" : "signalled", 0);
}

/**
 * @param {number} pid
 * @returns {{ pid: number, ppid: number, pgid: number, exe: string, argv: string[] } | null}
 */
function readProcess(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    let exe = "";
    try {
      exe = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      // not ours to read: judged by argv below
    }
    return {
      pid,
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
      exe,
      argv,
    };
  } catch {
    return null;
  }
}

/**
 * The keepalive is init's first child: the lowest pid under PID 1 whose /proc/<pid>/exe is sleep.
 * Only the kernel's exe link counts (argv is the program's to forge); an unreadable one is not it.
 * @param {readonly { pid: number, ppid: number, exe: string }[]} procs
 * @returns {number | undefined}
 */
export function keepaliveOf(procs) {
  return procs
    .filter((p) => p.ppid === 1 && p.exe !== "" && basename(p.exe) === "sleep")
    .map((p) => p.pid)
    .sort((a, b) => a - b)[0];
}

/** @param {string} path @param {string} dir */
const inside = (path, dir) => path === dir || path.startsWith(`${dir}/`);

/**
 * Where an absolute path physically leads: resolved one component at a time with realpath(3), so
 * a `..` after a symlink goes where the kernel sends it. A dangling symlink is followed to its
 * target (writing through one creates the target); the part that does not exist yet is appended
 * lexically, as `mkdir -p` would create it. Past 40 links the kernel says ELOOP anyway.
 * @param {string} path
 * @param {number} [depth]
 * @returns {string}
 */
export function physical(path, depth = 0) {
  const parts = path.split("/").filter((part) => part !== "");
  let real = "/";
  for (let i = 0; i < parts.length; i += 1) {
    const next = `${real === "/" ? "" : real}/${parts[i]}`;
    try {
      real = realpathSync.native(next);
      continue;
    } catch {
      // missing, or a dangling symlink
    }
    let link;
    try {
      link = readlinkSync(next);
    } catch {
      return normalize(join(real, ...parts.slice(i)));
    }
    if (depth >= 40) return normalize(join(real, ...parts.slice(i)));
    const target = link.startsWith("/") ? link : `${real}/${link}`;
    const rest = parts.slice(i + 1).join("/");
    return physical(rest === "" ? target : `${target}/${rest}`, depth + 1);
  }
  return real;
}

/** @param {string} s */
const looksLikePath = (s) =>
  s.startsWith("/") || s.startsWith(".") || s.includes("/");

/**
 * The docker host route, checked where the paths are: the cwd
 * must physically lie in remoteRoot/{mirror,bin,run}; every path-like argument (a `--flag=` value,
 * or a bare word naming an entry in the cwd) must stay in remoteRoot and out of remoteRoot/work;
 * the program may be any system program (a bare name resolves on PATH all the same), never one
 * under remoteRoot/work; env values (split on `:`) may point elsewhere, never into
 * remoteRoot/work. Null when allowed, else why not.
 * @param {string} remoteRoot
 * @param {{ argv: readonly string[], cwd: string, env: Readonly<Record<string, string>> }} h
 * @returns {string | null}
 */
export function confineHost(remoteRoot, h) {
  let root;
  try {
    root = realpathSync.native(remoteRoot);
  } catch {
    return `${remoteRoot} does not exist`;
  }
  const work = `${root}/work`;
  const cwd = physical(h.cwd);
  if (!["mirror", "bin", "run"].some((d) => inside(cwd, `${root}/${d}`))) {
    return `cwd ${h.cwd} leads to ${cwd}: a docker-host exec runs only in ${root}/{mirror,bin,run}`;
  }
  /** @param {string} p */
  const at = (p) => physical(p.startsWith("/") ? p : `${cwd}/${p}`);
  /** A bare word is a path too when the cwd holds an entry by that name (a link, dangling or not).
   * @param {string} s */
  const names = (s) => {
    if (looksLikePath(s)) return true;
    if (s === "" || s.startsWith("-")) return false;
    if (existsSync(`${cwd}/${s}`)) return true;
    try {
      readlinkSync(`${cwd}/${s}`);
      return true;
    } catch {
      return false;
    }
  };
  const [program = "", ...args] = h.argv;
  if (names(program) && inside(at(program), work)) {
    return `the program ${program} lies in a session root`;
  }
  for (const arg of args) {
    const eq = arg.indexOf("=");
    for (const candidate of eq >= 0 ? [arg, arg.slice(eq + 1)] : [arg]) {
      if (candidate === "/dev/null" || !names(candidate)) continue;
      const target = at(candidate);
      if (inside(target, work) || !inside(target, root)) {
        return `argument ${JSON.stringify(arg)} leads to ${target}: a docker-host exec stays in ${root} and out of its sessions`;
      }
    }
  }
  for (const [name, value] of Object.entries(h.env)) {
    if (value.split(":").some((v) => looksLikePath(v) && inside(at(v), work))) {
      return `env ${name} leads into a session root`;
    }
  }
  return null;
}

/** Only inside a container started with --init: PID 1 is docker-init (tini). */
function inFrmContainer() {
  try {
    const init = readFileSync("/proc/1/cmdline", "utf8").split("\0")[0] ?? "";
    return ["docker-init", "tini"].includes(basename(init));
  } catch {
    return false;
  }
}

/**
 * @param {string} runDir
 * @param {string[]} tokens
 */
function sweep(runDir, tokens) {
  if (!HAS_PROC || !inFrmContainer()) {
    reply("refused: sweep runs only inside an frm container", 2);
    return;
  }
  const procs = readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .map((name) => readProcess(Number(name)))
    .filter((p) => p !== null);
  const keep = new Set([1, process.pid]);
  const groups = new Set();
  // The supervisor's live refs are the authority; a record only maps a token to a pgid.
  for (const n of tokens) {
    const record = readRecord(runDir, n);
    if (record === null) continue;
    keep.add(record.shimPid);
    groups.add(record.pgid);
  }
  const keepalive = keepaliveOf(procs);
  if (keepalive !== undefined) keep.add(keepalive);
  let killed = 0;
  for (const p of procs) {
    if (keep.has(p.pid) || groups.has(p.pgid)) continue;
    // docker exec'd control calls (ctl, sweep) have no parent in the container; programs never do
    const control = p.ppid === 0 && ["ctl", "sweep"].includes(p.argv[2] ?? "");
    if (control) continue;
    try {
      process.kill(p.pid, "SIGKILL");
      killed += 1;
    } catch {
      // already gone
    }
  }
  reply(`killed=${killed}`, 0);
}

function main() {
  const [mode = "", ...args] = process.argv.slice(2);
  const [a0 = "", a1 = "", a2 = ""] = args;
  if (mode === "run" && args.length === 2 && TOKEN.test(a0) && isAbsolute(a1)) {
    run(a0, a1, null);
  } else if (
    mode === "host" &&
    args.length === 2 &&
    TOKEN.test(a0) &&
    isAbsolute(a1)
  ) {
    run(a0, join(a1, "run"), a1);
  } else if (
    mode === "ctl" &&
    args.length === 3 &&
    isAbsolute(a0) &&
    TOKEN.test(a1)
  ) {
    ctl(a0, a1, a2);
  } else if (
    mode === "sweep" &&
    isAbsolute(a0) &&
    args.slice(1).every((n) => TOKEN.test(n))
  ) {
    sweep(a0, args.slice(1));
  } else {
    process.stderr.write(
      "usage: exec-shim run <n> <runDir> | host <n> <remoteRoot> | ctl <runDir> <n> <op> | sweep <runDir> <n...>\n",
    );
    process.exitCode = 2;
  }
}

/** Run as a program (never on import, so tests can load the pure functions above). */
function isMain() {
  try {
    return (
      realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}

if (isMain()) main();
