// The browser<->API wire format for session:<id>:pty (§12.2: "binary frames, separate type"), a
// single-byte type prefix ahead of the payload — not the JSON ClientFrame/ServerFrame protocol
// (packages/proto/src/ws.ts), and not the relay socket's own framing (packages/core/src/relay-frame.ts,
// supervisor<->API only). The API forwards a browser frame's bytes verbatim (type byte included) over
// the relay channel; the supervisor side decodes the same type byte to route data vs. resize vs.
// heartbeat. Server(API)->browser frames carry no prefix: only pty output (and scrollback) ever
// flows that direction, so there is nothing to disambiguate. Plain Uint8Array throughout, never
// Node's Buffer: this module runs in the browser too (apps/web).

export enum PtyFrameKind {
  /** Raw keystroke bytes for the pty. */
  Data = 0,
  /** 4-byte payload: cols (u16be), rows (u16be). */
  Resize = 1,
  /** No payload: renews the attach lease's TTL (§12.5's named renewal mechanism). */
  Heartbeat = 2,
}

/** A browser->API data frame: the type byte, then the raw bytes. */
export function encodePtyData(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + bytes.length);
  out[0] = PtyFrameKind.Data;
  out.set(bytes, 1);
  return out;
}

/** A browser->API resize frame. */
export function encodePtyResize(cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = PtyFrameKind.Resize;
  new DataView(out.buffer).setUint16(1, cols, false);
  new DataView(out.buffer).setUint16(3, rows, false);
  return out;
}

/** A browser->API heartbeat frame: one byte, no payload. */
export function encodePtyHeartbeat(): Uint8Array {
  return new Uint8Array([PtyFrameKind.Heartbeat]);
}

export type PtyClientFrame =
  | { readonly kind: PtyFrameKind.Data; readonly bytes: Uint8Array }
  | {
      readonly kind: PtyFrameKind.Resize;
      readonly cols: number;
      readonly rows: number;
    }
  | { readonly kind: PtyFrameKind.Heartbeat };

/** Decodes a browser->API frame; `undefined` for anything too short or an unknown type byte. */
export function decodePtyClientFrame(
  frame: Uint8Array,
): PtyClientFrame | undefined {
  if (frame.length === 0) return undefined;
  const kind = frame[0];
  if (kind === PtyFrameKind.Data) {
    return { kind: PtyFrameKind.Data, bytes: frame.subarray(1) };
  }
  if (kind === PtyFrameKind.Resize) {
    if (frame.length < 5) return undefined;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    return {
      kind: PtyFrameKind.Resize,
      cols: view.getUint16(1, false),
      rows: view.getUint16(3, false),
    };
  }
  if (kind === PtyFrameKind.Heartbeat) return { kind: PtyFrameKind.Heartbeat };
  return undefined;
}
