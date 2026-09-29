import { DEFAULT_TICKET_KEY_PREFIX, TicketKeyPrefix } from "@bayon/core";
import { first, qb, type Internals } from "../connection.js";

// The prefix of tickets' keys as a writer or a read inside a transaction sees it: the context pack
// shows keys, and a staffing proposal's question names its ticket by one.

const KEY_PREFIX_SETTING = "tickets.key_prefix";

/** settings.tickets.key_prefix; the default when it is absent or malformed, as the facts take it. */
export function keyPrefix(ix: Internals): string {
  const row = first(
    ix,
    qb
      .selectFrom("settings")
      .select("value_json")
      .where("key", "=", KEY_PREFIX_SETTING),
  );
  if (row === undefined) return DEFAULT_TICKET_KEY_PREFIX;
  let value: unknown;
  try {
    value = JSON.parse(row.value_json);
  } catch {
    return DEFAULT_TICKET_KEY_PREFIX;
  }
  const prefix = TicketKeyPrefix.safeParse(value);
  return prefix.success ? prefix.data : DEFAULT_TICKET_KEY_PREFIX;
}
