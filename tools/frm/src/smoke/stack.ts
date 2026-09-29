import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok, type Clock, type Result } from "@bayon/core";
import { readHeartbeat, type Db } from "@bayon/db";
import type { ApiClient } from "./api-client.js";
import { BOOT_TIMEOUT_MS } from "./budget.js";
import { pollUntil } from "./deadline.js";
import { logTail, startChild, type Child } from "./procs.js";

// The two processes under test, each started from its built entry point as the operator would.

const ENTRIES = {
  supervisor: "apps/supervisor/dist/main.js",
  api: "apps/api/dist/main.js",
} as const;
export type Entries = Record<keyof typeof ENTRIES, string>;

/** The checkout this CLI runs from: the nearest directory up holding pnpm-workspace.yaml. */
export function repoRoot(
  from: string = fileURLToPath(import.meta.url),
): Result<string> {
  let dir = dirname(from);
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const up = dirname(dir);
    if (up === dir)
      return err({
        class: "not_found",
        message: `no pnpm workspace above ${from}`,
        retryable: false,
      });
    dir = up;
  }
  return ok(dir);
}

/** Both entry points, built. */
export function entries(root: string): Result<Entries> {
  const paths = {
    supervisor: join(root, ENTRIES.supervisor),
    api: join(root, ENTRIES.api),
  };
  const missing = Object.values(paths).filter((path) => !existsSync(path));
  return missing.length === 0
    ? ok(paths)
    : err({
        class: "not_found",
        message: `${missing.join(", ")} missing: run pnpm -w build first`,
        retryable: false,
      });
}

/** A TCP port free on 127.0.0.1 right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** An error if `child` has already exited, carrying the tail of its log. */
function exitedEarly(child: Child): Result<never> | undefined {
  const status = child.status();
  return status === undefined
    ? undefined
    : err({
        class: "internal",
        message:
          `${child.name} exited (${status.code ?? status.signal}) before it was ready; ` +
          `${child.logPath}:\n${logTail(child.logPath)}`,
        retryable: false,
      });
}

interface Boot {
  readonly main: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  /** Called as soon as the process exists, ready or not, so its owner can always stop it. */
  readonly onStart: (child: Child) => void;
}

/** The supervisor on `home`; ready once its heartbeat carries this child's pid. */
export async function startSupervisor(
  b: Boot & {
    readonly db: Db;
    /**
     * The API's /mcp its session runners call: FRM_MCP_URL. Required: without it the
     * supervisor falls back to the default port, the operator's live API, not the one under test.
     */
    readonly mcpUrl: string;
  },
): Promise<Result<Child>> {
  const started = startChild({
    name: "supervisor",
    argv: [process.execPath, b.main],
    env: {
      ...b.env,
      FRM_HOME: b.home,
      FRM_MCP_URL: b.mcpUrl,
    },
    cwd: b.home,
    logPath: join(b.home, "logs", "supervisor.log"),
  });
  if (!started.ok) return started;
  const child = started.value;
  b.onStart(child);
  return pollUntil(
    {
      clock: b.clock,
      timeoutMs: BOOT_TIMEOUT_MS,
      intervalMs: 100,
      what: "supervisor heartbeat",
    },
    async () => {
      const early = exitedEarly(child);
      if (early) return early;
      const beat = await readHeartbeat(b.db);
      return ok(beat.ok && beat.value?.pid === child.pid ? child : undefined);
    },
  );
}

/** The API on 127.0.0.1:`port`; ready once GET /health answers. */
export async function startApi(
  b: Boot & {
    readonly port: number;
    readonly token: string;
    readonly client: ApiClient;
  },
): Promise<Result<Child>> {
  const started = startChild({
    name: "api",
    argv: [process.execPath, b.main],
    env: {
      ...b.env,
      FRM_HOME: b.home,
      FRM_API_TOKEN: b.token,
      FRM_API_HOST: "127.0.0.1",
      FRM_API_PORT: String(b.port),
    },
    cwd: b.home,
    logPath: join(b.home, "logs", "api.log"),
  });
  if (!started.ok) return started;
  const child = started.value;
  b.onStart(child);
  return pollUntil(
    {
      clock: b.clock,
      timeoutMs: BOOT_TIMEOUT_MS,
      intervalMs: 100,
      what: "API /health",
    },
    async () => {
      const early = exitedEarly(child);
      if (early) return early;
      return ok((await b.client.health()).ok ? child : undefined);
    },
  );
}
