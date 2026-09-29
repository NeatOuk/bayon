import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { err, ok, type Result } from "@bayon/core";
import { CTR_SSH_TIMEOUT_MS } from "./budget.js";

// The M3 container run's own reach into the shared docker host (plan rule 6): one plain ssh per
// command, the executor's pinned host key, and only fixed commands built from checked tokens. It
// makes nothing unlabelled, removes only by frm.managed=1 + this run's frm.executor, and lists
// the host's unlabelled containers (never touching them) so teardown can prove they are unchanged.

const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOSTNAME = /^[A-Za-z0-9.-]{1,253}$/;
/** The operator's executor name (`--executor`); a per-run suffix keeps runs apart on the host. */
export const BASE_ID = /^[a-z0-9-]{1,24}$/;
const IMAGE_REF = /^(?:sha256:[0-9a-f]{64}|[a-z0-9][a-z0-9._/:@-]{0,254})$/;
const SESSION = /^[0-9A-Za-z_-]{1,64}$/;
const PROGRAM = /^[A-Za-z0-9._-]+$/;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** One ordinary remote command: a docker listing, a copy, a scan. */
export const SSH_TIMEOUT_MS = CTR_SSH_TIMEOUT_MS;

export interface CtrTarget {
  readonly user: string;
  readonly host: string;
  /** A 0600 private key; the host key is the executor's pinned one. */
  readonly key: string;
}

/** FRM_CONTAINER_HOST (`user@host`, required) and FRM_CONTAINER_KEY. */
export function ctrTarget(
  env: Readonly<Record<string, string | undefined>>,
): Result<CtrTarget> {
  const target = env["FRM_CONTAINER_HOST"];
  if (target === undefined)
    return refuse(
      "FRM_CONTAINER_HOST is required: user@host of the docker host",
    );
  const [user = "", host = ""] = target.split("@");
  if (!USER.test(user) || !HOSTNAME.test(host)) {
    return refuse(`FRM_CONTAINER_HOST must be user@host, not ${user}@${host}`);
  }
  const key = env["FRM_CONTAINER_KEY"] ?? join(homedir(), ".ssh", "id_ed25519");
  return ok({ user, host, key });
}

/** One container run: its executor id, remote root, network and canary, all its own. */
export interface CtrRun {
  readonly target: CtrTarget;
  /** `<--executor>-<hex>`: labels, images and the gateway are this run's alone. */
  readonly executorId: string;
  readonly baseId: string;
  /** `/home/<user>/frm/smoke/<26 Crockford>`, removed at teardown behind `rootGuard`. */
  readonly root: string;
  readonly network: string;
  /** A placeholder secret the stand-in receives; it must never reach disk, inspect or a log. */
  readonly canary: string;
  /** The executor's pinned host key, copied there by `frm executor add`. */
  readonly knownHosts: string;
}

const refuse = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

export const rootGuard = (user: string): RegExp =>
  new RegExp(`^/home/${user}/frm/smoke/[0-9A-HJKMNP-TV-Z]{26}$`);

export function newCtrRun(
  baseId: string,
  target: CtrTarget,
  home: string,
): Result<CtrRun> {
  if (!BASE_ID.test(baseId)) {
    return refuse(
      `--executor ${JSON.stringify(baseId)} must match ${BASE_ID.source}: a per-run suffix follows it`,
    );
  }
  const hex = randomBytes(3).toString("hex");
  const executorId = `${baseId}-${hex}`;
  const run = [...randomBytes(26)].map((b) => CROCKFORD[b % 32]).join("");
  return ok({
    target,
    executorId,
    baseId,
    root: `/home/${target.user}/frm/smoke/${run}`,
    network: `frm-smk-${hex}`,
    canary: `frm-canary-${randomBytes(12).toString("hex")}`,
    knownHosts: join(home, "executors", executorId, "known_hosts"),
  });
}

/**
 * A program's stdout, or its failure with the tail of its stderr. Async on purpose: a synchronous
 * child blocks the smoke's event loop, and its HTTP keep-alive sockets go stale behind it.
 */
function runProcess(
  program: string,
  args: readonly string[],
  o: {
    readonly input?: string | Buffer;
    readonly timeoutMs: number;
    readonly env?: NodeJS.ProcessEnv;
    readonly what: string;
  },
): Promise<Result<string>> {
  return new Promise((resolve) => {
    const child = spawn(program, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(o.env === undefined ? {} : { env: o.env }),
    });
    const out: Buffer[] = [];
    const errs: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), o.timeoutMs);
    const fail = (message: string): void =>
      resolve(
        err({
          class: "internal",
          message: `${o.what}: ${message}`,
          retryable: false,
        }),
      );
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => errs.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e.message);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(ok(Buffer.concat(out).toString("utf8")));
        return;
      }
      const stderr = Buffer.concat(errs).toString("utf8").trim().slice(-800);
      const how =
        signal === null
          ? `exit ${code ?? "?"}`
          : `killed by ${signal} after ${o.timeoutMs} ms`;
      fail(stderr === "" ? how : `${how}: ${stderr}`);
    });
    // A program may exit without reading its input: not a failure of ours.
    child.stdin.on("error", () => undefined);
    child.stdin.end(o.input ?? "");
  });
}

/** ssh never reached a shell (the host reset or refused the connection): nothing ran, so retry. */
export const sshUnreached = (message: string): boolean =>
  /: exit 255: (?:kex_exchange_identification:|ssh: connect to host )/.test(
    message,
  );

const SSH_ATTEMPTS = 3;

/**
 * One command on the docker host over this run's own ssh (never the executor's master). The
 * shared host's sshd drops bursts of new connections, so an unreached ssh is tried again.
 */
export async function remote(
  r: CtrRun,
  command: string,
  o: { readonly input?: string | Buffer; readonly timeoutMs?: number } = {},
): Promise<Result<string>> {
  let ran = await ssh(r, command, o);
  for (
    let n = 1;
    n < SSH_ATTEMPTS && !ran.ok && sshUnreached(ran.error.message);
    n += 1
  ) {
    // ponytail: fixed backoff; adds at most 2 connect timeouts + 9 s to an SSH step's budget.
    await sleep(n * 3_000);
    ran = await ssh(r, command, o);
  }
  return ran;
}

function ssh(
  r: CtrRun,
  command: string,
  o: { readonly input?: string | Buffer; readonly timeoutMs?: number },
): Promise<Result<string>> {
  return runProcess(
    "ssh",
    [
      "-F",
      "none",
      "-o",
      "BatchMode=yes",
      "-o",
      `UserKnownHostsFile=${r.knownHosts}`,
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=15",
      "-i",
      r.target.key,
      `${r.target.user}@${r.target.host}`,
      command,
    ],
    {
      timeoutMs: o.timeoutMs ?? SSH_TIMEOUT_MS,
      what: `ssh ${r.target.host}`,
      ...(o.input === undefined ? {} : { input: o.input }),
    },
  );
}

/** The operator's CLI (tools/frm, built) on the smoke's FRM_HOME and database. */
export function frmCli(
  entry: string,
  home: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<Result<string>> {
  return runProcess(process.execPath, [entry, ...args], {
    timeoutMs,
    env: { ...process.env, FRM_HOME: home, FRM_DB: join(home, "foreman.db") },
    what: `frm ${args.slice(0, 2).join(" ")}`,
  });
}

/** Every label filter carries frm.managed=1 and this run's executor id (plan rule 6). */
export const labels = (r: CtrRun): string =>
  `--filter label=frm.managed=1 --filter label=frm.executor=${r.executorId}`;

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

/** The host's containers with no frm.managed label: listed, never touched. */
export async function unlabelled(r: CtrRun): Promise<Result<string[]>> {
  const ran = await remote(
    r,
    `docker ps -a --no-trunc --format '{{.ID}} {{.Label "frm.managed"}}'`,
  );
  if (!ran.ok) return ran;
  return ok(
    lines(ran.value)
      .filter((l) => l.split(" ").length === 1)
      .map((l) => l.split(" ")[0] ?? "")
      .toSorted(),
  );
}

/** What this run left on the host, by its labels, and whether its root is still there. */
export async function leftovers(
  r: CtrRun,
): Promise<Result<Record<string, string>>> {
  const l = labels(r);
  const ran = await remote(
    r,
    [
      `echo containers $(docker ps -aq ${l} | wc -l)`,
      `echo networks $(docker network ls -q ${l} | wc -l)`,
      `echo images $(docker image ls -q ${l} | sort -u | wc -l)`,
      `echo volumes $(docker volume ls -q ${l} | wc -l)`,
      `echo root $(test -e ${r.root} && echo left || echo gone)`,
    ].join("\n"),
  );
  if (!ran.ok) return ran;
  return ok(
    Object.fromEntries(
      lines(ran.value).map((line) => {
        const [key = "", value = ""] = line.split(/\s+/);
        return [key, value];
      }),
    ),
  );
}

/** Removes everything of this run by its labels, then its root (checked against the guard). */
export async function cleanupByLabel(r: CtrRun): Promise<Result<void>> {
  if (!rootGuard(r.target.user).test(r.root)) {
    return refuse(`refusing to remove ${r.root}: not a smoke root`);
  }
  const l = labels(r);
  // Best effort: every line runs, and any failed one fails the call.
  const ran = await remote(
    r,
    [
      "rc=0",
      `docker ps -aq ${l} | xargs -r docker rm -f >/dev/null || rc=1`,
      `docker network ls -q ${l} | xargs -r docker network rm >/dev/null || rc=1`,
      `docker image ls -q ${l} | sort -u | xargs -r docker image rm -f >/dev/null || rc=1`,
      `docker volume ls -q ${l} | xargs -r docker volume rm >/dev/null || rc=1`,
      `rm -rf ${r.root} || rc=1`,
      `rmdir /home/${r.target.user}/frm/smoke 2>/dev/null || true`,
      'exit "$rc"',
    ].join("\n"),
  );
  return ran.ok ? ok(undefined) : ran;
}

/**
 * The reviewer's stand-in CLI into `<root>/mirror/stand-in`, which every session container mounts
 * read-only at its host path, with a shim named after the CLI in its `bin/`: the directory a
 * container's PATH (`env_path`) puts first. Returns that directory.
 */
export async function shipStandIn(
  r: CtrRun,
  stub: { readonly file: string; readonly text: string },
  program: string,
): Promise<Result<string>> {
  if (!PROGRAM.test(program) || !PROGRAM.test(stub.file)) {
    return refuse(`${program} / ${stub.file}: not plain file names`);
  }
  const dir = `${r.root}/mirror/stand-in`;
  const copied = await remote(
    r,
    `set -e; umask 022; mkdir -p ${dir}/bin; cat > ${dir}/${stub.file}`,
    { input: stub.text },
  );
  if (!copied.ok) return copied;
  const shim = `#!/bin/sh\nexec node ${dir}/${stub.file} "$@"\n`;
  const shimmed = await remote(
    r,
    `set -e; cat > ${dir}/bin/${program}; chmod 755 ${dir}/bin/${program}`,
    { input: shim },
  );
  return shimmed.ok ? ok(`${dir}/bin`) : shimmed;
}

/** This run's containers, one session's or all of them. */
export async function containersOf(
  r: CtrRun,
  sessionId?: string,
): Promise<Result<string[]>> {
  if (sessionId !== undefined && !SESSION.test(sessionId)) {
    return refuse(`not a session id: ${sessionId}`);
  }
  const session =
    sessionId === undefined ? "" : ` --filter label=frm.session=${sessionId}`;
  const ran = await remote(
    r,
    `docker ps -aq --no-trunc ${labels(r)}${session}`,
  );
  return ran.ok ? ok(lines(ran.value)) : ran;
}

/** `docker inspect` of every container of this run, as JSON text (searched locally). */
export async function inspectAll(r: CtrRun): Promise<Result<string>> {
  return remote(
    r,
    `ids=$(docker ps -aq ${labels(r)}); if [ -z "$ids" ]; then echo '[]'; else docker inspect $ids; fi`,
  );
}

/** Files under `dir` (inside this run's root) that contain `needle`: it goes on stdin, not argv. */
export async function filesContaining(
  r: CtrRun,
  dir: string,
  needle: string,
): Promise<Result<string[]>> {
  if (
    !/^\/[A-Za-z0-9_./-]+$/.test(dir) ||
    dir.split("/").includes("..") ||
    (dir !== r.root && !dir.startsWith(`${r.root}/`))
  ) {
    return refuse(`${dir}: not a plain path inside ${r.root}`);
  }
  const ran = await remote(r, `grep -rlF -f - ${dir} 2>/dev/null || true`, {
    input: `${needle}\n`,
  });
  return ran.ok ? ok(lines(ran.value)) : ran;
}

/** The gateway container's name: the proxy host on the executor's internal network. */
export async function gatewayName(r: CtrRun): Promise<Result<string>> {
  const ran = await remote(
    r,
    `docker ps ${labels(r)} --filter label=frm.role=gateway --filter status=running --format '{{.Names}}'`,
  );
  if (!ran.ok) return ran;
  const name = lines(ran.value)[0];
  return name === undefined ? refuse("the gateway is not running") : ok(name);
}

const CONNECT_JS = [
  'const http=require("http");const [g,port,h]=process.argv.slice(1);',
  'const r=http.request({host:g,port:Number(port),method:"CONNECT",path:h+":443",timeout:10000});',
  'const say=(s)=>{console.log("CONNECT "+h+" "+s);process.exit(0)};',
  'r.on("connect",(res)=>say(res.statusCode));r.on("response",(res)=>say(res.statusCode));',
  'r.on("timeout",()=>say("timeout"));r.on("error",(e)=>say("error "+e.code));r.end();',
].join("");
const DIRECT_JS = [
  'const net=require("net");const [h]=process.argv.slice(1);',
  "const s=net.connect({host:h,port:443,timeout:8000});",
  'const say=(x)=>{console.log("DIRECT "+x);process.exit(0)};',
  's.on("connect",()=>say("connected"));s.on("timeout",()=>say("timeout"));s.on("error",(e)=>say("error "+e.code));',
].join("");

const b64 = (js: string): string => Buffer.from(js).toString("base64");

/**
 * One egress probe from a labelled throwaway container on the executor's internal network: a
 * CONNECT through the gateway's proxy to `host`, or (`direct`) a TCP connect with no proxy.
 */
export async function egressProbe(
  r: CtrRun,
  o: {
    readonly image: string;
    readonly gateway: string;
    readonly proxyPort: number;
    readonly host: string;
    readonly direct: boolean;
  },
): Promise<Result<string>> {
  if (
    !IMAGE_REF.test(o.image) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(o.gateway) ||
    !/^[a-z0-9.-]{1,253}$/.test(o.host) ||
    !Number.isInteger(o.proxyPort)
  ) {
    return refuse("egress probe: an unsafe token");
  }
  const js = o.direct ? DIRECT_JS : CONNECT_JS;
  const args = o.direct ? o.host : `${o.gateway} ${o.proxyPort} ${o.host}`;
  const ran = await remote(
    r,
    [
      "docker run --rm --pull never",
      `--label frm.managed=1 --label frm.executor=${r.executorId} --label frm.session=smoke-egress`,
      `--network ${r.network} ${o.image}`,
      `node -e "eval(Buffer.from('${b64(js)}','base64').toString())" ${args}`,
    ].join(" "),
  );
  return ran.ok ? ok(lines(ran.value).at(-1) ?? "") : ran;
}
