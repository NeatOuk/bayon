import { canonicalJson, err, ok, ticketKey } from "@bayon/core";
import { z } from "zod";
import {
  all,
  execute,
  first,
  qb,
  read,
  write,
  type Db,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { FleetRow, RunClassRow } from "../schema.js";
import { keyPrefix } from "./ticket-key.js";

/** The supervisor_state key the supervisor's heartbeat lives under. */
export const HEARTBEAT_KEY = "supervisor.heartbeat";

export interface Heartbeat {
  readonly pid: number;
  readonly version: string;
  readonly startedAt: number;
  /** When it last beat. */
  readonly at: number;
}

const HeartbeatValue = z.object({
  pid: z.int().positive(),
  version: z.string(),
  started_at: z.int(),
});

/**
 * A v_fleet row (§4.1) with its project and its ticket's key. The project is the
 * session's own workspace, else its agent's: the rule admission and the timeline
 * scope a session by.
 */
export interface FleetListing extends FleetRow {
  readonly workspace_id: string | null;
  /** `<prefix><num>`; null when the session has no ticket. */
  readonly ticket_key: string | null;
}

export interface FleetFilter {
  /** One project's live sessions; absent is every one's. */
  readonly workspaceId?: string;
}

/** v_fleet (§4.1), by session id: every live session, or one project's. */
export function getFleet(db: Db, filter: FleetFilter = {}): R<FleetListing[]> {
  const { workspaceId } = filter;
  return read(db, (ix) => {
    const prefix = keyPrefix(ix);
    const rows = all(
      ix,
      qb
        .selectFrom("v_fleet as f")
        .innerJoin("sessions as s", "s.id", "f.id")
        .innerJoin("agents as a", "a.id", "s.agent_id")
        .selectAll("f")
        .select((eb) =>
          eb.fn.coalesce("s.workspace_id", "a.workspace_id").as("workspace_id"),
        )
        .$if(workspaceId !== undefined, (b) =>
          b.where(
            (eb) => eb.fn.coalesce("s.workspace_id", "a.workspace_id"),
            "=",
            workspaceId ?? "",
          ),
        )
        .orderBy("f.id"),
    );
    return rows.map((row): FleetListing => ({
      ...row,
      ticket_key: row.ticket === null ? null : ticketKey(prefix, row.ticket),
    }));
  });
}

/** The run_classes rows, by name. Core's loadRunClasses validates them. */
export function listRunClasses(db: Db): R<RunClassRow[]> {
  return read(db, (ix) =>
    all(ix, qb.selectFrom("run_classes").selectAll().orderBy("name")),
  );
}

export function heartbeat(
  db: Db,
  h: {
    readonly pid: number;
    readonly version: string;
    readonly startedAt: number;
  },
): R<void> {
  return write(db, (ix) => {
    const value_json = canonicalJson({
      pid: h.pid,
      version: h.version,
      started_at: h.startedAt,
    });
    const updated_at = ix.clock.now();
    execute(
      ix,
      qb
        .insertInto("supervisor_state")
        .values({ key: HEARTBEAT_KEY, value_json, updated_at })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value_json, updated_at }),
        ),
    );
    return ok(undefined);
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The supervisor's last heartbeat, or null if it never beat. */
export async function readHeartbeat(db: Db): R<Heartbeat | null> {
  const found = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("supervisor_state")
        .selectAll()
        .where("key", "=", HEARTBEAT_KEY),
    ),
  );
  if (!found.ok) return found;
  if (found.value === undefined) return ok(null);
  const { value_json, updated_at } = found.value;
  const value = HeartbeatValue.safeParse(parseJson(value_json));
  if (!value.success) {
    return err(
      failure(
        "internal",
        `corrupt ${HEARTBEAT_KEY}: ${z.prettifyError(value.error)}`,
      ),
    );
  }
  const { pid, version, started_at } = value.data;
  return ok({ pid, version, startedAt: started_at, at: updated_at });
}
