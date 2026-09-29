import {
  WATCHDOG_SETTING_KEYS,
  err,
  ok,
  staleHolder,
  type HolderSilence,
  type Result,
} from "@bayon/core";
import { sql } from "kysely";
import { z } from "zod";
import { first, qb, type Internals } from "../connection.js";
import { failure } from "../errors.js";
import { insertCommandIn } from "./commands.js";
import { SESSION_HANDOFF } from "./phase-handoff.js";

// The stale holder's release (§11.1 + §13.1). The `stale_session` arm tells the
// orchestrator to re-staff a hung session's ticket and `ticket_staff` is the only lever its
// allowlist carries, so the refusal at that lever *is* the dead end. This is the way out, and it
// is an earlier change's: the API inserts the holder's own `session.handoff` in the staffing transaction,
// the supervisor claims it and writes `sessions`/`handoffs` (Invariant 5). Nothing here ends a
// session, nulls a hold or spawns anything — it asks, once, for the release the arm promised.
//
// Two numbers used to disagree (the arm's hard-coded 30 minutes and nothing at all on this side);
// making a third would repeat the bug. There is one: `watchdog.silent_ms`, which 025 teaches the
// view to read too, so the arm fires exactly when the remedy is available.

/** The `handoffs.reason` a release carries. */
export const STALE_SESSION = "stale_session";

const SILENT_MS_KEY = WATCHDOG_SETTING_KEYS.silentMs;
const SilentMs = z.int().positive();

/**
 * `watchdog.silent_ms` inside the caller's transaction, as `dailyCap` reads its own row: null when
 * no row is set, which means no holder is ever stale and staffing refuses exactly as it did
 * before. A row that is there but unreadable is a config error, not a silent default — the
 * watchdog itself refuses to boot on one (`readWatchdogSettings`).
 */
export function silentMs(ix: Internals): Result<number | null> {
  const row = first(
    ix,
    qb
      .selectFrom("settings")
      .select("value_json")
      .where("key", "=", SILENT_MS_KEY),
  );
  if (row === undefined) return ok(null);
  let value: unknown;
  try {
    value = JSON.parse(row.value_json);
  } catch {
    return err(failure("internal", `${SILENT_MS_KEY} is not JSON`));
  }
  const ms = SilentMs.safeParse(value);
  return ms.success
    ? ok(ms.data)
    : err(failure("internal", `${SILENT_MS_KEY} must be a positive integer`));
}

/** The holder a staffing call met, and how long it has been quiet. */
export interface Holder extends HolderSilence {
  readonly id: string;
}

/** The release a staffing call asked for. */
export interface StaleRelease {
  readonly command_id: string;
  readonly session_id: string;
  /** How long the holder had been silent when the release was asked for. */
  readonly silent_for_ms: number;
  /** The threshold it passed, so the refusal can name the setting's value. */
  readonly silent_ms: number;
}

/** A `session.handoff` the supervisor has not finished: this session is already being asked. */
const OUTSTANDING = ["pending", "claimed"] as const;

/** The outstanding `session.handoff` for `sessionId`, whatever asked for it, or undefined. */
function outstandingAsk(ix: Internals, sessionId: string): string | undefined {
  const row = first(
    ix,
    qb
      .selectFrom("commands as c")
      .select("c.id")
      .where("c.type", "=", SESSION_HANDOFF)
      .where("c.state", "in", OUTSTANDING)
      .where(
        sql<string | null>`json_extract(c.payload_json, '$.session_id')`,
        "=",
        sessionId,
      ),
  );
  return row?.id;
}

/**
 * Asks the holder to hand off, if it is stale; null when it is merely slow, and then the caller
 * refuses as it always has.
 *
 * One ask at a time, rather than one ask per key: an outstanding `session.handoff` for this
 * session — this reason's or a phase boundary's or the operator's — is the ask, and its id is what
 * the refusal names. Keying it instead would be the dead end again in miniature: a command that
 * ended `failed` (the session was `human_attached` when it was claimed, say) would be replayed to
 * every later call for ever, and the release would never be asked for a second time. A settled
 * command cannot make this fire twice, because a release that landed leaves a session that is no
 * longer a live holder, and one that did not leaves a ticket that still needs asking.
 */
export function releaseStaleHolder(
  ix: Internals,
  holder: Holder,
  silent: number | null,
): Result<StaleRelease | null> {
  const now = ix.clock.now();
  if (silent === null || !staleHolder(holder, now, silent)) return ok(null);
  const asked = outstandingAsk(ix, holder.id);
  const released = (command_id: string): StaleRelease => ({
    command_id,
    session_id: holder.id,
    silent_for_ms: now - (holder.last_event_at ?? now),
    silent_ms: silent,
  });
  if (asked !== undefined) return ok(released(asked));
  const inserted = insertCommandIn(ix, {
    type: SESSION_HANDOFF,
    payload: { session_id: holder.id, reason: STALE_SESSION },
  });
  return inserted.ok ? ok(released(inserted.value.id)) : inserted;
}

const MINUTE = 60_000;
const minutes = (ms: number): string => `${Math.floor(ms / MINUTE)}m`;

/** What the refusal tells its caller to do: ask again once the session has ended. */
export const releasingDetail = (num: number, r: StaleRelease): string =>
  `ticket #${num}'s holder (session ${r.session_id}) has been silent for ${minutes(r.silent_for_ms)}, past watchdog.silent_ms (${minutes(r.silent_ms)}): its hand-off is queued (command ${r.command_id}). Staff it again once the session has ended.`;
