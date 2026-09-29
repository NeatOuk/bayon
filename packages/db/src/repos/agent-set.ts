// `frm agent set`: the operator's door to an agent already there (its profile, whether
// it is enabled, its max_concurrency) so a broken one can be repaired or retired. Through
// @bayon/db/operator, Invariant 5's one exception. Never mission_id: the API sets it (POST /missions,
// M1 amendment 6). One transaction: the checks, the row and its audit row (the operator's, via frm)
// commit together; values it already has write nothing.
//
// `PATCH /agents/:id` is the same write through @bayon/db/api, narrower: enabled and
// max_concurrency only, audited `via: "rest"`. Its own exported name, because an entry point may
// never export another's writer.
import { err, ok, type Result } from "@bayon/core";
import { z } from "zod";
import {
  execute,
  first,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import { insertAudit } from "./audit.js";
import {
  ORCHESTRATOR_KIND,
  oneEnabledOrchestrator,
} from "./orchestrator-rule.js";

/** What `frm agent set` may change, and nothing else. */
const AgentPatchSchema = z.strictObject({
  profile_id: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  /** 0, like `enabled: false`, is admission's `disabled`: its spawns refused, queued ones ended. */
  max_concurrency: z.int().min(0).optional(),
});
export type AgentPatch = z.infer<typeof AgentPatchSchema>;

/** What `PATCH /agents/:id` may change: never its profile, kind, runner, project or mission. */
const AgentApiPatchSchema = AgentPatchSchema.omit({ profile_id: true });
export type AgentApiPatch = z.infer<typeof AgentApiPatchSchema>;

/** Who is writing: the audit row's `via`, the schema it may use, and how its refusals read. */
interface Door {
  readonly via: "frm" | "rest";
  readonly schema: typeof AgentPatchSchema | typeof AgentApiPatchSchema;
  /** Why mission_id is not this door's to set. */
  readonly mission: string;
  readonly fields: readonly Field[];
}

/** The agent columns it writes, as stored: `enabled` is 0 or 1. */
export type AgentFields = {
  readonly profile_id: string | null;
  readonly enabled: number;
  readonly max_concurrency: number;
};
type Field = keyof AgentFields;
const FIELDS: readonly Field[] = ["profile_id", "enabled", "max_concurrency"];

const CLI: Door = {
  via: "frm",
  schema: AgentPatchSchema,
  mission: "agents.mission_id is set by the API (POST /missions), not by frm",
  fields: FIELDS,
};
const REST: Door = {
  via: "rest",
  schema: AgentApiPatchSchema,
  mission:
    "agents.mission_id is set by POST /missions, not by PATCH /agents/:id",
  fields: ["enabled", "max_concurrency"],
};

export interface AgentChange {
  readonly id: string;
  /** False when each field already had its value: nothing was written or audited. */
  readonly changed: boolean;
  /** The changed fields only, before and after. */
  readonly from: Partial<AgentFields>;
  readonly to: Partial<AgentFields>;
}

const invalid = (message: string): Result<never> =>
  err(failure("validation", message));

function checkPatch(door: Door, patch: unknown): Result<AgentPatch> {
  // Named before the schema would call it an unknown key: an agent's mission is POST /missions'.
  if (typeof patch === "object" && patch !== null && "mission_id" in patch) {
    return invalid(door.mission);
  }
  const parsed = door.schema.safeParse(patch);
  if (!parsed.success) {
    return invalid(`agent set: ${z.prettifyError(parsed.error)}`);
  }
  const data: AgentPatch = parsed.data;
  return door.fields.some((f) => data[f] !== undefined)
    ? ok(data)
    : invalid(`agent set: name at least one of ${door.fields.join(", ")}`);
}

/** The profile exists and runs the agent's runner, as resolve holds it at every spawn. */
function checkProfile(
  ix: Internals,
  agent: { readonly id: string; readonly runner_id: string },
  profileId: string,
): Result<void> {
  const profile = first(
    ix,
    qb.selectFrom("profiles").select("runner_id").where("id", "=", profileId),
  );
  if (profile === undefined) {
    return invalid(`profile ${profileId} does not exist`);
  }
  return profile.runner_id === agent.runner_id
    ? ok(undefined)
    : invalid(
        `profile ${profileId} is for runner ${profile.runner_id}, not agent ${agent.id}'s runner ${agent.runner_id}`,
      );
}

const pick = (
  src: AgentFields,
  fields: readonly Field[],
): Partial<AgentFields> => ({
  ...(fields.includes("profile_id") ? { profile_id: src.profile_id } : {}),
  ...(fields.includes("enabled") ? { enabled: src.enabled } : {}),
  ...(fields.includes("max_concurrency")
    ? { max_concurrency: src.max_concurrency }
    : {}),
});

function writeAgent(
  ix: Internals,
  id: string,
  patch: AgentPatch,
  via: Door["via"],
): Result<AgentChange> {
  const row = first(
    ix,
    qb
      .selectFrom("agents")
      .select([
        "id",
        "kind",
        "workspace_id",
        "runner_id",
        "profile_id",
        "enabled",
        "max_concurrency",
      ])
      .where("id", "=", id),
  );
  if (row === undefined) {
    return err(failure("not_found", `agent ${id} does not exist`));
  }
  if (patch.profile_id !== undefined) {
    const checked = checkProfile(ix, row, patch.profile_id);
    if (!checked.ok) return checked;
  }
  const next: AgentFields = {
    profile_id: patch.profile_id ?? row.profile_id,
    enabled: patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
    max_concurrency: patch.max_concurrency ?? row.max_concurrency,
  };
  const changed = FIELDS.filter((f) => next[f] !== row[f]);
  if (changed.length === 0) return ok({ id, changed: false, from: {}, to: {} });
  // A project's second enabled orchestrator: refused, as its add would be.
  if (
    row.enabled === 0 &&
    next.enabled === 1 &&
    row.kind === ORCHESTRATOR_KIND &&
    row.workspace_id !== null
  ) {
    const one = oneEnabledOrchestrator(
      ix,
      row.workspace_id,
      `enabling ${id}`,
      id,
    );
    if (!one.ok) return one;
  }
  const from = pick(row, changed);
  const to = pick(next, changed);
  execute(ix, qb.updateTable("agents").set(to).where("id", "=", id));
  const audit = insertAudit(ix, {
    actor: "operator",
    action: "agent.set",
    target_kind: "agent",
    target_id: id,
    payload: { via, from, to },
  });
  return audit.ok ? ok({ id, changed: true, from, to }) : audit;
}

/**
 * Sets an existing agent's profile, enabled and max_concurrency, audited as the operator's via frm.
 * Refused, writing nothing: an unknown agent (not_found); an unknown profile, one for another
 * runner, mission_id, an empty patch or a value out of range (validation); enabling an
 * orchestrator while its project has another enabled (conflict).
 */
export function setAgentFromCli(
  db: Db,
  id: string,
  patch: AgentPatch,
): R<AgentChange> {
  return setAgent(db, CLI, id, patch);
}

/**
 * Sets an existing agent's enabled and max_concurrency, audited as the operator's via rest
 * (`PATCH /agents/:id`). Removing an agent is `enabled: false`: nothing deletes one.
 * Refused, writing nothing: an unknown agent (not_found); profile_id, mission_id or any other
 * field, an empty patch or a value out of range (validation); enabling an orchestrator while its
 * project has another enabled (conflict). A patch of values it already has writes nothing.
 */
export function setAgentFromApi(
  db: Db,
  id: string,
  patch: AgentApiPatch,
): R<AgentChange> {
  return setAgent(db, REST, id, patch);
}

function setAgent(
  db: Db,
  door: Door,
  id: string,
  patch: unknown,
): R<AgentChange> {
  if (id.trim() === "")
    return Promise.resolve(invalid("agent set: name the agent"));
  const checked = checkPatch(door, patch);
  if (!checked.ok) return Promise.resolve(checked);
  return write(db, (ix) => writeAgent(ix, id, checked.value, door.via));
}
