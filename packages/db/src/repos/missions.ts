import {
  err,
  newId,
  ok,
  renderMission,
  sha256Hex,
  type MissionText,
} from "@bayon/core";
import {
  all,
  execute,
  first,
  qb,
  read,
  returningOne,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure, orNotFound } from "../errors.js";
import type { MissionRow } from "../schema.js";

// Missions (§4): versioned per agent name, never edited in place. The API is the only writer
// (§9.5), and it owns `agents.mission_id` (M1 amendment 6): a new version and the repoint are
// one transaction.

/** A version in the changelog: everything but its text. */
export type MissionSummary = Pick<
  MissionRow,
  "id" | "version" | "hash" | "note" | "created_at" | "created_by"
>;

export interface MissionHistory {
  /** The newest version in full; null before the first save. */
  readonly latest: MissionRow | null;
  /** Every version, newest first. */
  readonly versions: readonly MissionSummary[];
}

const agentExists = (ix: Internals, name: string): boolean =>
  first(ix, qb.selectFrom("agents").select("id").where("name", "=", name)) !==
  undefined;

const byVersion = (ix: Internals, agentName: string, version: number) =>
  first(
    ix,
    qb
      .selectFrom("missions")
      .selectAll()
      .where("agent_name", "=", agentName)
      .where("version", "=", version),
  );

/** The agent's changelog and newest version; not_found if no agent has this name. */
export async function getMissionHistory(
  db: Db,
  agentName: string,
): R<MissionHistory> {
  const found = await read(db, (ix): MissionHistory | undefined => {
    if (!agentExists(ix, agentName)) return undefined;
    const versions = all(
      ix,
      qb
        .selectFrom("missions")
        .select(["id", "version", "hash", "note", "created_at", "created_by"])
        .where("agent_name", "=", agentName)
        .orderBy("version", "desc"),
    );
    // Rows are immutable, so the newest listed version is still that row.
    const newest = versions[0];
    const latest =
      newest === undefined ? null : byVersion(ix, agentName, newest.version);
    return { latest: latest ?? null, versions };
  });
  return orNotFound(found, `agent ${agentName}`);
}

export async function getMissionVersion(
  db: Db,
  agentName: string,
  version: number,
): R<MissionRow> {
  const found = await read(db, (ix) => byVersion(ix, agentName, version));
  return orNotFound(found, `mission ${agentName} v${version}`);
}

export interface NewMissionVersion extends MissionText {
  readonly agent_name: string;
  /** The version the edit started from: 0 for the first. Anything but the latest is stale. */
  readonly base_version: number;
  /** The changelog line (§12.3); required. */
  readonly note: string;
  readonly created_by: string;
}

/**
 * Renders and hashes `m`, then in one write transaction inserts version `base_version + 1` and
 * points the agent at it. A stale base is `conflict` with `cause.current_version`; a blank note is
 * `validation`; an unknown agent is `not_found`. Any refusal writes nothing.
 */
export async function insertMissionVersion(
  db: Db,
  m: NewMissionVersion,
): R<MissionRow> {
  if (m.note.trim() === "")
    return err(failure("validation", "a mission version needs a note"));
  const rendered_md = renderMission(m.agent_name, m);
  const hash = await sha256Hex(rendered_md);
  return write(db, (ix) => {
    if (!agentExists(ix, m.agent_name))
      return err(failure("not_found", `agent ${m.agent_name} does not exist`));
    const current =
      first(
        ix,
        qb
          .selectFrom("missions")
          .select((eb) => eb.fn.max("version").as("version"))
          .where("agent_name", "=", m.agent_name),
      )?.version ?? 0;
    if (current !== m.base_version)
      return err(
        failure(
          "conflict",
          `base_version ${m.base_version} is stale: ${m.agent_name}'s mission is at version ${current}`,
          { current_version: current },
        ),
      );
    const now = ix.clock.now();
    const row = returningOne(
      ix,
      qb
        .insertInto("missions")
        .values({
          id: newId(now),
          agent_name: m.agent_name,
          version: current + 1,
          who_md: m.who_md,
          what_md: m.what_md,
          how_md: m.how_md,
          laws_md: m.laws_md,
          rendered_md,
          hash,
          note: m.note,
          created_at: now,
          created_by: m.created_by,
        })
        .returningAll(),
    );
    if (!row.ok) return row;
    execute(
      ix,
      qb
        .updateTable("agents")
        .set({ mission_id: row.value.id })
        .where("name", "=", m.agent_name),
    );
    return ok(row.value);
  });
}
