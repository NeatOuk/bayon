// The built API as a child process on a temp FRM_HOME and database: for the tests that need the
// real /mcp. Test support only.
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

const API_PACKAGE = fileURLToPath(new URL("../../../../api/", import.meta.url));
const API_MAIN = join(API_PACKAGE, "dist", "main.js");

/** Builds the API the child runs; tsc -b is incremental, and a no-op after `pnpm -w build`. */
export function buildApi(): void {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-b", API_PACKAGE], {
    stdio: "inherit",
  });
}

/** A TCP port free on 127.0.0.1 right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export interface ApiChild {
  /** e.g. `http://127.0.0.1:3010/mcp` */
  readonly mcpUrl: string;
  stop(): void;
}

/** The built API on FRM_HOME `home` and database `dbPath`; resolves once /health answers. */
export async function startApiChild(o: {
  readonly home: string;
  readonly dbPath: string;
  readonly token: string;
}): Promise<ApiChild> {
  const port = await freePort();
  const child = spawn(process.execPath, [API_MAIN], {
    env: {
      PATH: process.env["PATH"] ?? "",
      FRM_HOME: o.home,
      FRM_DB: o.dbPath,
      FRM_API_TOKEN: o.token,
      FRM_API_HOST: "127.0.0.1",
      FRM_API_PORT: String(port),
    },
    stdio: "ignore",
  });
  const origin = `http://127.0.0.1:${port}`;
  const stop = () => {
    child.kill("SIGKILL");
  };
  try {
    // A real process on real time: a deadline, never a sleep.
    await vi.waitFor(
      async () => {
        const res = await fetch(`${origin}/api/v1/health`);
        if (!res.ok) throw new Error(`/health answered ${res.status}`);
      },
      { timeout: 30_000, interval: 50 },
    );
  } catch (e) {
    stop();
    throw e;
  }
  return { mcpUrl: `${origin}/mcp`, stop };
}
