// The API side of the relay socket (§12.5): opens named channels to the supervisor's
// relay server (apps/supervisor/src/relay.ts) over one persistent connection, multiplexed by
// channel id. A future Ticket B (the browser-facing session:<id>:pty WS gateway) is the first real
// consumer — this module only knows about bytes and channel ids, nothing about pty or tmux.
import { createConnection, type Socket } from "node:net";
import {
  RelayFrameDecoder,
  encodeRelayFrame,
  type RelayFrame,
} from "@bayon/core";

export interface Channel {
  /** Sends bytes to the supervisor side of this channel. A no-op once closed. */
  send(bytes: Buffer): void;
  /** Bytes the supervisor side sent for this channel. */
  onData(cb: (bytes: Buffer) => void): void;
  /** The channel ended: the supervisor closed it, refused the `open`, or the connection dropped. */
  onClose(cb: (reason: string) => void): void;
  /** Tells the supervisor this side is done with the channel, then releases it locally. */
  close(): void;
}

export interface RelayClient {
  /** Opens a channel that must already be registered on the supervisor side; the id is opaque to
   * this client (a session id, a tmux target — whatever the caller and the supervisor agree on). */
  openChannel(channelId: string): Channel;
  /** Disconnects entirely; every open channel gets `onClose("client closed")`. */
  close(): void;
}

interface Registered {
  onData: ((bytes: Buffer) => void) | undefined;
  onClose: ((reason: string) => void) | undefined;
  closed: boolean;
}

/** A slow relay socket beyond this many outstanding bytes has sends dropped, not queued forever. */
export const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

/** Connects to the supervisor's relay socket at `path`. One connection, many multiplexed channels. */
export function connectRelay(path: string): RelayClient {
  const socket: Socket = createConnection(path);
  const channels = new Map<string, Registered>();
  const decoder = new RelayFrameDecoder();
  let outstanding = 0;
  let closed = false;

  const closeAll = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const reg of channels.values()) {
      if (!reg.closed) {
        reg.closed = true;
        reg.onClose?.(reason);
      }
    }
    channels.clear();
  };

  socket.on("data", (chunk: Buffer) => {
    for (const step of decoder.push(chunk)) {
      if (!step.ok) {
        socket.destroy();
        closeAll(`malformed relay frame: ${step.message}`);
        return;
      }
      const frame = step.frame;
      const reg = channels.get(frame.channelId);
      if (reg === undefined || reg.closed) continue;
      if (frame.type === "data") {
        reg.onData?.(frame.payload);
      } else if (frame.type === "close" || frame.type === "error") {
        reg.closed = true;
        channels.delete(frame.channelId);
        reg.onClose?.(
          frame.type === "error"
            ? frame.payload.toString("utf8")
            : "closed by the supervisor",
        );
      }
    }
  });
  socket.on("close", () => closeAll("relay connection closed"));
  socket.on("error", (e) => closeAll(`relay connection error: ${e.message}`));

  const sendFrame = (frame: RelayFrame): void => {
    if (outstanding > MAX_QUEUED_BYTES) return; // drop: the socket is too far behind to catch up
    const wire = encodeRelayFrame(frame);
    outstanding += wire.byteLength;
    socket.write(wire, () => {
      outstanding -= wire.byteLength;
    });
  };

  return {
    openChannel(channelId) {
      if (closed) {
        // The relay connection is already gone: this channel can never open. Report it closed
        // once the caller wires up a handler, rather than registering into `channels` (which
        // `closeAll` will never visit again) and leaving the caller with a silent, permanent hang.
        return {
          send: () => undefined,
          onData: () => undefined,
          onClose: (cb) => {
            queueMicrotask(() => cb("relay connection already closed"));
          },
          close: () => undefined,
        };
      }
      const reg: Registered = {
        onData: undefined,
        onClose: undefined,
        closed: false,
      };
      channels.set(channelId, reg);
      sendFrame({ type: "open", channelId, payload: Buffer.alloc(0) });
      return {
        send: (bytes) => {
          if (reg.closed) return;
          sendFrame({ type: "data", channelId, payload: bytes });
        },
        onData: (cb) => {
          reg.onData = cb;
        },
        onClose: (cb) => {
          reg.onClose = cb;
        },
        close: () => {
          if (reg.closed) return;
          reg.closed = true;
          channels.delete(channelId);
          sendFrame({ type: "close", channelId, payload: Buffer.alloc(0) });
        },
      };
    },
    close: () => {
      socket.destroy();
      closeAll("client closed");
    },
  };
}
