import {
  ADDABLE_AGENT_KINDS,
  err,
  ok,
  projectAgentPlan,
  type AddAgentPlan,
  type Result,
} from "@bayon/core";
import type { Insertable } from "kysely";
import { z } from "zod";
import {
  all,
  execute,
  first,
  qb,
  returningOne,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { AgentRow, ProfilesTable } from "../schema.js";
import { insertAudit } from "./audit.js";
import {
  ORCHESTRATOR_KIND,
  oneEnabledOrchestrator,
} from "./orchestrator-rule.js";

// `createProjectAgent` (§9.5 amendment): `POST /projects/:id/agents`'s one writer,
// exported from `@bayon/db/api` only, beside `createProject`. One agent — a builder, a reviewer or
// an orchestrator, and its profile when the project has none for that kind on that
// runner — insert-only, in one transaction with its `agent.create` audit row. Never
// `agents.mission_id` (POST /missions sets it) nor the `pulse_*` columns (an orchestrator starts on
// the table's default policy, as `createProject`'s does), never any other table. The names are
// `projectAgentPlan`'s (core), planned from facts read inside the transaction; a project has at
// most one enabled orchestrator (`oneEnabledOrchestrator`), checked in the same transaction.

/** The scalar half of the request, checked before the transaction opens. */
const Asked = z.strictObject({
  workspace: z.string().min(1),
  kind: z.enum(ADDABLE_AGENT_KINDS),
  runner: z.string().min(1),
  /** Absent: the column's default. 0, like `enabled: false`, is admission's `disabled`. */
  maxConcurrency: z.int().min(0).optional(),
});

export interface NewProjectAgent {
  /** The project: `workspaces.id`. */
  readonly workspace: string;
  /** builder, reviewer or orchestrator; anything else is refused. */
  readonly kind: string;
  readonly runner: string;
  readonly maxConcurrency?: number;
  /**
   * `projectAgentProfile`'s row, filled by `withProfileDefaults` (@bayon/proto, an async hash, so
   * the door fills it before the transaction). Written only when no profile has its id yet; its id
   * and runner must be the plan's.
   */
  readonly profile: Insertable<ProfilesTable>;
}

export interface CreatedAgent {
  readonly agent: AgentRow;
  /** False: the project's profile for this kind on this runner was already there, and reused. */
  readonly profileCreated: boolean;
}

const invalid = (message: string): Result<never> =>
  err(failure("validation", message));

/** The project exists (`not_found`: it is the resource the path names, 404 like every other
 * path id) and the runner is registered and enabled (`validation`: a body field, 400). */
function checkTargets(
  ix: Internals,
  workspace: string,
  runner: string,
): Result<void> {
  const ws = first(
    ix,
    qb.selectFrom("workspaces").select("id").where("id", "=", workspace),
  );
  if (ws === undefined)
    return err(failure("not_found", `project ${workspace} does not exist`));
  const row = first(
    ix,
    qb.selectFrom("runners").select("enabled").where("id", "=", runner),
  );
  if (row === undefined) return invalid(`runner ${runner} is not registered`);
  return row.enabled === 1
    ? ok(undefined)
    : invalid(`runner ${runner} is disabled`);
}

/** Every agent id and name, and the project's oldest agent's executor: `projectAgentPlan`'s facts. */
function planFor(ix: Internals, asked: z.infer<typeof Asked>): AddAgentPlan {
  const names = all(ix, qb.selectFrom("agents").select(["id", "name"]));
  const oldest = first(
    ix,
    qb
      .selectFrom("agents")
      .select("executor_id")
      .where("workspace_id", "=", asked.workspace)
      .where("executor_id", "is not", null)
      .orderBy("created_at")
      .orderBy("id")
      .limit(1),
  );
  return projectAgentPlan(asked, {
    taken: new Set(names.flatMap((a) => [a.id, a.name])),
    executor: oldest?.executor_id ?? null,
  });
}

/** Whether the planned profile must be inserted (true) or is already there on this runner (false). */
function profileToWrite(
  ix: Internals,
  plan: AddAgentPlan,
  given: Insertable<ProfilesTable>,
): Result<boolean> {
  if (
    given.id !== plan.profile.id ||
    given.runner_id !== plan.profile.runner_id
  ) {
    return invalid(
      `profile ${given.id} on runner ${given.runner_id} is not the plan's ${plan.profile.id} on ${plan.profile.runner_id}`,
    );
  }
  const existing = first(
    ix,
    qb.selectFrom("profiles").select("runner_id").where("id", "=", given.id),
  );
  if (existing === undefined) return ok(true);
  return existing.runner_id === plan.profile.runner_id
    ? ok(false)
    : err(
        failure(
          "conflict",
          `profile ${given.id} already exists for runner ${existing.runner_id}`,
        ),
      );
}

function insertAgent(
  ix: Internals,
  asked: z.infer<typeof Asked>,
  p: NewProjectAgent,
): Result<CreatedAgent> {
  const checked = checkTargets(ix, asked.workspace, asked.runner);
  if (!checked.ok) return checked;
  if (asked.kind === ORCHESTRATOR_KIND) {
    const one = oneEnabledOrchestrator(ix, asked.workspace, "adding another");
    if (!one.ok) return one;
  }
  const plan = planFor(ix, asked);
  const profileCreated = profileToWrite(ix, plan, p.profile);
  if (!profileCreated.ok) return profileCreated;
  if (profileCreated.value) {
    execute(ix, qb.insertInto("profiles").values(p.profile));
  }
  const agent = returningOne(
    ix,
    qb
      .insertInto("agents")
      .values({
        ...plan.agent,
        ...(asked.maxConcurrency === undefined
          ? {}
          : { max_concurrency: asked.maxConcurrency }),
        created_at: ix.clock.now(),
      })
      .returningAll(),
  );
  if (!agent.ok) return agent;
  const audit = insertAudit(ix, {
    actor: "operator",
    action: "agent.create",
    target_kind: "agent",
    target_id: agent.value.id,
    payload: {
      via: "rest",
      workspace: asked.workspace,
      kind: asked.kind,
      runner: asked.runner,
      profile: plan.profile.id,
    },
  });
  return audit.ok
    ? ok({ agent: agent.value, profileCreated: profileCreated.value })
    : audit;
}

/**
 * Adds one builder, reviewer or orchestrator to project `p.workspace` on `p.runner`, with its
 * `agent.create` audit row, in one transaction. Refused, writing nothing: an unknown project
 * (`not_found`); any other kind, an unregistered or disabled runner, a bad max_concurrency, a
 * profile that is not the plan's (each `validation` — a body field that names nothing, not a
 * missing resource); an orchestrator while the project has an enabled one, or the plan's profile
 * id already taken on another runner (`conflict`).
 */
export function createProjectAgent(
  db: Db,
  p: NewProjectAgent,
): R<CreatedAgent> {
  const parsed = Asked.safeParse({
    workspace: p.workspace,
    kind: p.kind,
    runner: p.runner,
    ...(p.maxConcurrency === undefined
      ? {}
      : { maxConcurrency: p.maxConcurrency }),
  });
  if (!parsed.success) {
    return Promise.resolve(
      invalid(`agent create: ${z.prettifyError(parsed.error)}`),
    );
  }
  return write(db, (ix) => insertAgent(ix, parsed.data, p));
}
