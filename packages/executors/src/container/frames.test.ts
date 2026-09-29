import { describe, expect, test } from "vitest";
import {
  encodeFrame,
  encodeJson,
  FrameDecoder,
  FrameType,
  MAX_FRAME_BYTES,
  payloadJson,
  type Frame,
} from "./frames.js";

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
};

const firstOf = (frames: readonly Frame[]): Frame => {
  const [first] = frames;
  if (first === undefined) throw new Error("no frame");
  return first;
};

describe("exec-shim frames", () => {
  test("round-trip, even when the stream arrives one byte at a time", () => {
    const wire = Buffer.concat([
      encodeJson(FrameType.hello, { argv: ["x"] }),
      encodeFrame(FrameType.data, new Uint8Array([0, 1, 255])),
      encodeFrame(FrameType.kill, "SIGTERM"),
      encodeFrame(FrameType.eof),
    ]);
    const decoder = new FrameDecoder();
    const frames = [...wire].flatMap((byte) =>
      decoder.push(new Uint8Array([byte])),
    );
    expect(frames.map((f) => f.type)).toEqual([
      FrameType.hello,
      FrameType.data,
      FrameType.kill,
      FrameType.eof,
    ]);
    expect(payloadJson(firstOf(frames))).toEqual({ argv: ["x"] });
    expect([...(frames[1]?.payload ?? [])]).toEqual([0, 1, 255]);
    expect(frames[2]?.payload.toString()).toBe("SIGTERM");
    expect(frames[3]?.payload.length).toBe(0);
    expect(decoder.broken).toBe(false);
  });

  test("text that is not a frame (an ssh or docker error) becomes the diagnostic", () => {
    const decoder = new FrameDecoder();
    expect(
      decoder.push(Buffer.from("ssh: connect to host h port 22: refused\n")),
    ).toEqual([]);
    decoder.push(Buffer.from("more\n"));
    expect(decoder.broken).toBe(true);
    expect(decoder.diagnostic).toBe(
      "ssh: connect to host h port 22: refused\nmore",
    );
  });

  test("frames before stray bytes are kept; the rest is diagnostic", () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(
      Buffer.concat([
        encodeJson(FrameType.started, { pgid: 7 }),
        Buffer.from("Error: boom"),
      ]),
    );
    expect(frames.map((f) => f.type)).toEqual([FrameType.started]);
    expect(decoder.diagnostic).toBe("Error: boom");
  });

  test("a frame over the size cap is refused on both ends", () => {
    expect(
      caught(() =>
        encodeFrame(FrameType.data, new Uint8Array(MAX_FRAME_BYTES + 1)),
      ),
    ).toMatchObject({ class: "validation" });
    const header = Buffer.alloc(5);
    header.writeUInt8(FrameType.stderr, 0);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 1);
    const decoder = new FrameDecoder();
    expect(decoder.push(header)).toEqual([]);
    expect(decoder.broken).toBe(true);
  });

  test("a malformed JSON payload is an internal error", () => {
    const frame: Frame = {
      type: FrameType.exit,
      payload: Buffer.from("{nope"),
    };
    expect(caught(() => payloadJson(frame))).toMatchObject({
      class: "internal",
    });
  });
});
