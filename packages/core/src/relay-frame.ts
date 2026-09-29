// The wire format shared by the supervisor's relay server (apps/supervisor) and its client
// (apps/api): a multiplexed, length-prefixed binary framing over one Unix domain socket
// connection, so pty-style bytes (or any other future byte stream) can cross the process boundary
// between them. Kept here, not in either app, so both sides encode/decode identically.

/** `open`: ask to bind to a channel. `data`: payload for an already-open channel. `close`: this
 * side is done with the channel. `error`: the server refused an `open` (payload is a UTF-8 message). */
export type RelayFrameType = "open" | "data" | "close" | "error";

export interface RelayFrame {
  readonly type: RelayFrameType;
  readonly channelId: string;
  readonly payload: Buffer;
}

/** A channel id is a short identifier (a session id, a tmux target); one byte holds its length. */
export const MAX_CHANNEL_ID_BYTES = 255;
/** A generous cap on one frame's payload: large enough for any pty chunk, small enough to bound memory. */
export const MAX_RELAY_FRAME_BYTES = 1024 * 1024;

const TYPE_CODES: Record<RelayFrameType, number> = {
  open: 1,
  data: 2,
  close: 3,
  error: 4,
};
const CODE_TYPES: Record<number, RelayFrameType> = Object.fromEntries(
  Object.entries(TYPE_CODES).map(([type, code]) => [code, type]),
) as Record<number, RelayFrameType>;

/** Frame on the wire: u32be length (of everything after it) · u8 type · u8 channelIdLen · channelId · payload. */
export function encodeRelayFrame(frame: RelayFrame): Buffer {
  const channelId = Buffer.from(frame.channelId, "utf8");
  if (channelId.byteLength > MAX_CHANNEL_ID_BYTES) {
    throw new RangeError(
      `channel id is ${channelId.byteLength} bytes, over the ${MAX_CHANNEL_ID_BYTES}-byte limit`,
    );
  }
  const body = 2 + channelId.byteLength + frame.payload.byteLength;
  if (body > MAX_RELAY_FRAME_BYTES) {
    throw new RangeError(
      `relay frame body is ${body} bytes, over the ${MAX_RELAY_FRAME_BYTES}-byte limit`,
    );
  }
  const out = Buffer.allocUnsafe(4 + body);
  out.writeUInt32BE(body, 0);
  out.writeUInt8(TYPE_CODES[frame.type], 4);
  out.writeUInt8(channelId.byteLength, 5);
  channelId.copy(out, 6);
  frame.payload.copy(out, 6 + channelId.byteLength);
  return out;
}

export type DecodeStep =
  | { readonly ok: true; readonly frame: RelayFrame }
  | { readonly ok: false; readonly message: string };

/**
 * Accumulates bytes from a stream and yields complete frames as they arrive. One decoder per
 * connection; feed it every chunk in order. A malformed stream (an over-limit length prefix or
 * channel id) yields one `ok: false` step — the caller should close the connection, since the
 * decoder cannot resynchronize after that.
 */
export class RelayFrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  /** Frames completed by this push, in order; a malformed frame ends the list with an error step. */
  push(chunk: Buffer): readonly DecodeStep[] {
    this.#buffer =
      this.#buffer.byteLength === 0
        ? chunk
        : Buffer.concat([this.#buffer, chunk]);
    const steps: DecodeStep[] = [];
    for (;;) {
      if (this.#buffer.byteLength < 4) break;
      const body = this.#buffer.readUInt32BE(0);
      if (body > MAX_RELAY_FRAME_BYTES + MAX_CHANNEL_ID_BYTES + 2) {
        steps.push({
          ok: false,
          message: `frame body ${body} bytes exceeds the limit`,
        });
        return steps;
      }
      if (this.#buffer.byteLength < 4 + body) break; // wait for the rest
      const type = CODE_TYPES[this.#buffer.readUInt8(4)];
      if (type === undefined) {
        steps.push({ ok: false, message: "unknown frame type" });
        return steps;
      }
      const channelIdLen = this.#buffer.readUInt8(5);
      if (6 + channelIdLen > 4 + body) {
        steps.push({ ok: false, message: "channel id longer than its frame" });
        return steps;
      }
      const channelId = this.#buffer.toString("utf8", 6, 6 + channelIdLen);
      const payload = Buffer.from(
        this.#buffer.subarray(6 + channelIdLen, 4 + body),
      );
      steps.push({ ok: true, frame: { type, channelId, payload } });
      this.#buffer = this.#buffer.subarray(4 + body);
    }
    return steps;
  }
}
