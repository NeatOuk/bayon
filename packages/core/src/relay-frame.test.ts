import { expect, test } from "vitest";
import {
  MAX_CHANNEL_ID_BYTES,
  MAX_RELAY_FRAME_BYTES,
  RelayFrameDecoder,
  encodeRelayFrame,
} from "./relay-frame.js";

test("a frame round-trips through encode and decode", () => {
  const decoder = new RelayFrameDecoder();
  const wire = encodeRelayFrame({
    type: "data",
    channelId: "s1",
    payload: Buffer.from("hello"),
  });
  const steps = decoder.push(wire);
  expect(steps).toEqual([
    {
      ok: true,
      frame: { type: "data", channelId: "s1", payload: Buffer.from("hello") },
    },
  ]);
});

test("every frame type round-trips, including an empty payload", () => {
  const decoder = new RelayFrameDecoder();
  for (const type of ["open", "data", "close", "error"] as const) {
    const [step] = decoder.push(
      encodeRelayFrame({ type, channelId: "c", payload: Buffer.alloc(0) }),
    );
    expect(step).toEqual({
      ok: true,
      frame: { type, channelId: "c", payload: Buffer.alloc(0) },
    });
  }
});

test("two frames arriving in one chunk both decode, in order", () => {
  const decoder = new RelayFrameDecoder();
  const a = encodeRelayFrame({
    type: "data",
    channelId: "a",
    payload: Buffer.from("1"),
  });
  const b = encodeRelayFrame({
    type: "data",
    channelId: "b",
    payload: Buffer.from("2"),
  });
  const steps = decoder.push(Buffer.concat([a, b]));
  expect(steps.map((s) => (s.ok ? s.frame.channelId : s))).toEqual(["a", "b"]);
});

test("a frame split across many small chunks still decodes once complete", () => {
  const decoder = new RelayFrameDecoder();
  const wire = encodeRelayFrame({
    type: "data",
    channelId: "s1",
    payload: Buffer.from("a longer payload than one byte at a time"),
  });
  const steps = [];
  for (let i = 0; i < wire.byteLength; i += 1) {
    steps.push(...decoder.push(wire.subarray(i, i + 1)));
  }
  expect(steps).toHaveLength(1);
  expect(steps[0]).toEqual({
    ok: true,
    frame: expect.objectContaining({ channelId: "s1" }),
  });
});

test("encodeRelayFrame throws on a channel id over the limit", () => {
  expect(() =>
    encodeRelayFrame({
      type: "open",
      channelId: "x".repeat(MAX_CHANNEL_ID_BYTES + 1),
      payload: Buffer.alloc(0),
    }),
  ).toThrow(RangeError);
});

test("encodeRelayFrame throws on a payload over the limit", () => {
  expect(() =>
    encodeRelayFrame({
      type: "data",
      channelId: "s1",
      payload: Buffer.alloc(MAX_RELAY_FRAME_BYTES),
    }),
  ).toThrow(RangeError);
});

test("a decoded frame body over the limit yields one error step and stops", () => {
  const decoder = new RelayFrameDecoder();
  const bogus = Buffer.alloc(4);
  bogus.writeUInt32BE(MAX_RELAY_FRAME_BYTES + MAX_CHANNEL_ID_BYTES + 100, 0);
  const steps = decoder.push(bogus);
  expect(steps).toEqual([
    { ok: false, message: expect.stringContaining("exceeds the limit") },
  ]);
});

test("an unknown type byte yields one error step", () => {
  const decoder = new RelayFrameDecoder();
  const buf = Buffer.alloc(6);
  buf.writeUInt32BE(2, 0); // body: 1 type byte + 1 channelIdLen byte, no channel id, no payload
  buf.writeUInt8(99, 4); // unknown type code
  buf.writeUInt8(0, 5); // channelIdLen
  const steps = decoder.push(buf);
  expect(steps).toEqual([
    { ok: false, message: expect.stringContaining("unknown frame type") },
  ]);
});
