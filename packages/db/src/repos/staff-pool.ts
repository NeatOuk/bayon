import { pickAgent, type StaffRole, type StaffScope } from "@bayon/core";
import { all, first, qb, type Internals } from "../connection.js";
import { agentPool } from "./agent-scope.js";
import type { Candidate } from "./staffing-scope.js";

// Who staffing may put on a ticket: the ticket's agent pool, the role's
// binding and the scope pickAgent reads them in. One helper, so the ticket page's "Start work" and
// staffing's own pick never disagree on whether a builder could take the ticket.

/** A role binding as staffing reads it: its runners, and where its sessions are placed. */
export interface PoolBinding {
  readonly runner_id: string;
  readonly fallback_runner_id: string | null;
  readonly executor_id: string | null;
}

/** The slots each agent holds: its live sessions and its queued spawns. */
export interface Occupancy {
  readonly live: readonly { readonly agent_id: string }[];
  readonly queued: readonly { readonly agent_id: string | null }[];
}

export interface StaffPool {
  readonly agents: readonly Candidate[];
  readonly binding: PoolBinding | undefined;
  readonly scope: StaffScope;
  /** The pool is the project's own agents (agentPool's `own`). */
  readonly own: boolean;
}

const NO_OCCUPANCY: Occupancy = { live: [], queued: [] };

/** The agents of `role` a ticket in `workspaceId` may be staffed onto, each with its slots held. */
export function staffPool(
  ix: Internals,
  role: StaffRole,
  workspaceId: string | null,
  occupancy: Occupancy = NO_OCCUPANCY,
): StaffPool {
  const binding = first(
    ix,
    qb
      .selectFrom("role_bindings")
      .select(["runner_id", "fallback_runner_id", "executor_id"])
      .where("role", "=", role),
  );
  const pool = agentPool(ix, role, workspaceId);
  const rows = all(
    ix,
    qb
      .selectFrom("agents")
      .select([
        "id",
        "kind",
        "runner_id",
        "workspace_id",
        "enabled",
        "max_concurrency",
        "created_at",
      ])
      .where(pool.where),
  );
  const agents = rows.map((a) => ({
    ...a,
    enabled: a.enabled === 1,
    busy:
      occupancy.live.filter((s) => s.agent_id === a.id).length +
      occupancy.queued.filter((s) => s.agent_id === a.id).length,
  }));
  return {
    agents,
    binding,
    scope: pool.own ? "project" : "fleet",
    own: pool.own,
  };
}

/**
 * Whether some agent of `role` could take a ticket in `workspaceId` once it has a free slot: the
 * pick staffing makes, with every slot free — enabled, with slots at all, and in the fleet's scope
 * on the binding's runner or its fallback.
 */
export function couldStaff(
  ix: Internals,
  role: StaffRole,
  workspaceId: string | null,
): boolean {
  const { agents, binding, scope } = staffPool(ix, role, workspaceId);
  return pickAgent(role, binding ?? null, agents, scope) !== null;
}

/**
 * Whether the pool of `kind` for a project in `workspaceId` holds an enabled agent with slots: the
 * project's own, or the fleet's while it has none of the kind (agentPool). No binding narrows it.
 */
export function poolHasEnabled(
  ix: Internals,
  kind: StaffRole,
  workspaceId: string | null,
): boolean {
  const pool = agentPool(ix, kind, workspaceId);
  return (
    first(
      ix,
      qb
        .selectFrom("agents")
        .select("id")
        .where(pool.where)
        .where("enabled", "=", 1)
        .where("max_concurrency", ">", 0),
    ) !== undefined
  );
}
