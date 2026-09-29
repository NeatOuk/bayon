// The ssh transport of the container executor: one owned ControlMaster per
// executor, a pinned known_hosts, no config file, no agent forwarding; every call multiplexed and
// bounded by its caller's deadline. A dead or wedged master can hold a client, never the timer.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FrmError } from "@bayon/core";
import { frmError, isErrno } from "../errors.js";
import type { ContainerExecutorConfig } from "./config.js";
import { Semaphore } from "./semaphore.js";
import {
  beforeDeadline,
  startChild,
  type ProgramSpec,
  type RemoteChild,
  type RemoteExit,
  type Transport,
} from "./transport.js";

/** macOS caps a unix socket path (sun_path) at 104 bytes. */
export const SUN_PATH_MAX = 104;
/** ssh binds the master at `<ControlPath>.<16 random characters>`, then renames it. */
const BIND_SUFFIX = 17;
const CHECK_MS = 3_000;
/** ConnectTimeout (5 s) plus 2 s. */
const CONNECT_MS = 7_000;
const FAIL_FAST_MS = 2_000;
const POLL_MS = 100;
const SSH_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export type Identity = {
  readonly kind: "file" | "agent";
  /** The private key (`file:`), or the public key naming an agent's key (`agent:`). */
  readonly path: string;
};

export function parseIdentityRef(ref: string): Identity {
  const match = /^(file|agent):(\/\S+)$/.exec(ref);
  if (match === null) {
    throw frmError(
      "validation",
      `identity_ref must be file:<path> or agent:<path>, got ${JSON.stringify(ref)}`,
    );
  }
  return {
    kind: match[1] === "agent" ? "agent" : "file",
    path: match[2] ?? "",
  };
}

/** `/tmp/frm-<uid>/<h12>.sock`: short, and apart per FRM_HOME and executor. */
export function controlPath(
  frmHome: string,
  executorId: string,
  uid: number,
): string {
  const hash = createHash("sha256")
    .update(`${frmHome}\0${executorId}`)
    .digest("hex")
    .slice(0, 12);
  const path = `/tmp/frm-${uid}/${hash}.sock`;
  if (Buffer.byteLength(path) + BIND_SUFFIX > SUN_PATH_MAX) {
    throw frmError(
      "internal",
      `ControlPath ${path} exceeds ${SUN_PATH_MAX} bytes`,
    );
  }
  return path;
}

/** Creates `dir` 0700 if missing; refuses a symlink, someone else's dir, or one open to others. */
export function assertPrivateDir(dir: string, uid: number): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (!isErrno(err, "EEXIST")) {
      throw frmError("internal", `cannot create ${dir}`, { cause: err });
    }
  }
  const stat = lstatSync(dir);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o077) !== 0
  ) {
    throw frmError(
      "internal",
      `${dir} must be a directory of uid ${uid} with mode 0700; refusing to put a ControlMaster there`,
    );
  }
}

export interface SshTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly knownHosts: string;
  readonly identity: Identity;
  readonly controlPath: string;
}

/** The target of executor `executorId`: its pinned known_hosts and its ControlPath. */
export function sshTarget(o: {
  readonly executorId: string;
  readonly frmHome: string;
  readonly ssh: ContainerExecutorConfig["ssh"];
  readonly uid?: number;
}): SshTarget {
  return {
    host: o.ssh.host,
    port: o.ssh.port,
    user: o.ssh.user,
    knownHosts:
      o.ssh.known_hosts ??
      join(o.frmHome, "executors", o.executorId, "known_hosts"),
    identity: parseIdentityRef(o.ssh.identity_ref),
    controlPath: controlPath(
      o.frmHome,
      o.executorId,
      o.uid ?? process.getuid?.() ?? 0,
    ),
  };
}

export const destination = (t: SshTarget) => `${t.user}@${t.host}`;

/** Every connection's options; `controlPath` is `none` for one that must stay off the master. */
export function commonArgs(
  t: SshTarget,
  controlPath: string = t.controlPath,
): string[] {
  return [
    "-F",
    "none",
    "-T",
    "-x",
    "-a",
    ...[
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "UpdateHostKeys=no",
      `UserKnownHostsFile=${t.knownHosts}`,
      "GlobalKnownHostsFile=/dev/null",
      `ControlPath=${controlPath}`,
      "ConnectTimeout=5",
      "ServerAliveInterval=5",
      "ServerAliveCountMax=3",
      "LogLevel=ERROR",
      "IdentitiesOnly=yes",
    ].flatMap((option) => ["-o", option]),
    "-i",
    t.identity.path,
    "-p",
    String(t.port),
  ];
}

/** A client: multiplexed, or failing at once (ProxyCommand=false), never a direct connection. */
export function clientArgs(t: SshTarget, command: string): string[] {
  return [
    ...commonArgs(t),
    "-o",
    "ControlMaster=no",
    "-o",
    "ProxyCommand=false",
    destination(t),
    "--",
    command,
  ];
}

export function masterArgs(t: SshTarget): string[] {
  return [
    ...commonArgs(t),
    "-M",
    "-N",
    "-o",
    "ControlMaster=yes",
    "-o",
    "ControlPersist=no",
    destination(t),
  ];
}

export function controlArgs(t: SshTarget, op: "check" | "exit"): string[] {
  return [
    "-F",
    "none",
    "-o",
    `ControlPath=${t.controlPath}`,
    "-O",
    op,
    destination(t),
  ];
}

/** The ssh process's entire env: never the supervisor's; the agent socket only for `agent:`. */
export function sshEnv(
  identity: Identity,
  from: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const base = { PATH: SSH_PATH, HOME: homedir(), LC_ALL: "C" };
  const sock = from["SSH_AUTH_SOCK"];
  return identity.kind === "agent" && sock !== undefined
    ? { ...base, SSH_AUTH_SOCK: sock }
    : base;
}

/** What an ssh failure means for the caller. */
export function classifySsh(stderr: string, host: string): FrmError {
  const tail = stderr.trim().split("\n").slice(-5).join(" | ").slice(-500);
  if (
    /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No \S+ host key is known/i.test(
      stderr,
    )
  ) {
    return frmError(
      "spawn_failed",
      `ssh to ${host}: host key verification failed; re-pin it with \`frm executor add\` (${tail})`,
    );
  }
  if (/Permission denied|Too many authentication failures/i.test(stderr)) {
    return frmError(
      "spawn_failed",
      `ssh to ${host}: authentication refused (${tail})`,
    );
  }
  if (/bad permissions|UNPROTECTED PRIVATE KEY/i.test(stderr)) {
    return frmError(
      "validation",
      `ssh to ${host}: the identity file is open to others (${tail})`,
    );
  }
  return frmError("timeout", `ssh to ${host} failed: ${tail || "no answer"}`, {
    retryable: true,
  });
}

export interface SshTransportOptions {
  readonly executorId: string;
  readonly frmHome: string;
  readonly ssh: ContainerExecutorConfig["ssh"];
  /** Default: this process's uid. */
  readonly uid?: number;
  /** Where the ssh client is looked up. Default `/usr/bin:/bin:/usr/sbin:/sbin`; the tests put a
   * stand-in first. */
  readonly path?: string;
}

export class SshTransport implements Transport {
  readonly target: SshTarget;
  readonly #env: Record<string, string>;
  readonly #uid: number;
  readonly #log: string;
  readonly #channels: Semaphore;
  readonly #persistMs: number;
  #master: ChildProcess | null = null;
  #connecting: Promise<void> | null = null;
  #failure: { readonly error: FrmError; readonly at: number } | null = null;
  #live = 0;
  #idle: NodeJS.Timeout | undefined;
  #rtt: number | null = null;

  constructor(o: SshTransportOptions) {
    this.#uid = o.uid ?? process.getuid?.() ?? 0;
    this.target = sshTarget({ ...o, uid: this.#uid });
    this.#env = {
      ...sshEnv(this.target.identity),
      ...(o.path === undefined ? {} : { PATH: o.path }),
    };
    this.#log = join(o.frmHome, "logs", `ssh-${o.executorId}.log`);
    this.#channels = new Semaphore(o.ssh.max_channels);
    this.#persistMs = o.ssh.control_persist_ms;
  }

  async start(command: string, signal: AbortSignal): Promise<RemoteChild> {
    const release = await this.#channels.acquire(signal, "an ssh channel");
    try {
      await beforeDeadline(
        this.#ensure(),
        signal,
        `ssh to ${this.target.host}`,
      );
      const starting = startChild(
        "ssh",
        clientArgs(this.target, command),
        this.#env,
      );
      const child = await beforeDeadline(starting, signal, "ssh start").catch(
        (err: unknown) => {
          void starting.then(
            (late) => late.kill(),
            () => undefined,
          );
          throw err;
        },
      );
      this.#busy(child, release);
      return child;
    } catch (err) {
      release();
      throw err;
    }
  }

  async program(command: string, signal: AbortSignal): Promise<ProgramSpec> {
    const release = await this.#channels.acquire(signal, "an ssh channel");
    try {
      await beforeDeadline(
        this.#ensure(),
        signal,
        `ssh to ${this.target.host}`,
      );
    } catch (err) {
      release();
      throw err;
    }
    let released = false;
    return {
      file: "ssh",
      args: clientArgs(this.target, command),
      env: this.#env,
      release: () => {
        if (released) return;
        released = true;
        release();
      },
    };
  }

  transportError(exit: RemoteExit, stderr: string): FrmError | null {
    return exit.code === 255 ? classifySsh(stderr, this.target.host) : null;
  }

  observeRtt(ms: number): void {
    this.#rtt = this.#rtt === null ? ms : 0.8 * this.#rtt + 0.2 * ms;
  }

  rttMs(): number | null {
    return this.#rtt === null ? null : Math.round(this.#rtt);
  }

  async close(signal: AbortSignal): Promise<void> {
    clearTimeout(this.#idle);
    await beforeDeadline(this.#control("exit"), signal, "ssh -O exit").catch(
      () => false,
    );
    this.#killMaster();
  }

  #busy(child: RemoteChild, release: () => void): void {
    this.#live += 1;
    clearTimeout(this.#idle);
    void child.exited.then(() => {
      release();
      this.#live -= 1;
      if (this.#live > 0) return;
      this.#idle = setTimeout(() => {
        void this.#control("exit").then(() => this.#killMaster());
      }, this.#persistMs);
      this.#idle.unref();
    });
  }

  #ensure(): Promise<void> {
    const failed = this.#failure;
    if (failed !== null && Date.now() - failed.at < FAIL_FAST_MS) {
      return Promise.reject(failed.error);
    }
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #connect(): Promise<void> {
    this.#assertCredentials();
    if (this.#masterRunning() && (await this.#control("check"))) return;
    await this.#resetMaster();
    assertPrivateDir(dirname(this.target.controlPath), this.#uid);
    mkdirSync(dirname(this.#log), { recursive: true, mode: 0o700 });
    const offset = existsSync(this.#log) ? statSync(this.#log).size : 0;
    const log = openSync(this.#log, "a", 0o600);
    let master: ChildProcess;
    try {
      master = spawn("ssh", masterArgs(this.target), {
        env: this.#env,
        detached: true,
        stdio: ["ignore", "ignore", log],
      });
    } finally {
      closeSync(log);
    }
    master.on("error", () => {});
    master.unref();
    this.#master = master;
    const deadline = Date.now() + CONNECT_MS;
    while (Date.now() < deadline && exitedOf(master) === false) {
      if (await this.#control("check")) {
        this.#failure = null;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    this.#killMaster();
    const error = classifySsh(readFrom(this.#log, offset), this.target.host);
    this.#failure = { error, at: Date.now() };
    throw error;
  }

  #assertCredentials(): void {
    const { knownHosts, identity } = this.target;
    if (!existsSync(knownHosts)) {
      throw frmError(
        "validation",
        `no pinned host key at ${knownHosts}: pin it with \`frm executor add\``,
      );
    }
    if (!existsSync(identity.path)) {
      throw frmError("validation", `identity ${identity.path} does not exist`);
    }
    if (
      identity.kind === "file" &&
      (statSync(identity.path).mode & 0o077) !== 0
    ) {
      throw frmError(
        "validation",
        `identity ${identity.path} must be mode 0600`,
      );
    }
  }

  #masterRunning(): boolean {
    return this.#master !== null && exitedOf(this.#master) === false;
  }

  /** `ssh -O <op>` against the ControlPath, bounded; true on success. */
  #control(op: "check" | "exit"): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(
        "ssh",
        controlArgs(this.target, op),
        { env: this.#env, timeout: CHECK_MS, killSignal: "SIGKILL" },
        (err) => resolve(err === null),
      );
    });
  }

  /** Our own master, a wedged one, or an orphan of a crashed supervisor: gone before a new one. */
  async #resetMaster(): Promise<void> {
    await this.#control("exit");
    this.#killMaster();
    await this.#killOrphanMasters();
    try {
      unlinkSync(this.target.controlPath);
    } catch (err) {
      if (!isErrno(err, "ENOENT")) {
        throw frmError("internal", `cannot remove ${this.target.controlPath}`, {
          cause: err,
        });
      }
    }
  }

  #killMaster(): void {
    const master = this.#master;
    this.#master = null;
    if (master !== null && exitedOf(master) === false) master.kill("SIGKILL");
  }

  #killOrphanMasters(): Promise<void> {
    const pattern = `ControlPath=${this.target.controlPath} .* -M -N`;
    return new Promise((resolve) => {
      execFile(
        "pgrep",
        ["-u", String(this.#uid), "-f", pattern],
        { timeout: CHECK_MS, killSignal: "SIGKILL" },
        (_err, stdout) => {
          for (const pid of String(stdout).split("\n").map(Number)) {
            if (!Number.isSafeInteger(pid) || pid < 2 || pid === process.pid)
              continue;
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // already gone
            }
          }
          resolve();
        },
      );
    });
  }
}

function exitedOf(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** The log written since `offset`, at most its last 4 KB. */
function readFrom(path: string, offset: number): string {
  try {
    const size = statSync(path).size;
    const start = Math.max(offset, size - 4096);
    const buffer = Buffer.alloc(Math.max(0, size - start));
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      closeSync(fd);
    }
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}
