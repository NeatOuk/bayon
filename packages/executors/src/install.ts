// Where an install listens: the API's host and port and the GUI's dev port belong to the
// home. `frm init` writes them to `$FRM_HOME/install.json`; the API, the GUI's dev server, the
// supervisor (the MCP URL its sessions call) and frm (the API URL it calls) all read them here, so a
// second install started on its own home never reaches the first one's API. No file: 3010 and 5173,
// the default install's ports, exactly as before.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import { z } from "zod";
import { frmError } from "./errors.js";
import { installHome } from "./keychain-scope.js";

type Env = Readonly<Record<string, string | undefined>>;

export const INSTALL_FILE = "install.json";
export const DEFAULT_API_HOST = "127.0.0.1";
export const DEFAULT_PORTS = { api: 3010, web: 5173 } as const;

const Port = z.int().min(1).max(65_535);
/** From the environment, 0 too: the API's tests bind a free port that way. */
const EnvPort = z.int().min(0).max(65_535);

/** The hosts an install file may name for the API: this machine only. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "localhost",
]);
/** The wildcards, which put the API on the network: only with `"expose": true` in the file. */
export const WILDCARD_HOSTS: ReadonlySet<string> = new Set(["0.0.0.0", "::"]);

/**
 * The API's block. A file in the home is less trusted than the operator's own environment: it may
 * bind loopback, or a wildcard when it says `"expose": true` out loud; any other address (a LAN
 * interface, a remote name the clients would then dial with the bearer) only from FRM_API_HOST.
 */
const ApiBlock = z
  .strictObject({
    host: z.string().min(1),
    port: Port,
    expose: z.literal(true).optional(),
  })
  .refine(
    (api) =>
      LOOPBACK_HOSTS.has(api.host) ||
      (WILDCARD_HOSTS.has(api.host) && api.expose === true),
    {
      message:
        'api.host must be 127.0.0.1, ::1 or localhost (0.0.0.0 or :: only with "expose": true); set FRM_API_HOST for any other address',
      path: ["host"],
    },
  );

export const InstallFile = z.strictObject({
  version: z.literal(1),
  api: ApiBlock,
  web: z.strictObject({ port: Port }),
});
export type InstallFile = z.infer<typeof InstallFile>;

export interface InstallPorts {
  /** The address the API binds. */
  readonly apiHost: string;
  /** Where apiHost came from: the operator's env, the home's file, or the default. */
  readonly apiHostFrom: "env" | "file" | "default";
  readonly apiPort: number;
  /** The GUI dev server's port. */
  readonly webPort: number;
}

const codeOf = (e: unknown): string | undefined =>
  e instanceof Error && "code" in e && typeof e.code === "string"
    ? e.code
    : undefined;

/** The home's install file; null when it does not exist. */
export function readInstallFile(home: string): Result<InstallFile | null> {
  const path = join(home, INSTALL_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (codeOf(e) === "ENOENT") return ok(null);
    return err(frmError("validation", `cannot read ${path}: ${String(e)}`));
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return err(frmError("validation", `${path} is not JSON`));
  }
  const parsed = InstallFile.safeParse(json);
  return parsed.success
    ? ok(parsed.data)
    : err(
        frmError(
          "validation",
          `${path} is not an install file: ${z.prettifyError(parsed.error)}`,
        ),
      );
}

/** Writes the install file, 0600, through a temp file and a rename. */
export function writeInstallFile(
  home: string,
  file: InstallFile,
): Result<void> {
  const path = join(home, INSTALL_FILE);
  const temp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temp, path);
    return ok(undefined);
  } catch (e) {
    return err(frmError("internal", `cannot write ${path}: ${String(e)}`));
  }
}

function envPort(env: Env, name: string): Result<number | undefined> {
  const raw = env[name];
  if (raw === undefined || raw === "") return ok(undefined);
  const port = EnvPort.safeParse(Number(raw));
  return port.success
    ? ok(port.data)
    : err(frmError("validation", `${name} is not a port: ${raw}`));
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

/** FRM_API_HOST / FRM_API_PORT / FRM_WEB_PORT, else the home's install file, else the defaults. */
export function installPorts(env: Env): Result<InstallPorts> {
  const file = readInstallFile(installHome(env));
  if (!file.ok) return file;
  const apiPort = envPort(env, "FRM_API_PORT");
  if (!apiPort.ok) return apiPort;
  const webPort = envPort(env, "FRM_WEB_PORT");
  if (!webPort.ok) return webPort;
  const envHost = nonEmpty(env.FRM_API_HOST);
  const fileHost = file.value?.api.host;
  return ok({
    apiHost: envHost ?? fileHost ?? DEFAULT_API_HOST,
    apiHostFrom:
      envHost !== undefined
        ? "env"
        : fileHost !== undefined
          ? "file"
          : "default",
    apiPort: apiPort.value ?? file.value?.api.port ?? DEFAULT_PORTS.api,
    webPort: webPort.value ?? file.value?.web.port ?? DEFAULT_PORTS.web,
  });
}

/** The host a client dials to reach a server bound to `host`: a wildcard is reached on loopback. */
function dialHost(host: string): string {
  if (host === "0.0.0.0") return DEFAULT_API_HOST;
  if (host === "::" || host === "[::]") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

const trimSlashes = (url: string): string => url.replace(/\/+$/, "");

const isLoopbackDial = (host: string): boolean =>
  LOOPBACK_HOSTS.has(host) || host === "[::1]";

/**
 * The API's origin: FRM_API_URL, else this home's host and port. A dial host that came from the
 * home's file must be loopback (the schema already says so; this refuses rather than trust it), so
 * a planted install.json can never send frm's or the GUI's bearer off this machine. FRM_API_URL and
 * FRM_API_HOST are the operator's own ways to reach an API elsewhere.
 */
export function apiUrl(env: Env): Result<string> {
  const explicit = nonEmpty(env.FRM_API_URL);
  if (explicit !== undefined) return ok(trimSlashes(explicit));
  const ports = installPorts(env);
  if (!ports.ok) return ports;
  const host = dialHost(ports.value.apiHost);
  if (ports.value.apiHostFrom === "file" && !isLoopbackDial(host)) {
    return err(
      frmError(
        "validation",
        `the install file names API host ${ports.value.apiHost}, which is not this machine; set FRM_API_URL to reach an API elsewhere`,
      ),
    );
  }
  return ok(`http://${host}:${ports.value.apiPort}`);
}

/** The API's /mcp, which a session's runner calls: FRM_MCP_URL, else apiUrl's origin. */
export function mcpUrl(env: Env): Result<string> {
  const explicit = nonEmpty(env.FRM_MCP_URL);
  if (explicit !== undefined) return ok(explicit);
  const base = apiUrl(env);
  return base.ok ? ok(`${base.value}/mcp`) : base;
}
