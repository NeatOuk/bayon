import { err, ok, type Result } from "@bayon/core";
import type { InboxAfter } from "@bayon/db";
import { z } from "zod";

// `GET /inbox`'s opaque cursor: the keyset of the page's last row, (rank, asked_at, id), as
// base64url JSON. Clients hand it back unread; a cursor this server did not mint is 400.

const Key = z.tuple([
  z.union([z.literal(0), z.literal(1)]),
  z.int().nonnegative(),
  z.string().min(1).max(64),
]);

export const encodeInboxCursor = (after: InboxAfter): string =>
  Buffer.from(JSON.stringify([after.rank, after.asked_at, after.id])).toString(
    "base64url",
  );

export function decodeInboxCursor(cursor: string): Result<InboxAfter> {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    json = undefined;
  }
  const key = Key.safeParse(json);
  return key.success
    ? ok({ rank: key.data[0], asked_at: key.data[1], id: key.data[2] })
    : err({
        class: "validation",
        message: "cursor is not one GET /inbox returned",
        retryable: false,
      });
}
