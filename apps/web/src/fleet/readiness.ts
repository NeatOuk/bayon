import { MODEL_STEPS, type ModelStep } from "@bayon/core";
import type { ProjectView, RoleBindingView, RunnerView } from "@bayon/proto";
import { STEP_LABELS, stepModel, type StepModel } from "@/ide/step-models";
import { CERTIFICATION_EXECUTOR } from "@/ide/runner-certification";
import { NEW_PROJECT_HREF, RUNNERS_HREF, projectHref } from "@/routing";

// What stops the install doing work, for the Fleet's "Needs you": a fresh install said
// "Nothing needs you" while no runner was certified and no project could start a ticket. Read from
// the queries the GUI already makes (GET /projects, /runners, /role-bindings, /settings):
// - no project;
// - a project no builder can take work for, or no reviewer can review for (`has_builder`,
//   `has_reviewer`: the server's own agent-pool rule, so a project borrowing a fleet agent is ready);
// - a model in use (GET /runners `bound_roles`: a role binding, a project's step tier, or an
//   enabled agent's own model, the orchestrator's and a plan reviewer's included) with no live
//   certificate on the certification executor — only while `admission.require_certified` is on,
//   since off lets an uncertified model run;
// - a step of a project's own agents that resolves to no model, or a reviewer's model that cannot
//   review (stepModel, the one Project settings → Models shows);
// - an enabled orchestrator with no mission.
// Each names one action. A runner's credential is covered by its certification: a runner cannot
// certify without it.

export interface NotReady {
  /** Stable across renders: the row's key. */
  readonly id: string;
  readonly text: string;
  readonly action: { readonly label: string; readonly href: string };
}

export interface ReadinessOptions {
  /** `admission.require_certified`: off, an uncertified model runs, so it is not a blocker. */
  readonly requireCertified: boolean;
}

const NO_PROJECT: NotReady = {
  id: "no-project",
  text: "No project yet: there is nothing to work on",
  action: { label: "Create a project", href: NEW_PROJECT_HREF },
};

/** A row names at most this many uses of a model, then how many more. */
const USES_SHOWN = 3;

/** Labels as a phrase: "Plan", "Plan and Build", "Plan, Build and Review". */
const listOf = (labels: readonly string[]): string => {
  const last = labels.at(-1) ?? "";
  return labels.length <= 1
    ? last
    : `${labels.slice(0, -1).join(", ")} and ${last}`;
};

interface Issue {
  /** Uses sharing a key share a row. */
  readonly key: string;
  readonly text: (uses: string) => string;
  readonly action: NotReady["action"];
}

type ModelFacts = Pick<
  StepModel,
  "runnerId" | "modelId" | "model" | "certification" | "gateEligible"
>;

/** Why a model would not run a use in `project`; null when it runs. */
function modelIssue(project: ProjectView, m: ModelFacts): Issue | null {
  const runner = m.runnerId ?? "";
  const open = { label: `Open ${runner}`, href: RUNNERS_HREF };
  if (m.modelId === null) {
    return {
      key: `model:${runner}`,
      text: (uses) =>
        `${project.name}: ${runner} has no active model for ${uses}`,
      action: open,
    };
  }
  // Certification is the install's row (certificationRows), once per model, whoever runs it; a
  // model that has none cannot tell whether it may review either.
  if (m.gateEligible === false && m.certification === "certified") {
    return {
      key: `gate:${runner}`,
      text: () =>
        `${project.name}: ${runner} can't review on ${CERTIFICATION_EXECUTOR}`,
      action: open,
    };
  }
  return null;
}

/** Each model a project's own enabled agents run, grouped by what stops it. */
function modelRows(
  project: ProjectView,
  runners: readonly RunnerView[],
  bindings: readonly RoleBindingView[],
): NotReady[] {
  const enabled = project.agents.filter((a) => a.enabled);
  const owns = (kind: string) => enabled.some((a) => a.kind === kind);
  // A borrowed fleet agent's model is not in the project's view: its own runner page shows it.
  const steps = MODEL_STEPS.filter((s: ModelStep) =>
    owns(s === "review" ? "reviewer" : "builder"),
  );
  const uses = [
    ...steps.map((step) => ({
      label: STEP_LABELS[step],
      issue: modelIssue(
        project,
        stepModel(step, project.step_tiers[step], project, runners, bindings),
      ),
    })),
  ];
  const grouped = new Map<string, { issue: Issue; labels: string[] }>();
  for (const { label, issue } of uses) {
    if (issue === null) continue;
    const seen = grouped.get(issue.key);
    grouped.set(issue.key, {
      issue,
      labels: [...(seen?.labels ?? []), label],
    });
  }
  return [...grouped.values()].map(({ issue, labels }) => ({
    id: `${project.id}:${issue.key}`,
    text: issue.text(listOf(labels)),
    action: issue.action,
  }));
}

/** Whether `modelId` holds a live certificate (compression off) on CERTIFICATION_EXECUTOR. */
const certified = (runner: RunnerView, modelId: string): boolean =>
  runner.certifications.some(
    (c) =>
      c.executor_id === CERTIFICATION_EXECUTOR &&
      c.model_id === modelId &&
      !c.compression &&
      c.passed_at !== null &&
      c.decertified_at === null,
  );

/** "a · plan step, a · a-builder agent and 2 more". */
function usesOf(uses: readonly string[]): string {
  const shown = uses.slice(0, USES_SHOWN);
  const more = uses.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : listOf(shown);
}

/** Every model in use with no live certificate there: one row each, naming who runs it. */
function certificationRows(runners: readonly RunnerView[]): NotReady[] {
  return runners.flatMap((runner) =>
    runner.models
      .filter((m) => m.bound_roles.length > 0 && !certified(runner, m.id))
      .map((m) => ({
        id: `cert:${runner.id}:${m.id}`,
        text: `${runner.id} (${m.model}) is not certified on ${CERTIFICATION_EXECUTOR}, and ${usesOf(m.bound_roles)} run${m.bound_roles.length === 1 ? "s" : ""} it`,
        action: { label: `Certify ${runner.id}`, href: RUNNERS_HREF },
      })),
  );
}

/** One project's rows: its builder and reviewer, its models, its orchestrator's mission. */
function projectIssues(
  project: ProjectView,
  runners: readonly RunnerView[],
  bindings: readonly RoleBindingView[],
): NotReady[] {
  const agents = projectHref(project.id, "agents");
  const missing = (kind: "builder" | "reviewer", text: string): NotReady => ({
    id: `${project.id}:no-${kind}`,
    text: `${project.name} ${text}`,
    action: { label: `Add a ${kind}`, href: agents },
  });
  const pools = [
    ...(project.has_builder
      ? []
      : [missing("builder", "has no builder that can take work")]),
    ...(project.has_reviewer
      ? []
      : [missing("reviewer", "has no reviewer: no review can run")]),
  ];
  const models = modelRows(project, runners, bindings);
  const missions = project.agents
    .filter((a) => a.enabled && a.kind === "orchestrator" && !a.has_mission)
    .map((a) => ({
      id: `${project.id}:mission:${a.id}`,
      text: `${a.name} has no mission: it has nothing to steer ${project.name} by`,
      action: {
        label: "Write its mission",
        href: projectHref(project.id, "orchestrator"),
      },
    }));
  return [...pools, ...models, ...missions];
}

/** Every not-ready row of the install, project by project; none when all can work. */
export function readiness(
  projects: readonly ProjectView[],
  runners: readonly RunnerView[],
  bindings: readonly RoleBindingView[],
  options: ReadinessOptions = { requireCertified: true },
): NotReady[] {
  const certs = options.requireCertified ? certificationRows(runners) : [];
  if (projects.length === 0) return [NO_PROJECT, ...certs];
  return [
    ...certs,
    ...projects.flatMap((p) => projectIssues(p, runners, bindings)),
  ];
}
