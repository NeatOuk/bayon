// `GET /projects`: a project is a workspace with its repos and agents, and the count of
// its tickets still open. One read, four queries, assembled per workspace.
import { TICKET_STATUSES, isTerminal } from "@bayon/core";
import type { Db, R } from "../connection.js";
import { all, qb, read } from "../connection.js";
import type { AgentRow, WorkspaceRow } from "../schema.js";
import type { WorkspaceRepo } from "./config.js";

export type ProjectAgent = Pick<
  AgentRow,
  "id" | "name" | "kind" | "runner_id" | "enabled" | "max_concurrency"
>;

export interface ProjectListing {
  readonly workspace: WorkspaceRow;
  /** Its repos by rel_path: the primary and, for a multi or submodule workspace, the rest. */
  readonly repos: readonly WorkspaceRepo[];
  readonly agents: readonly ProjectAgent[];
  /** Tickets not done or rejected. */
  readonly openTickets: number;
}

const TERMINAL = TICKET_STATUSES.filter(isTerminal);

/** Every workspace by name, as a project. */
export function listProjects(db: Db): R<ProjectListing[]> {
  return read(db, (ix) => {
    const workspaces = all(
      ix,
      qb.selectFrom("workspaces").selectAll().orderBy("name"),
    );
    const repos = all(
      ix,
      qb
        .selectFrom("workspace_repos as wr")
        .innerJoin("repos as r", "r.id", "wr.repo_id")
        .selectAll("r")
        .select([
          "wr.workspace_id",
          "wr.rel_path",
          "wr.role",
          "wr.submodule_path",
        ])
        .orderBy("wr.rel_path"),
    );
    const agents = all(
      ix,
      qb
        .selectFrom("agents")
        .select([
          "id",
          "name",
          "kind",
          "runner_id",
          "enabled",
          "max_concurrency",
          "workspace_id",
        ])
        .where("workspace_id", "is not", null)
        .orderBy("name"),
    );
    const open = all(
      ix,
      qb
        .selectFrom("tickets")
        .select("workspace_id")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("workspace_id", "is not", null)
        .where("status", "not in", TERMINAL)
        .groupBy("workspace_id"),
    );
    // ponytail: a filter per workspace, O(workspaces × rows); a handful of projects either way.
    return workspaces.map((workspace) => ({
      workspace,
      repos: repos.filter((r) => r.workspace_id === workspace.id),
      agents: agents.filter((a) => a.workspace_id === workspace.id),
      openTickets: open.find((o) => o.workspace_id === workspace.id)?.n ?? 0,
    }));
  });
}
