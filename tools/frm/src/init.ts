// `frm init [--api-port <n>] [--web-port <n>]`: makes FRM_HOME an install
// that starts on its own. It creates the home (0700), stores a fresh API bearer in this home's own
// Keychain service (32 random bytes, through `security -i` on stdin, never argv, never printed), and
// writes the home's ports to install.json, which the API, the GUI's dev server, the supervisor and
// frm read. Idempotent: a stored token and an existing install file are kept; a flag changes a port.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { err, ok, type Result } from "@bayon/core";
import {
  API_TOKEN_NAME,
  DEFAULT_API_HOST,
  DEFAULT_PORTS,
  INSTALL_FILE,
  hostSecrets,
  keychainScope,
  portFree,
  putKeychainSecret,
  readInstallFile,
  writeInstallFile,
  type InstallFile,
  type KeychainOptions,
} from "@bayon/executors";

export const INIT_USAGE = [
  "       frm init [--api-port <n>] [--web-port <n>]",
  "             makes FRM_HOME an install: a new API token in this home's own Keychain service",
  "             (never printed) and its ports in install.json; the default home keeps 3010 and",
  "             5173, any other takes the first free pair after them. Safe to run again.",
] as const;

/** The random bytes of a new bearer: 64 hex characters, what `security -i` reads as one word. */
const TOKEN_BYTES = 32;
/** The API refuses a shorter bearer (apps/api's MIN_TOKEN_LENGTH). */
const MIN_TOKEN_LENGTH = 16;
/** How far past the default ports a second install's are looked for. */
const PORT_SEARCH = 100;

export interface InitCommand {
  readonly apiPort?: number;
  readonly webPort?: number;
}

export interface InitIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** The `security` binary; tests point it at a stand-in, never the real Keychain. */
  readonly keychain?: KeychainOptions;
  /** Whether a port is free; tests inject one. */
  readonly portFree?: (port: number) => Promise<boolean>;
  /** Tests only: the account's default home, which keeps 3010 and 5173. */
  readonly ownerHome?: string;
}

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

function portFlag(
  raw: string | undefined,
  flag: string,
): Result<number | undefined> {
  if (raw === undefined) return ok(undefined);
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? ok(port)
    : invalid(`${flag} is not a port: ${raw}`);
}

export function parseInitCli(argv: readonly string[]): Result<InitCommand> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      options: {
        "api-port": { type: "string" },
        "web-port": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    return invalid(e instanceof Error ? e.message : String(e));
  }
  if (parsed.positionals.length > 0)
    return invalid(`unknown argument: init ${parsed.positionals.join(" ")}`);
  const apiPort = portFlag(parsed.values["api-port"], "--api-port");
  if (!apiPort.ok) return apiPort;
  const webPort = portFlag(parsed.values["web-port"], "--web-port");
  if (!webPort.ok) return webPort;
  return ok({
    ...(apiPort.value === undefined ? {} : { apiPort: apiPort.value }),
    ...(webPort.value === undefined ? {} : { webPort: webPort.value }),
  });
}

/** The API bearer in this home's Keychain service: kept when there, else created and read back. */
async function ensureToken(io: InitIo): Promise<Result<string>> {
  const host = hostSecrets(io.env, {
    ...(io.keychain === undefined ? {} : { keychain: io.keychain }),
    ...(io.ownerHome === undefined ? {} : { ownerHome: io.ownerHome }),
  });
  if (!host.ok) return host;
  const service = host.value.keychain?.service;
  if (host.value.kind === "file" || service === undefined) {
    return invalid(
      "this home keeps its secrets in files, which frm does not write: on the host, run " +
        "deploy/secrets.sh gen <project> FRM_API_TOKEN api web",
    );
  }
  const keychain = host.value.stores.host;
  const where = `the Keychain (service ${service}, account ${API_TOKEN_NAME})`;
  const existing = await keychain.get(API_TOKEN_NAME);
  if (existing.ok) {
    if (existing.value.length < MIN_TOKEN_LENGTH) {
      return invalid(
        `${API_TOKEN_NAME} in ${where} is shorter than ${MIN_TOKEN_LENGTH} characters, which the ` +
          `API refuses; delete it with security delete-generic-password -s ${service} -a ` +
          `${API_TOKEN_NAME}, then run frm init again`,
      );
    }
    return ok(`token   kept in ${where}`);
  }
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const put = await putKeychainSecret({
    ...io.keychain,
    service,
    account: API_TOKEN_NAME,
    value: token,
    replace: false,
  });
  if (!put.ok) return put;
  const back = await keychain.get(API_TOKEN_NAME);
  if (!back.ok || back.value !== token) {
    return err({
      class: "internal",
      message: `${where} did not return the token just written`,
      retryable: false,
    });
  }
  return ok(`token   created in ${where}; it is never printed`);
}

async function firstFree(
  from: number,
  free: (port: number) => Promise<boolean>,
  avoid: number,
): Promise<Result<number>> {
  for (let port = from; port < from + PORT_SEARCH; port += 1) {
    if (port !== avoid && (await free(port))) return ok(port);
  }
  return invalid(
    `no free port in ${from}..${from + PORT_SEARCH - 1}; pass --api-port and --web-port`,
  );
}

/** The install file this run leaves: the existing one, with any flag applied, or a new one. */
async function planInstall(
  cmd: InitCommand,
  existing: InstallFile | null,
  owner: boolean,
  free: (port: number) => Promise<boolean>,
): Promise<Result<InstallFile>> {
  const pick = async (
    flag: number | undefined,
    kept: number | undefined,
    base: number,
    avoid: number,
  ): Promise<Result<number>> => {
    if (flag !== undefined) return ok(flag);
    if (kept !== undefined) return ok(kept);
    return owner ? ok(base) : firstFree(base + 1, free, avoid);
  };
  const api = await pick(
    cmd.apiPort,
    existing?.api.port,
    DEFAULT_PORTS.api,
    cmd.webPort ?? -1,
  );
  if (!api.ok) return api;
  const web = await pick(
    cmd.webPort,
    existing?.web.port,
    DEFAULT_PORTS.web,
    api.value,
  );
  if (!web.ok) return web;
  if (api.value === web.value)
    return invalid(`the API and the GUI cannot share port ${api.value}`);
  return ok({
    version: 1,
    // The host (and an "expose": true beside a wildcard) are kept as the operator left them.
    api: {
      ...(existing?.api ?? { host: DEFAULT_API_HOST }),
      port: api.value,
    },
    web: { port: web.value },
  });
}

const same = (a: InstallFile, b: InstallFile): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

async function ensureInstall(
  cmd: InitCommand,
  home: string,
  io: InitIo,
): Promise<Result<string>> {
  const existing = readInstallFile(home);
  if (!existing.ok) return existing;
  const owner = keychainScope(io.env, io.ownerHome).owner;
  const plan = await planInstall(
    cmd,
    existing.value,
    owner,
    io.portFree ?? portFree,
  );
  if (!plan.ok) return plan;
  const ports = `API ${plan.value.api.host}:${plan.value.api.port}, GUI ${plan.value.web.port}`;
  const path = join(home, INSTALL_FILE);
  if (existing.value !== null && same(existing.value, plan.value))
    return ok(`ports   ${ports}, kept in ${path}`);
  const written = writeInstallFile(home, plan.value);
  return written.ok ? ok(`ports   ${ports}, written to ${path}`) : written;
}

/** An existing home others can read is closed to 0700, with a warning saying so. */
function closeHome(home: string, io: InitIo): void {
  const mode = statSync(home).mode & 0o777;
  if ((mode & 0o077) === 0) return;
  chmodSync(home, 0o700);
  io.err(
    `frm init: warning: ${home} was mode 0${mode.toString(8)}, readable by others; it is 0700 now`,
  );
}

export async function runInitCommand(
  cmd: InitCommand,
  io: InitIo,
): Promise<number> {
  // main resolves the home first (homeEnvOf): FRM_HOME, else the default ~/.foreman, refused under
  // FRM_NO_DEFAULT_HOME. So FRM_HOME is always set here; without it there is nothing to make.
  const raw = io.env["FRM_HOME"];
  if (raw === undefined || raw === "") {
    io.err("frm init: no home was resolved");
    return 2;
  }
  const home = resolve(raw);
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    closeHome(home, io);
  } catch (e) {
    io.err(`frm init: cannot create ${home}: ${String(e)}`);
    return 1;
  }
  const token = await ensureToken(io);
  if (!token.ok) {
    io.err(`frm init: ${token.error.message}`);
    return 1;
  }
  const install = await ensureInstall(cmd, home, io);
  if (!install.ok) {
    io.err(`frm init: ${install.error.message}`);
    return 1;
  }
  io.out(`home    ${home}`);
  io.out(token.value);
  io.out(install.value);
  const fromEnv = io.env[API_TOKEN_NAME];
  if (fromEnv !== undefined && fromEnv !== "") {
    io.err(
      `frm init: note: ${API_TOKEN_NAME} is set in this shell, and wins over the stored one`,
    );
  }
  return 0;
}
