// The browser-facing session:<id>:pty gateway (§12.2: "binary frames, separate type" — not the
// JSON ClientFrame/ServerFrame protocol apps/api/src/ws/gateway.ts serves on /ws). A connection
// names its session and its attach-lease token as query params (`?sessionId=&lease=`), since this
// protocol has no in-band subscribe frame the way /ws does. The bearer check at the handshake
// (BearerWsAdapter) still applies to every path on this server, this one included.
import { Inject, Logger } from "@nestjs/common";
import { WebSocketGateway, type OnGatewayConnection } from "@nestjs/websockets";
import type { IncomingMessage } from "node:http";
import type { RawData, WebSocket } from "ws";
import {
  PtyFrameKind,
  decodePtyClientFrame,
  encodePtyData,
  encodePtyResize,
  type PtyClientFrame,
} from "@bayon/proto";
import { PTY_HUB } from "../tokens.js";
import { PtyHub, type PtySession } from "./pty-hub.js";

export const PTY_WS_PATH = "/ws/pty";

/** A browser frame is a few bytes (a keystroke, a resize); refuse anything larger outright. */
const MAX_PTY_CLIENT_FRAME_BYTES = 4 * 1024;

const bytesOf = (data: RawData): Uint8Array =>
  Array.isArray(data)
    ? new Uint8Array(Buffer.concat(data))
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : data;

function parseQuery(url: string | undefined): {
  sessionId: string | undefined;
  lease: string | undefined;
} {
  const q = new URL(url ?? "", "ws://localhost").searchParams;
  return {
    sessionId: q.get("sessionId") ?? undefined,
    lease: q.get("lease") ?? undefined,
  };
}

@WebSocketGateway({
  path: PTY_WS_PATH,
  maxPayload: MAX_PTY_CLIENT_FRAME_BYTES,
})
export class PtyGateway implements OnGatewayConnection {
  readonly #logger = new Logger("ws-pty");
  readonly #hub: PtyHub;

  constructor(@Inject(PTY_HUB) hub: PtyHub) {
    this.#hub = hub;
  }

  handleConnection(socket: WebSocket, req?: IncomingMessage): void {
    const { sessionId, lease } = parseQuery(req?.url);
    if (sessionId === undefined || lease === undefined) {
      socket.close(1008, "sessionId and lease are required");
      return;
    }
    void this.#attach(socket, sessionId, lease);
  }

  async #attach(
    socket: WebSocket,
    sessionId: string,
    lease: string,
  ): Promise<void> {
    const session = await this.#hub.open(sessionId);
    if (session === undefined) {
      socket.close(1008, "no such attached session");
      return;
    }
    let unwatch: (() => void) | undefined = session.watch(socket);
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) return; // this protocol is binary-only; a stray text frame is ignored
      const frame = decodePtyClientFrame(bytesOf(data));
      if (frame !== undefined) void this.#onFrame(session, lease, frame);
    });
    socket.on("close", () => {
      unwatch?.();
      unwatch = undefined;
      this.#hub.release(sessionId);
    });
    socket.on("error", (e) =>
      this.#logger.warn(`session ${sessionId}: ${e.message}`),
    );
    // A stale token (the lease already moved on by the time this socket opened) never writes,
    // but still watches — matching "several tabs may watch; only the lease holder writes".
  }

  async #onFrame(
    session: PtySession,
    lease: string,
    frame: PtyClientFrame,
  ): Promise<void> {
    if (frame.kind === PtyFrameKind.Heartbeat) {
      await session.heartbeat(lease);
      return;
    }
    // Re-encoded, not forwarded verbatim: decodePtyClientFrame already validated the frame, and
    // re-encoding keeps this call site the single place that knows the wire layout on the way
    // back out — the supervisor side decodes the identical bytes (packages/proto/src/pty-wire.ts).
    const wire =
      frame.kind === PtyFrameKind.Data
        ? encodePtyData(frame.bytes)
        : encodePtyResize(frame.cols, frame.rows);
    await session.send(lease, wire);
  }
}
