import {
  RESERVED_MIRROR_PREFIX,
  err,
  isReservedRepoId,
  ok,
  type JsonValue,
  type Result,
} from "@bayon/core";
import type { Insertable } from "kysely";
import { execute, qb, write, type Db, type R } from "../connection.js";
import { failure } from "../errors.js";
import { insertAudit } from "./audit.js";
import type {
  AgentsTable,
  ProfilesTable,
  ReposTable,
  WorkspaceReposTable,
  WorkspacesTable,
} from "../schema.js";

// `createProject` (§9.5 amendment): `POST /projects`'s one writer, exported from
// `@bayon/db/api` only. Exactly repos, workspaces, workspace_repos, profiles, agents for one
// project, insert-only, in one transaction with its `project.create` audit row — never
// `executors`/`run_classes`/`settings`/`agents.mission_id`, which `seedConfig` may touch and this
// must not. Not built on `seedConfig`: `ConfigRows` names tables this door may never write, and a
// narrower type here is more direct than trusting every caller to pass an empty object for the rest.

export interface NewProject {
  /** The project name: `repos.id` = `workspaces.id`, and the audit row's `target_id`. */
  readonly name: string;
  readonly runner: string;
  readonly executor: string;
  /** Null: no reviewer agent in `agents`. */
  readonly reviewerRunner: string | null;
  readonly repo: Insertable<ReposTable>;
  readonly workspace: Insertable<WorkspacesTable>;
  readonly workspaceRepo: Insertable<WorkspaceReposTable>;
  /** A `submodule` workspace's dep repos, each with its workspace_repos row; empty
   * for a single one. */
  readonly submodules: readonly {
    readonly repo: Insertable<ReposTable>;
    readonly workspaceRepo: Insertable<WorkspaceReposTable>;
  }[];
  readonly profiles: readonly Insertable<ProfilesTable>[];
  readonly agents: readonly Omit<Insertable<AgentsTable>, "mission_id">[];
}

/** `project.create`'s audit payload (the amendment's own shape). */
function auditPayload(p: NewProject): JsonValue {
  return {
    via: "rest",
    repo: p.repo.origin_url,
    // Where its delivered work goes (039), read from the folder's own origin: a checked URL with any
    // credential already taken out, never the secret itself (§14).
    ...(p.repo.push_url === undefined || p.repo.push_url === null
      ? {}
      : { push_url: p.repo.push_url }),
    runner: p.runner,
    executor: p.executor,
    reviewer_runner: p.reviewerRunner,
    agents: p.agents.map((a) => a.id),
    ...(p.submodules.length === 0
      ? {}
      : {
          submodules: p.submodules.map((s) => s.repo.origin_url ?? null),
          submodule_push_urls: p.submodules.map((s) => s.repo.push_url ?? null),
        }),
    // Its Jira source: no secret in it, the token stays in the host store (§14).
    ...(p.workspace.jira_url === undefined || p.workspace.jira_url === null
      ? {}
      : {
          jira: {
            url: p.workspace.jira_url,
            email: p.workspace.jira_email ?? null,
            jql: p.workspace.jira_jql ?? null,
          },
        }),
    // Its documentation source: no secret in it either, the reader uses the mirror's
    // own host-store token (§14).
    ...(p.workspace.docs_kind === undefined || p.workspace.docs_kind === "none"
      ? {}
      : {
          docs: {
            kind: p.workspace.docs_kind,
            url: p.workspace.docs_url ?? null,
            email: p.workspace.docs_email ?? null,
            spaces: p.workspace.docs_spaces_json ?? null,
          },
        }),
    ...stepTiersPayload(p.workspace),
    // Created with its sessions' context compressed (049): said only when on, as the default is off.
    ...(p.workspace.context_compression === 1
      ? { context_compression: true }
      : {}),
  };
}

/** Its tier per step (048), when it names any: what its spawns will run. */
function stepTiersPayload(w: Insertable<WorkspacesTable>): {
  readonly step_tiers?: Readonly<Record<string, string | null>>;
} {
  const steps = {
    plan: w.plan_tier ?? null,
    build: w.build_tier ?? null,
    review: w.review_tier ?? null,
  };
  return Object.values(steps).every((tier) => tier === null)
    ? {}
    : { step_tiers: steps };
}

/**
 * Writes one project's rows and its `project.create` audit row, in one transaction. A repeated
 * repo id is `conflict` (the table's own unique constraint); the reserved mirror prefix is
 * `validation`, checked first, as `seedConfig` checks it for the operator's door. Either way
 * nothing is written.
 */
export function createProject(db: Db, p: NewProject): R<void> {
  const reserved = [p.repo, ...p.submodules.map((s) => s.repo)].find((r) =>
    isReservedRepoId(r.id),
  );
  if (reserved !== undefined) {
    return Promise.resolve(
      err(
        failure(
          "validation",
          `repo id ${reserved.id}: the prefix ${RESERVED_MIRROR_PREFIX} is reserved for executor mirrors`,
        ),
      ),
    );
  }
  return write(db, (ix) => {
    execute(ix, qb.insertInto("repos").values(p.repo));
    for (const s of p.submodules)
      execute(ix, qb.insertInto("repos").values(s.repo));
    execute(ix, qb.insertInto("workspaces").values(p.workspace));
    execute(ix, qb.insertInto("workspace_repos").values(p.workspaceRepo));
    for (const s of p.submodules)
      execute(ix, qb.insertInto("workspace_repos").values(s.workspaceRepo));
    for (const row of p.profiles)
      execute(ix, qb.insertInto("profiles").values(row));
    for (const row of p.agents)
      execute(ix, qb.insertInto("agents").values(row));
    const audit = insertAudit(ix, {
      actor: "operator",
      action: "project.create",
      target_kind: "project",
      target_id: p.name,
      payload: auditPayload(p),
    });
    return audit.ok ? ok(undefined) : (audit as Result<void>);
  });
}
