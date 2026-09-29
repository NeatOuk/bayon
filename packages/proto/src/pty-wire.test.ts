import { expect, test } from "vitest";
import {
  PtyFrameKind,
  decodePtyClientFrame,
  encodePtyData,
  encodePtyHeartbeat,
  encodePtyResize,
} from "./pty-wire.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

test("a data frame round-trips its bytes", () => {
  const frame = encodePtyData(utf8("ls -la\n"));
  const decoded = decodePtyClientFrame(frame);
  expect(decoded).toEqual({ kind: PtyFrameKind.Data, bytes: utf8("ls -la\n") });
});

test("a resize frame round-trips cols and rows", () => {
  const frame = encodePtyResize(120, 40);
  expect(decodePtyClientFrame(frame)).toEqual({
    kind: PtyFrameKind.Resize,
    cols: 120,
    rows: 40,
  });
});

test("a heartbeat frame carries no payload", () => {
  expect(decodePtyClientFrame(encodePtyHeartbeat())).toEqual({
    kind: PtyFrameKind.Heartbeat,
  });
});

test("an empty buffer decodes to undefined", () => {
  expect(decodePtyClientFrame(new Uint8Array(0))).toBeUndefined();
});

test("an unknown type byte decodes to undefined", () => {
  expect(decodePtyClientFrame(new Uint8Array([99, 1, 2]))).toBeUndefined();
});

test("a truncated resize frame decodes to undefined", () => {
  expect(
    decodePtyClientFrame(new Uint8Array([PtyFrameKind.Resize, 0, 1])),
  ).toBeUndefined();
});

test("a data frame with an empty payload decodes to zero bytes", () => {
  expect(decodePtyClientFrame(new Uint8Array([PtyFrameKind.Data]))).toEqual({
    kind: PtyFrameKind.Data,
    bytes: new Uint8Array(0),
  });
});
