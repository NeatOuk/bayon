// The relay socket (§12.5): a Unix domain socket, sibling to the control socket
// (socket.ts), carrying multiplexed binary channels between the supervisor (which owns every live
// process, including a future pty) and the API (which will serve those bytes over its own /ws).
// The socket-file lifecycle (stale-file detection, permissions, close semantics) intentionally
// mirrors socket.ts's own — duplicated rather than shared, since the two protocols differ enough
// (line-based JSON vs. multiplexed binary frames) that sharing would mean threading an abstraction
// through code that has been stable and fully covered since an earlier change.
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
  RelayFrameDecoder,
  encodeRelayFrame,
  type ErrorClass,
  type RelayFrame,
  type Result,
} from "@bayon/core";
import type { Logger } from "pino";
import { SOCKET_PATH_MAX_BYTES } from "./socket.js";

/** A slow reader beyond this many outstanding bytes has its writes dropped, not queued forever. */
export const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

export interface ChannelHandlers {
  /** Bytes the API side sent for this channel (e.g. keystrokes). */
  readonly onData: (bytes: Buffer) => void;
  /** The API side is no longer listening — its process disconnected, or it sent `close`. The
   * channel stays registered; a later `open` may bind a fresh connection to it. */
  readonly onClose: () => void;
}

export interface ChannelSink {
  /** Sends bytes to whichever connection currently has this channel open; a no-op if none does. */
  write(bytes: Buffer): void;
  /** Ends the channel for good: tells any open connection, then removes it from the registry. */
  close(): void;
}

export interface RelayServer {
  readonly path: string;
  /** Registers `channelId` so a client's `open` can bind to it. One registration per id; a second
   * call for the same id (before the first calls `close()`) is a conflict. */
  register(channelId: string, handlers: ChannelHandlers): Result<ChannelSink>;
  /** Stops listening, tells every open channel's connection, closes them, removes the socket file. */
  close(): Promise<void>;
}

export interface RelayServerOptions {
  readonly path: string;
  readonly log: Logger;
}

const fail = (cls: ErrorClass, message: string): Result<never> =>
  err({ class: cls, message, retryable: false });

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const codeOf = (e: unknown): string | undefined =>
  e instanceof Error && "code" in e && typeof e.code === "string"
    ? e.code
    : undefined;

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
        `cannot remove the stale relay socket ${path}: ${messageOf(e)}`,
      );
    }
  }
  log.warn({ path }, "replaced a stale relay socket");
  return ok(undefined);
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

interface Registration {
  readonly handlers: ChannelHandlers;
  bound: Socket | undefined;
}

/** Tracks outstanding write bytes per socket so a slow reader's writes get dropped, not queued forever. */
const outstanding = new WeakMap<Socket, number>();

function sendFrame(conn: Socket, frame: RelayFrame, log: Logger): void {
  const queued = outstanding.get(conn) ?? 0;
  if (queued > MAX_QUEUED_BYTES) {
    log.warn(
      { channelId: frame.channelId, queued },
      "relay: dropping a frame, the reader is too far behind",
    );
    return;
  }
  const wire = encodeRelayFrame(frame);
  outstanding.set(conn, queued + wire.byteLength);
  conn.write(wire, () => {
    outstanding.set(
      conn,
      (outstanding.get(conn) ?? wire.byteLength) - wire.byteLength,
    );
  });
}

export async function openRelayServer(
  o: RelayServerOptions,
): Promise<Result<RelayServer>> {
  const bytes = Buffer.byteLength(o.path);
  if (bytes >= SOCKET_PATH_MAX_BYTES) {
    return fail(
      "validation",
      `relay socket path ${o.path} is ${bytes} bytes; a unix socket path must fit in ` +
        `${SOCKET_PATH_MAX_BYTES} bytes with its NUL; socketDir moves a long home's sockets to a short private dir, so this path did not come from it`,
    );
  }
  const registry = new Map<string, Registration>();
  const connections = new Set<Socket>();

  const server = createServer((conn) => {
    connections.add(conn);
    const decoder = new RelayFrameDecoder();
    // Every channel id this connection currently has open — a connection may multiplex several.
    const boundChannelIds = new Set<string>();
    const unbind = () => {
      for (const channelId of boundChannelIds) {
        const reg = registry.get(channelId);
        if (reg?.bound === conn) {
          reg.bound = undefined;
          reg.handlers.onClose();
        }
      }
      boundChannelIds.clear();
    };
    conn.on("data", (chunk: Buffer) => {
      for (const step of decoder.push(chunk)) {
        if (!step.ok) {
          o.log.warn(
            { error: step.message },
            "relay: malformed frame; closing",
          );
          conn.destroy();
          return;
        }
        const { frame } = step;
        if (frame.type === "open") {
          const reg = registry.get(frame.channelId);
          if (reg === undefined) {
            sendFrame(
              conn,
              {
                type: "error",
                channelId: frame.channelId,
                payload: Buffer.from("no such channel", "utf8"),
              },
              o.log,
            );
            continue;
          }
          if (reg.bound !== undefined && reg.bound !== conn) {
            sendFrame(
              conn,
              {
                type: "error",
                channelId: frame.channelId,
                payload: Buffer.from("channel already open", "utf8"),
              },
              o.log,
            );
            continue;
          }
          reg.bound = conn;
          boundChannelIds.add(frame.channelId);
        } else if (frame.type === "data") {
          registry.get(frame.channelId)?.handlers.onData(frame.payload);
        } else if (frame.type === "close") {
          const reg = registry.get(frame.channelId);
          if (reg?.bound === conn) {
            reg.bound = undefined;
            reg.handlers.onClose();
          }
          boundChannelIds.delete(frame.channelId);
        }
        // `error` frames are server->client only; one arriving here is ignored.
      }
    });
    conn.on("close", () => {
      connections.delete(conn);
      unbind();
    });
    conn.on("error", (e) =>
      o.log.warn({ error: e.message }, "relay connection failed"),
    );
  });

  let listening = await listen(server, o.path);
  if (!listening.ok && listening.error.class === "conflict") {
    const cleared = await clearStale(o.path, o.log);
    if (!cleared.ok) return cleared;
    server.close();
    listening = await listen(server, o.path);
  }
  if (!listening.ok) return listening;

  try {
    chmodSync(o.path, 0o600);
  } catch (e) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return fail(
      "internal",
      `cannot restrict ${o.path} to 0600: ${messageOf(e)}`,
    );
  }

  const register = (
    channelId: string,
    handlers: ChannelHandlers,
  ): Result<ChannelSink> => {
    if (registry.has(channelId)) {
      return fail("conflict", `channel ${channelId} is already registered`);
    }
    const reg: Registration = { handlers, bound: undefined };
    registry.set(channelId, reg);
    return ok({
      write: (bytes) => {
        if (reg.bound === undefined) return;
        sendFrame(
          reg.bound,
          { type: "data", channelId, payload: bytes },
          o.log,
        );
      },
      close: () => {
        if (reg.bound !== undefined) {
          sendFrame(
            reg.bound,
            { type: "close", channelId, payload: Buffer.alloc(0) },
            o.log,
          );
        }
        registry.delete(channelId);
      },
    });
  };

  const close = () =>
    new Promise<void>((resolve) => {
      for (const [channelId, reg] of registry) {
        if (reg.bound !== undefined) {
          sendFrame(
            reg.bound,
            { type: "close", channelId, payload: Buffer.alloc(0) },
            o.log,
          );
        }
      }
      registry.clear();
      server.close(() => {
        try {
          rmSync(o.path, { force: true });
        } catch (e) {
          o.log.error(
            { path: o.path, error: messageOf(e) },
            "cannot remove the relay socket",
          );
        }
        resolve();
      });
      for (const conn of connections) conn.destroy();
    });

  return ok({ path: o.path, register, close });
}
