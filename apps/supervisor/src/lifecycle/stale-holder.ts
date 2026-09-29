// The stale holder's release, re-checked (§13.1). doctrine, applied to the
// other reason that is the server noticing something rather than a session being instructed: the
// command is the fast path, never the record. `ticket_staff` asked for this release because the
// holder had been silent past `watchdog.silent_ms`; between that ask and this claim the session may
// have spoken, and a session that is working must not lose its ticket. So the rule is asked again,
// here, against the row as it is now.
//
// Unlike a phase boundary this one never defers to the open run's end: a stale holder's run is
// precisely the thing that is not ending, and a deferral would wait for ever.
import { WATCHDOG_SETTING_KEYS, staleHolder } from "@bayon/core";
import { getSettings, type SessionRow } from "@bayon/db";
import { z } from "zod";
import type { Ctx } from "./context.js";

/** §7.1's reason for the release a staffing call asked for. */
export const STALE_SESSION = "stale_session";

const SilentMs = z.int().positive();

/**
 * Whether `s` is still silent past `watchdog.silent_ms`. False when it has spoken since, and false
 * when the setting cannot be read at all — the same direction staffing fails in, so no session
 * ever loses its ticket over a number this process could not read.
 */
export async function stillStale(ctx: Ctx, s: SessionRow): Promise<boolean> {
  const rows = await getSettings(ctx.db, [WATCHDOG_SETTING_KEYS.silentMs]);
  if (!rows.ok) {
    ctx.log.error(
      { sessionId: s.id, error: rows.error },
      "stale release: cannot read watchdog.silent_ms; the session keeps its ticket",
    );
    return false;
  }
  const silent = SilentMs.safeParse(
    rows.value.get(WATCHDOG_SETTING_KEYS.silentMs),
  );
  if (!silent.success) {
    ctx.log.error(
      { sessionId: s.id },
      "stale release: watchdog.silent_ms is missing or not a positive integer; the session keeps its ticket",
    );
    return false;
  }
  return staleHolder(s, ctx.clock.now(), silent.data);
}
