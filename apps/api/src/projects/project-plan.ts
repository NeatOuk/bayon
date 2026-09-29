import {
  NO_DELIVERY_CONFIG,
  deliverySinceAfter,
  err,
  ok,
  projectPlan,
  ciRequiredRefusal,
  projectSubmodulePlan,
  qaCiRefusal,
  resolveDocsSource,
  type FoundSubmodule,
  type ProjectIds,
  type ProjectPlanInput,
  type Result,
} from "@bayon/core";
import type { NewProject } from "@bayon/db/api";
import {
  withProfileDefaults,
  type CreateProjectRequest,
  type DeliveryConfig,
  type DocsSource,
  type JiraSource,
  type QaConfig,
  type Row,
  type StepTiersInput,
} from "@bayon/proto";
import { join } from "node:path";

// The route's half of the glue `frm project add`'s `toConfigRows` also does: fill
// `projectPlan`'s (core, pure) rows with the two I/O-adjacent bits it left out — `mirror_path`
// (needs a home root) and a profile's allowlist/hash/`created_at` (`withProfileDefaults`,
// `@bayon/proto`) — into exactly what `createProject` (`@bayon/db/api`) writes.

/** `CreateProjectRequest`'s wire shape into core's plan input. Absent `reviewer_runner_id`: the
 * reviewer runs on `runner_id`, as the CLI's own `--reviewer-runner` default does. */
export function toProjectPlanInput(
  body: CreateProjectRequest,
): ProjectPlanInput {
  return {
    name: body.name,
    repoUrl: body.repo_url,
    runner: body.runner_id,
    executor: body.executor_id,
    orchestrator: body.orchestrator,
    reviewerRunner:
      body.reviewer_runner_id === undefined
        ? body.runner_id
        : body.reviewer_runner_id,
    ...(body.base_branch === undefined ? {} : { base: body.base_branch }),
  };
}

/** The workspace columns of a Jira source, none without one. frm's `toConfigRows`
 * shares `projectPlan` but never sets a source, so these stay NULL there. */
const jiraColumns = (jira: JiraSource | undefined) =>
  jira === undefined
    ? {}
    : { jira_url: jira.url, jira_email: jira.email, jira_jql: jira.jql };

/** The workspace columns of a QA harness; a project without one comes up `none`. */
const qaColumns = (qa: QaConfig | undefined) =>
  qa === undefined
    ? {}
    : {
        qa_mode: qa.mode,
        qa_cmd: qa.mode === "none" ? null : (qa.cmd ?? "").trim() || null,
        qa_timeout_ms: qa.timeout_ms,
        qa_secrets_json: JSON.stringify(qa.secrets),
        qa_reports_json: JSON.stringify(qa.reports),
        qa_junit: qa.junit,
        qa_ci_checks_json: JSON.stringify(qa.ci_checks),
        qa_ci_timeout_ms: qa.ci_timeout_ms,
      };

/**
 * The workspace columns of a documentation source; a project without one comes up
 * `none`. A `confluence` source with no site or account of its own takes the Jira source of this
 * same create — "same as Jira", by **core's own rule**, the one `setProjectSettings` runs for a
 * PATCH. With neither, that rule refuses with a sentence the operator can act on; before this was
 * shared, the create path let the row through and handed the caller 037's CHECK constraint text.
 */
export function docsColumns(
  docs: DocsSource | undefined,
  jira: JiraSource | undefined,
): Result<Record<string, string | null>> {
  if (docs === undefined || docs.kind === "none") return ok({});
  const resolved = resolveDocsSource(
    docs,
    jira === undefined ? null : { url: jira.url, email: jira.email },
  );
  if (!resolved.ok) return resolved;
  const source = resolved.value;
  return ok({
    docs_kind: source.kind,
    docs_url: source.url,
    docs_email: source.email,
    docs_spaces_json: JSON.stringify(source.spaces),
  });
}

/**
 * The workspace columns of delivery; a project without any comes up `none`, and so
 * pushes nothing anywhere until an operator says otherwise (§14, spike §1.7). One created
 * delivering is marked as turned on at `now` (047): what it delivers is what reaches its
 * moment from then on, the rule a PATCH that turns delivery on keeps.
 */
const deliveryColumns = (delivery: DeliveryConfig | undefined, now: number) =>
  delivery === undefined
    ? {}
    : {
        delivery_mode: delivery.mode,
        delivery_when: delivery.when,
        close_on_merge: delivery.close_on_merge ? 1 : 0,
        delivery_since: deliverySinceAfter("none", null, delivery.mode, now),
      };

/** The workspace columns of the tier per step; a step absent inherits (NULL). */
const stepTierColumns = (steps: StepTiersInput | undefined) =>
  steps === undefined
    ? {}
    : {
        plan_tier: steps.plan ?? null,
        build_tier: steps.build ?? null,
        review_tier: steps.review ?? null,
      };

/** `projectPlan`'s rows, with `mirror_path` and each profile's defaults filled in: exactly what
 * `createProject` writes for `input`. With submodules the workspace is a `submodule`
 * one: the repo is its primary, and each submodule a dep repo with its own mirror. A Jira source
 * goes on the workspace. */
export async function toNewProject(
  input: ProjectPlanInput,
  ids: ProjectIds,
  mirrorsRoot: string,
  now: number,
  submodules: readonly FoundSubmodule[] = [],
  jira?: JiraSource,
  qa?: QaConfig,
  docs?: DocsSource,
  delivery?: DeliveryConfig,
  stepTiers?: StepTiersInput,
  /** Its sessions' context compressed; absent: off, the column's default. */
  contextCompression?: boolean,
): Promise<Result<NewProject>> {
  // Refused before a row is built: a documentation source with no site and nothing to take one
  // from is the operator's mistake, and it gets a sentence, not a constraint violation.
  const docsFields = docsColumns(docs, jira);
  if (!docsFields.ok) return docsFields;
  // CI checks as QA need a pull request opened as review passes: the sentence PATCH
  // gives, before a row is built, rather than 043's CHECK text.
  const ciRefused = qaCiRefusal(
    qa?.mode ?? "none",
    delivery ?? NO_DELIVERY_CONFIG,
  );
  const plan = projectPlan(input, ids);
  const deps = projectSubmodulePlan(
    ids,
    plan.workspaceRepo.rel_path,
    submodules,
  );
  // …and a required check's `<repo_id>:` prefix must name one of this project's repos.
  const refused =
    ciRefused ??
    ciRequiredRefusal(qa?.ci_checks ?? [], [
      plan.repo.id,
      ...deps.map((d) => d.repo.id),
    ]);
  if (refused !== null) {
    return err({ class: "validation", message: refused, retryable: false });
  }
  const whole = deps.length > 0;
  const profiles = await Promise.all(
    plan.profiles.map((p) => withProfileDefaults(p as unknown as Row, now)),
  );
  return ok({
    name: input.name,
    runner: input.runner,
    executor: input.executor,
    reviewerRunner: input.reviewerRunner,
    repo: {
      ...plan.repo,
      mirror_path: join(mirrorsRoot, `${plan.repo.id}.git`),
      ...(whole ? { has_submodules: 1 } : {}),
    },
    workspace: {
      ...plan.workspace,
      ...(whole ? { kind: "submodule" as const } : {}),
      ...jiraColumns(jira),
      ...qaColumns(qa),
      ...docsFields.value,
      ...deliveryColumns(delivery, now),
      ...stepTierColumns(stepTiers),
      ...(contextCompression === true ? { context_compression: 1 } : {}),
    },
    workspaceRepo: whole
      ? { ...plan.workspaceRepo, role: "primary" }
      : plan.workspaceRepo,
    submodules: deps.map((d) => ({
      repo: { ...d.repo, mirror_path: join(mirrorsRoot, `${d.repo.id}.git`) },
      workspaceRepo: d.workspaceRepo,
    })),
    profiles: profiles as unknown as NewProject["profiles"],
    agents: plan.agents.map((a) => ({ ...a, created_at: now })),
  });
}
