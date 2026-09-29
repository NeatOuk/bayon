import { describe, expect, test } from "vitest";
import { decodeInboxCursor, encodeInboxCursor } from "./inbox-cursor.js";

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

describe("the GET /inbox cursor", () => {
  test("round-trips a row's keyset", () => {
    const after = {
      rank: 1 as const,
      asked_at: 1_700_000_000_123,
      id: "01K7X",
    };
    const cursor = encodeInboxCursor(after);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeInboxCursor(cursor)).toEqual({ ok: true, value: after });
  });

  test("anything the server did not mint is a validation error", () => {
    for (const cursor of [
      "nope!",
      b64({ rank: 1 }),
      b64([2, 1, "x"]),
      b64([1, -1, "x"]),
      b64([0, 1, ""]),
      b64([0, 1.5, "x"]),
    ]) {
      expect(decodeInboxCursor(cursor), cursor).toMatchObject({
        ok: false,
        error: { class: "validation" },
      });
    }
  });
});
