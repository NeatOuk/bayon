// The exec-shim wire format: a 1-byte type, a u32 big-endian length, the
// payload. exec-shim.mjs carries its own copy of this codec; frames.test.ts runs one against the
// other.
import { frmError } from "../errors.js";

export const FrameType = {
  /** supervisor → shim: the program, its cwd and its entire env (JSON), first and once. */
  hello: 0x48,
  /** supervisor → shim: stdin bytes, within the credit window. */
  data: 0x44,
  /** supervisor → shim: stdin EOF. */
  eof: 0x5a,
  /** supervisor → shim: a signal name for the program's group. */
  kill: 0x4b,
  /** supervisor → shim: the channel is alive. */
  ping: 0x50,
  /** shim → supervisor: started, `{pgid}`. */
  started: 0x53,
  /** shim → supervisor: cannot start, `{errno, message}`. */
  failed: 0x46,
  /** shim → supervisor: stdin credit returned, `{bytes}`. */
  ack: 0x41,
  /** shim → supervisor: the program's stderr bytes. */
  stderr: 0x45,
  /** shim → supervisor: the channel is alive. */
  tick: 0x54,
  /** shim → supervisor: the last frame, `{code, signal, oom}`. */
  exit: 0x58,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

const KNOWN: ReadonlySet<number> = new Set(Object.values(FrameType));
const HEADER_BYTES = 5;
/** Bounds a hello (1 MiB of argv and env) and any stderr chunk, with room to spare. */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export interface Frame {
  readonly type: FrameType;
  readonly payload: Buffer;
}

export function encodeFrame(
  type: FrameType,
  payload: Uint8Array | string = "",
): Buffer {
  const body =
    typeof payload === "string"
      ? Buffer.from(payload, "utf8")
      : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (body.length > MAX_FRAME_BYTES) {
    throw frmError(
      "validation",
      `a frame of ${body.length} bytes exceeds ${MAX_FRAME_BYTES}`,
    );
  }
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

export const encodeJson = (type: FrameType, value: unknown): Buffer =>
  encodeFrame(type, JSON.stringify(value));

/**
 * Splits a byte stream into frames. Bytes that cannot be a frame, e.g. an ssh or docker error
 * printed where the shim would write, end the framing: from then on everything is `diagnostic`.
 */
export class FrameDecoder {
  #pending: Buffer = Buffer.alloc(0);
  #diagnostic = "";
  #broken = false;

  push(chunk: Uint8Array): Frame[] {
    if (this.#broken) {
      this.#diagnostic += Buffer.from(chunk).toString("utf8");
      return [];
    }
    this.#pending =
      this.#pending.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.#pending, chunk]);
    const frames: Frame[] = [];
    while (this.#pending.length > 0) {
      const type = this.#pending.readUInt8(0);
      if (!isFrameType(type)) return this.#break(frames);
      if (this.#pending.length < HEADER_BYTES) break;
      const length = this.#pending.readUInt32BE(1);
      if (length > MAX_FRAME_BYTES) return this.#break(frames);
      if (this.#pending.length < HEADER_BYTES + length) break;
      frames.push({
        type,
        payload: this.#pending.subarray(HEADER_BYTES, HEADER_BYTES + length),
      });
      this.#pending = this.#pending.subarray(HEADER_BYTES + length);
    }
    return frames;
  }

  /** Whatever arrived that was not a frame, trimmed. */
  get diagnostic(): string {
    return this.#diagnostic.trim();
  }

  get broken(): boolean {
    return this.#broken;
  }

  #break(frames: Frame[]): Frame[] {
    this.#broken = true;
    this.#diagnostic += this.#pending.toString("utf8");
    this.#pending = Buffer.alloc(0);
    return frames;
  }
}

function isFrameType(type: number): type is FrameType {
  return KNOWN.has(type);
}

/** Parses a JSON payload; malformed JSON is a protocol error. */
export function payloadJson(frame: Frame): unknown {
  try {
    return JSON.parse(frame.payload.toString("utf8"));
  } catch (err) {
    throw frmError("internal", "the exec-shim sent a malformed frame", {
      cause: err,
    });
  }
}
