import { TimelineSource, err, ok, type Result } from "@bayon/core";
import type { AgentSessionsAfter, TimelineAfter } from "@bayon/db";
import { z } from "zod";

// The history routes' opaque cursors: the keyset of a page's last row as base64url
// JSON, as GET /inbox's. Clients hand them back unread; one this server did not mint is 400.

const TimelineKey = z.tuple([
  z.int().nonnegative(),
  TimelineSource,
  z.string().min(1).max(128),
]);
const SessionsKey = z.tuple([z.int().nonnegative(), z.string().min(1).max(64)]);

const encode = (key: readonly unknown[]): string =>
  Buffer.from(JSON.stringify(key)).toString("base64url");

function decode<T>(
  key: z.ZodType<T>,
  cursor: string,
  route: string,
): Result<T> {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    json = undefined;
  }
  const parsed = key.safeParse(json);
  return parsed.success
    ? ok(parsed.data)
    : err({
        class: "validation",
        message: `cursor is not one ${route} returned`,
        retryable: false,
      });
}

/** `GET /projects/:id/timeline`'s cursor: `[ts, source, key]` of the page's last row. */
export const encodeTimelineCursor = (after: TimelineAfter): string =>
  encode([after.ts, after.source, after.key]);

export function decodeTimelineCursor(cursor: string): Result<TimelineAfter> {
  const key = decode(TimelineKey, cursor, "GET /projects/:id/timeline");
  return key.ok
    ? ok({ ts: key.value[0], source: key.value[1], key: key.value[2] })
    : key;
}

/** `GET /agents/:id/sessions`'s cursor: `[created_at, id]` of the page's last session. */
export const encodeSessionsCursor = (after: AgentSessionsAfter): string =>
  encode([after.created_at, after.id]);

export function decodeSessionsCursor(
  cursor: string,
): Result<AgentSessionsAfter> {
  const key = decode(SessionsKey, cursor, "GET /agents/:id/sessions");
  return key.ok ? ok({ created_at: key.value[0], id: key.value[1] }) : key;
}
