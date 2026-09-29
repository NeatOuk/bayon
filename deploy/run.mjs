// The service launcher: `node run.mjs <name> <script> [args…]`
// runs the script under this node and tees its stdout and stderr both to Docker's log and to
// $FRM_HOME/logs/<name>.log, which the log_scan probe reads (as start.sh's redirection does on the
// Mac). That file rotates at FRM_LOG_MAX_BYTES (default 10 MiB), keeping FRM_LOG_KEEP (default 3) old
// ones. SIGTERM, SIGINT and SIGHUP are forwarded; the exit status is the child's.
import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";

const fail = (message, code) => {
  process.stderr.write(`run.mjs: ${message}\n`);
  process.exit(code);
};

const positive = (value, fallback) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

const sizeOf = (path) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

const [name, script, ...args] = process.argv.slice(2);
if (
  name === undefined ||
  !/^[a-z][a-z0-9-]{0,31}$/.test(name) ||
  script === undefined
)
  fail("usage: run.mjs <name> <script> [args…]", 2);
const home = process.env.FRM_HOME;
if (!home) fail("FRM_HOME is not set", 2);

const maxBytes = positive(process.env.FRM_LOG_MAX_BYTES, 10 * 1024 * 1024);
const keep = positive(process.env.FRM_LOG_KEEP, 3);
const dir = join(home, "logs");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const path = join(dir, `${name}.log`);
let fd = openSync(path, "a", 0o600);
let size = sizeOf(path);

function rotate() {
  closeSync(fd);
  rmSync(`${path}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i -= 1) {
    try {
      renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    } catch {
      // not there yet
    }
  }
  renameSync(path, `${path}.1`);
  fd = openSync(path, "a", 0o600);
  size = 0;
}

function record(chunk) {
  if (size > 0 && size + chunk.length > maxBytes) rotate();
  writeSync(fd, chunk);
  size += chunk.length;
}

const child = spawn(process.execPath, [script, ...args], {
  stdio: ["inherit", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  record(chunk);
});
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  record(chunk);
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (e) => fail(e.message, 1));
child.on("close", (code, signal) => {
  closeSync(fd);
  const status =
    code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0));
  // Not process.exit(): writes to a piped stdout (docker logs) are asynchronous, and the last lines
  // of a crash are the ones an operator needs (code review). The loop drains them, then exits; the
  // unref'd timer only forces the exit if something else were to keep the process alive.
  process.exitCode = status;
  setTimeout(() => process.exit(status), 2_000).unref();
});
