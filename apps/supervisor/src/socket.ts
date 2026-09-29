// The control socket at <socket dir>/s.sock (FRM_HOME itself, or a short private dir for a long
// home): newline-delimited JSON, operator-only (0600). A live
// socket is never replaced; the supervisor lock (lock.ts), taken first, keeps one supervisor per
// FRM_HOME.
import { chmodSync, lstatSync, rmSync, unlinkSync } from "node:fs";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import {
  err,
  ok,
  type ErrorClass,
  type FrmError,
  type Result,
} from "@bayon/core";
import { SOCKET_PATH_MAX_BYTES } from "@bayon/executors";
import type { Logger } from "pino";
import { z } from "zod";

/** macOS allows 104 bytes in sun_path, NUL included (Linux 108); the stricter limit applies. */
export { SOCKET_PATH_MAX_BYTES };
/** A connection that sends more than this without a newline is closed. */
const MAX_LINE_BYTES = 64 * 1024;

const Request = z.object({ op: z.literal("wake") });

export interface ControlSocket {
  readonly path: string;
  /** Stops listening, closes open connections and removes the socket file. */
  close(): Promise<void>;
}

export interface ControlSocketOptions {
  readonly path: string;
  readonly log: Logger;
  /** `{"op":"wake"}`: the API inserted a command. */
  readonly onWake: () => void;
}

const fail = (cls: ErrorClass, message: string): Result<never> =>
  err({ class: cls, message, retryable: false });

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const codeOf = (e: unknown): string | undefined =>
  e instanceof Error && "code" in e && typeof e.code === "string"
    ? e.code
    : undefined;

/** An error if `path` does not fit in a unix socket address. */
export function checkSocketPath(path: string): Result<void> {
  const bytes = Buffer.byteLength(path);
  return bytes < SOCKET_PATH_MAX_BYTES
    ? ok(undefined)
    : fail(
        "validation",
        `control socket path ${path} is ${bytes} bytes; a unix socket path must fit in ` +
          `${SOCKET_PATH_MAX_BYTES} bytes with its NUL`,
      );
}

/** Resolves "live" if something accepts on `path`, "stale" if nothing does, else the error code. */
function probe(path: string): Promise<string> {
  return new Promise((resolve) => {
    const conn = createConnection(path);
    conn.once("connect", () => {
      conn.destroy();
      resolve("live");
    });
    conn.once("error", (e) => {
      const code = codeOf(e);
      resolve(
        code === "ECONNREFUSED" || code === "ENOENT"
          ? "stale"
          : (code ?? e.message),
      );
    });
  });
}

/** Removes a socket file nobody listens on. A live socket or any other file is a conflict. */
async function clearStale(path: string, log: Logger): Promise<Result<void>> {
  let isSocket: boolean;
  try {
    isSocket = lstatSync(path).isSocket();
  } catch (e) {
    return codeOf(e) === "ENOENT"
      ? ok(undefined)
      : fail("internal", `cannot stat ${path}: ${messageOf(e)}`);
  }
  if (!isSocket) {
    return fail(
      "conflict",
      `${path} exists and is not a socket; refusing to replace it`,
    );
  }
  const state = await probe(path);
  if (state === "live") {
    return fail("conflict", `another supervisor is listening on ${path}`);
  }
  if (state !== "stale")
    return fail("internal", `cannot probe ${path}: ${state}`);
  try {
    unlinkSync(path);
  } catch (e) {
    if (codeOf(e) !== "ENOENT") {
      return fail(
        "internal",
        `cannot remove the stale socket ${path}: ${messageOf(e)}`,
      );
    }
  }
  log.warn({ path }, "replaced a stale control socket");
  return ok(undefined);
}

function reply(
  line: string,
  o: ControlSocketOptions,
): { ok: true } | { ok: false; error: FrmError } {
  let input: unknown;
  try {
    input = JSON.parse(line);
  } catch {
    input = undefined;
  }
  const request = Request.safeParse(input);
  if (!request.success) {
    return {
      ok: false,
      error: {
        class: "validation",
        message: `expected {"op":"wake"}: ${z.prettifyError(request.error)}`,
        retryable: false,
      },
    };
  }
  o.onWake();
  return { ok: true };
}

function serve(conn: Socket, o: ControlSocketOptions): void {
  let buffer = "";
  conn.setEncoding("utf8");
  conn.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      conn.write(`${JSON.stringify(reply(line, o))}\n`);
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      o.log.warn(
        { bytes: Buffer.byteLength(buffer) },
        "control line too long; closing",
      );
      conn.destroy();
    }
  });
  conn.on("error", (e) =>
    o.log.warn({ error: e.message }, "control connection failed"),
  );
}

function listen(server: Server, path: string): Promise<Result<void>> {
  return new Promise((resolve) => {
    server.once("error", (e) =>
      resolve(
        fail(
          codeOf(e) === "EADDRINUSE" ? "conflict" : "internal",
          `cannot listen on ${path}: ${e.message}`,
        ),
      ),
    );
    server.listen(path, () => resolve(ok(undefined)));
  });
}

/**
 * Opens the control socket: checks the path length and listens. Only if the path is taken
 * (EADDRINUSE) is it replaced, and only when it is a socket nobody accepts on; then the file is
 * restricted to the operator (mode 0600). bind() is the atomic step for a start with no file;
 * two starts over one stale file could both replace it, which is why startSupervisor takes the
 * supervisor lock (lock.ts) first.
 */
export async function openControlSocket(
  o: ControlSocketOptions,
): Promise<Result<ControlSocket>> {
  const fits = checkSocketPath(o.path);
  if (!fits.ok) return fits;
  const connections = new Set<Socket>();
  const server = createServer((conn) => {
    connections.add(conn);
    conn.on("close", () => connections.delete(conn));
    serve(conn, o);
  });
  let listening = await listen(server, o.path);
  if (!listening.ok && listening.error.class === "conflict") {
    const cleared = await clearStale(o.path, o.log);
    if (!cleared.ok) return cleared;
    server.close(); // reset after the failed listen, as the net docs' EADDRINUSE retry does
    listening = await listen(server, o.path);
  }
  if (!listening.ok) return listening;
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        try {
          rmSync(o.path, { force: true });
        } catch (e) {
          o.log.error(
            { path: o.path, error: messageOf(e) },
            "cannot remove the control socket",
          );
        }
        resolve();
      });
      for (const conn of connections) conn.destroy();
    });
  try {
    chmodSync(o.path, 0o600);
  } catch (e) {
    await close();
    return fail(
      "internal",
      `cannot restrict ${o.path} to 0600: ${messageOf(e)}`,
    );
  }
  return ok({ path: o.path, close });
}
