import { ok, projectAgentProfile, type Result } from "@bayon/core";
import { getAgent, type AgentRow, type Db } from "@bayon/db";
import {
  createProjectAgent,
  setAgentFromApi,
  type NewProjectAgent,
} from "@bayon/db/api";
import {
  withProfileDefaults,
  type AgentView,
  type CreateProjectAgentRequest,
  type PatchAgentRequest,
  type Row,
} from "@bayon/proto";

// `POST /projects/:id/agents` and `PATCH /agents/:id`: the route's half of the glue.
// Every check that reads the database — the project, the runner, whether it is enabled, the names
// already taken — is the writer's, inside its one transaction; this fills the planned profile's
// defaults (an async hash, which a transaction cannot wait on) and maps the row to the wire.

export function toAgentView(row: AgentRow): AgentView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    runner_id: row.runner_id,
    profile_id: row.profile_id,
    workspace_id: row.workspace_id,
    executor_id: row.executor_id,
    max_concurrency: row.max_concurrency,
    enabled: row.enabled === 1,
  };
}

/** One more builder, reviewer or orchestrator for project `workspaceId`: 201's body, or the
 * writer's refusal (an orchestrator's profile is `<ws>-orchestrate-<runner>`, core's plan). */
export async function addProjectAgent(
  db: Db,
  now: number,
  workspaceId: string,
  body: CreateProjectAgentRequest,
): Promise<Result<AgentView>> {
  const planned = projectAgentProfile({
    workspace: workspaceId,
    kind: body.kind,
    runner: body.runner_id,
  });
  const profile = await withProfileDefaults(planned as unknown as Row, now);
  const created = await createProjectAgent(db, {
    workspace: workspaceId,
    kind: body.kind,
    runner: body.runner_id,
    ...(body.max_concurrency === undefined
      ? {}
      : { maxConcurrency: body.max_concurrency }),
    profile: profile as unknown as NewProjectAgent["profile"],
  });
  return created.ok ? ok(toAgentView(created.value.agent)) : created;
}

/** Enables, disables or resizes agent `id`; the agent as it now is. */
export async function patchAgent(
  db: Db,
  id: string,
  body: PatchAgentRequest,
): Promise<Result<AgentView>> {
  const set = await setAgentFromApi(db, id, body);
  if (!set.ok) return set;
  const row = await getAgent(db, id);
  return row.ok ? ok(toAgentView(row.value)) : row;
}
