// The GUI's dev and preview servers on this home: the API they proxy, the
// port they take and the bearer they add all come from the install, as the API's own do — the
// port from FRM_WEB_PORT or the home's install.json (5173 on the default install), the API from
// FRM_API_HOST / FRM_API_PORT or install.json, the bearer from FRM_API_TOKEN or this home's own
// Keychain service. A taken port is refused loudly, before Vite can bind localhost under another
// install's wildcard listener.
import { err, ok, type Result } from "@bayon/core";
import {
  apiUrl,
  installHome,
  installPorts,
  portFree,
  readApiToken,
  type ApiTokenOptions,
} from "@bayon/executors/install";
import { extraOrigins } from "./dev-proxy.js";

type Env = Readonly<Record<string, string | undefined>>;

export const PREVIEW_PORT = 4173;

export interface DevSetup {
  /** The API origin the proxy forwards to. */
  readonly apiTarget: string;
  /** The dev server's port. */
  readonly devPort: number;
  /** The bearer; undefined when neither the env nor this home's store has one. */
  readonly token: string | undefined;
  /** The page origins the proxy adds the bearer for. */
  readonly allowedOrigins: ReadonlySet<string>;
  /**
   * The install's home: where its install.json and its host-only local-browser key live. FRM_HOME,
   * else FRM_DB's directory, else the default home (never under FRM_NO_DEFAULT_HOME). The bearer
   * is not read on this default (M3): only the ports and the key, as before.
   */
  readonly home: string;
}

export interface DevSetupOptions extends ApiTokenOptions {
  /** False for `vite build`: no server, so no bearer to read. */
  readonly readToken: boolean;
}

export async function devSetup(
  env: Env,
  o: DevSetupOptions,
): Promise<Result<DevSetup>> {
  const ports = installPorts(env);
  if (!ports.ok) return ports;
  const target = apiUrl({ ...env, FRM_API_URL: undefined });
  if (!target.ok) return target;
  const token = o.readToken
    ? await readApiToken(env, o)
    : ok<string | undefined>(undefined);
  if (!token.ok) return token;
  let extra: readonly string[];
  try {
    extra = extraOrigins(env.FRM_WEB_ORIGINS);
  } catch (e) {
    return err({
      class: "validation",
      message: e instanceof Error ? e.message : String(e),
      retryable: false,
    });
  }
  const devPort = ports.value.webPort;
  return ok({
    home: installHome(env),
    apiTarget: target.value,
    devPort,
    token: token.value,
    allowedOrigins: new Set([
      ...[devPort, PREVIEW_PORT].flatMap((port) => [
        `http://localhost:${port}`,
        `http://127.0.0.1:${port}`,
      ]),
      ...extra,
    ]),
  });
}

/** The line a taken port stops the GUI with: what is wrong and the two ways out. */
export const takenPortMessage = (port: number): string =>
  `the GUI's port ${port} is already taken (another Bayon install, or another server): stop ` +
  `it, or give this install its own port with FRM_WEB_PORT=<port> or pnpm frm init --web-port <port>`;

/** Throws, loudly, when `port` is held on the wildcard or on loopback by anything else. */
export async function refuseTakenPort(
  port: number,
  free: (port: number) => Promise<boolean> = portFree,
): Promise<void> {
  if (!(await free(port))) throw new Error(takenPortMessage(port));
}
