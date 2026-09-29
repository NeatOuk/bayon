import { expect, test } from "vitest";
import {
  decodeSessionsCursor,
  decodeTimelineCursor,
  encodeSessionsCursor,
  encodeTimelineCursor,
} from "./history-cursor.js";

// The history routes' cursors: opaque base64url JSON that round-trips, and anything
// this server did not mint is a validation error, never a crash or a silent first page.

test("a timeline cursor round-trips", () => {
  const after = {
    ts: 1_700_000_000_000,
    source: "session" as const,
    key: "S-1:ended",
  };
  const cursor = encodeTimelineCursor(after);
  expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeTimelineCursor(cursor)).toEqual({ ok: true, value: after });
});

test("a sessions cursor round-trips", () => {
  const after = { created_at: 42, id: "01J0000000000000000000000" };
  expect(decodeSessionsCursor(encodeSessionsCursor(after))).toEqual({
    ok: true,
    value: after,
  });
});

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

test.each([
  ["not base64 JSON", "%%%"],
  ["JSON, not a tuple", b64({ ts: 1 })],
  ["an unknown source", b64([1, "events", "k"])],
  ["a negative ts", b64([-1, "audit", "k"])],
  ["an empty key", b64([1, "audit", ""])],
  ["a float ts", b64([1.5, "audit", "k"])],
])("a timeline cursor that is %s is refused", (_, cursor) => {
  expect(decodeTimelineCursor(cursor)).toMatchObject({
    ok: false,
    error: {
      class: "validation",
      message: "cursor is not one GET /projects/:id/timeline returned",
    },
  });
});

test("a sessions cursor that is a timeline cursor is refused", () => {
  const timeline = encodeTimelineCursor({ ts: 1, source: "audit", key: "k" });
  expect(decodeSessionsCursor(timeline)).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});
