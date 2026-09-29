// Who reviews, and where. The builder's runner from the
// ticket's owner or newest worktree; the role's binding; candidates certified on the binding's
// executor for the very model each would run (runner_certifications per model, never the per-runner
// roll-up; an earlier change: the binding's tier, else — an earlier change — the project's review tier, else the
// profile's), on the certificate earned with context compression on when its session would run
// compressed (the same decision its spawn makes, sessionCompression), that have a
// reviewer agent; core
// pickReviewer; then that agent and, when it fits the runner, the binding's profile. A pick that
// finds nobody says whom it considered and why each could not review. The agents are
// the ticket's project's, as staffing's are: a project with reviewers of its own is
// reviewed by them, on their runners, the binding's first; never by another project's.
import {
  ok,
  pickReviewer,
  type BindingRole,
  type ModelStep,
  type Result,
  type ReviewerExclusion,
  type ReviewerRunner,
  type ReviewerSearch,
} from "@bayon/core";
import {
  bindingModelOn,
  getAgent,
  getProfile,
  getRoleBinding,
  getSession,
  listReviewerAgents,
  listRunnerEligibility,
  listRunners,
  listTicketWorktrees,
  projectReviewerRunners,
  type Db,
  type GateRow,
  type SessionRow,
  type TicketRow,
} from "@bayon/db";
import type { RunnerAdapter } from "@bayon/runners";
import { sessionCompression } from "../lifecycle/compression.js";

export interface ReviewerChoice {
  readonly runnerId: string;
  readonly fallbackFrom: string | null;
  readonly singleRunnerReview: boolean;
  /** The runner's `outputSchema` cap: schema mode, else heuristic with the sentinel (C2). */
  readonly outputSchema: boolean;
  readonly agentId: string;
  /** The binding's profile when it is for this runner (Q3), else the agent's (null). */
  readonly profileId: string | null;
  readonly executorId: string;
  /**
   * The role binding whose tier decides the reviewer's model: the spawn resolves its
   * model through it, so it runs the model this pick checked certification on. Absent for a
   * script job (lint, parity, QA), whose runner is exempt.
   */
  readonly bindingRole?: BindingRole;
  /** That model's row: certified on (runner, executor, model). Absent for a script job's runner,
   * which certification never gates. */
  readonly modelId?: string;
}

/** Nobody can review: a line for the gate row and, when runners were looked at, each one's reasons. */
export interface NoReviewer {
  readonly found: null;
  readonly detail: string;
  readonly considered?: ReviewerSearch;
}

export type ReviewerPickResult =
  { readonly found: ReviewerChoice } | NoReviewer;

export interface PickInput {
  readonly db: Db;
  readonly adapters: ReadonlyMap<string, RunnerAdapter>;
  readonly gate: GateRow;
  readonly ticket: TicketRow;
  readonly requireDistinct: boolean;
  /** Where a reviewer runs when its binding names no executor. */
  readonly defaultExecutor: string;
  /**
   * The project the reviewer's session is placed in (the pin's workspace), whose review tier its
   * model follows; absent: the ticket's. The spawn reads the same project's.
   */
  readonly workspaceId?: string | null;
}

/**
 * The step a gate's reviewer is: every LLM gate's session runs run class `review` (run-gate's
 * REVIEW_RUN_CLASS), which core's RUN_CLASS_STEP makes the review step.
 */
export const REVIEWER_STEP: ModelStep = "review";

const outputSchemaOf = (i: PickInput, runnerId: string): boolean =>
  i.adapters.get(runnerId)?.caps().outputSchema === true;

/** How each exclusion reads in the gate's detail line. */
const WHY: Readonly<Record<ReviewerExclusion, string>> = {
  no_adapter: "no adapter loaded",
  not_enabled: "not enabled",
  not_certified: "not certified here",
  not_gate_eligible: "not gate-eligible",
  needs_output_schema: "code_review needs structured output",
  no_reviewer_agent: "no reviewer agent",
};

/** The session whose work is reviewed: the ticket's owner, else its newest worktree's. */
async function builderSession(
  db: Db,
  ticket: TicketRow,
): Promise<Result<SessionRow | null>> {
  if (ticket.owner_session_id !== null) {
    const owner = await getSession(db, ticket.owner_session_id);
    if (owner.ok) return owner;
  }
  const rows = await listTicketWorktrees(db, ticket.id);
  if (!rows.ok) return rows;
  const newest = rows.value.findLast((w) => w.session_id !== null);
  if (newest?.session_id == null) return ok(null);
  const s = await getSession(db, newest.session_id);
  return s.ok ? s : ok(null);
}

/**
 * Why `runnerId` cannot review this gate on the executor `row` was read for, its agents aside; []
 * when it can. code_review's runners also need outputSchema (Q1).
 */
function exclusions(
  i: PickInput,
  runnerId: string,
  row: ReviewerRunner | undefined,
): ReviewerExclusion[] {
  const loaded = i.adapters.has(runnerId);
  const certified = row?.conformance_passed_at != null;
  const checks: readonly (readonly [ReviewerExclusion, boolean])[] = [
    ["no_adapter", !loaded],
    ["not_enabled", row !== undefined && row.enabled !== 1],
    ["not_certified", !certified],
    ["not_gate_eligible", certified && row?.gate_eligible !== 1],
    [
      "needs_output_schema",
      loaded && i.gate.kind === "code_review" && !outputSchemaOf(i, runnerId),
    ],
  ];
  return checks.filter(([, hit]) => hit).map(([why]) => why);
}

interface Survey {
  /** The runners that can review, in the order they were named. */
  readonly usable: readonly ReviewerRunner[];
  /** Each usable runner's reviewer agent, when agents were asked for. */
  readonly agents: ReadonlyMap<string, string>;
  /** Each runner's model, where it resolves to one: the one its certification was checked on. */
  readonly models: ReadonlyMap<string, string>;
  /** Every runner looked at that cannot review, and why. */
  readonly excluded: ReviewerSearch["runners"];
}

/**
 * How a survey finds the model each runner's reviewer would run: the role binding
 * whose tier decides it, and the profile the spawn would use — the binding's when it is that
 * runner's, else the reviewer agent's own (`agentProfile` for a fixed agent, ce_review's builder).
 */
interface ModelRule {
  readonly bindingRole: BindingRole;
  readonly boundProfileId: string | null;
  /** The agent every runner's reviewer takes, when it is fixed (ce_review): its profile. */
  readonly agentProfileId?: string | null;
}

/** One runner looked at: its reviewer agent (when asked for) and the model it would run. */
interface Looked {
  readonly id: string;
  readonly agentId: string | undefined;
  readonly modelId: string | null;
  readonly model: string | null;
  /** Its reviewer's session would run with its context compressed. */
  readonly compression: boolean;
}

/** The runner ids a survey looks at: the named ones, else every registered runner. */
async function surveyed(
  i: PickInput,
  named: readonly (string | null)[] | null,
): Promise<Result<string[]>> {
  if (named !== null) {
    return ok([...new Set(named.filter((id): id is string => id !== null))]);
  }
  const runners = await listRunners(i.db);
  return runners.ok ? ok(runners.value.map((r) => r.id)) : runners;
}

async function lookAt(
  i: PickInput,
  id: string,
  executorId: string,
  needAgent: boolean,
  rule: ModelRule,
): Promise<Result<Looked>> {
  const agents = needAgent
    ? await listReviewerAgents(i.db, id, i.ticket.workspace_id)
    : ok([]);
  if (!agents.ok) return agents;
  const agent = agents.value[0];
  const bound = await boundProfile(i.db, rule.boundProfileId, id);
  const profileId = bound ?? rule.agentProfileId ?? agent?.profile_id ?? null;
  const workspaceId = i.workspaceId ?? i.ticket.workspace_id;
  const model = await bindingModelOn(i.db, rule.bindingRole, id, profileId, {
    workspaceId,
    step: REVIEWER_STEP,
  });
  if (!model.ok) return model;
  const adapter = i.adapters.get(id);
  // A reviewer works in a detached worktree at the pinned head, so it has one.
  const compression =
    adapter === undefined
      ? ok(false)
      : await sessionCompression({
          db: i.db,
          adapter,
          executorId,
          workspaceId,
          worktree: true,
          role: rule.bindingRole,
        });
  if (!compression.ok) return compression;
  return ok({
    id,
    agentId: agent?.id,
    modelId: model.value.model?.id ?? null,
    model: model.value.model?.model ?? null,
    compression: compression.value,
  });
}

/**
 * The named runners on `executorId` (every runner when `named` is null), each with why it cannot
 * review — certified or not for the model it would run there — a reviewer agent counted when
 * `needAgent`.
 */
async function survey(
  i: PickInput,
  executorId: string,
  named: readonly (string | null)[] | null,
  needAgent: boolean,
  rule: ModelRule,
): Promise<Result<Survey>> {
  const ids = await surveyed(i, named);
  if (!ids.ok) return ids;
  const looked: Looked[] = [];
  for (const id of ids.value) {
    const one = await lookAt(i, id, executorId, needAgent, rule);
    if (!one.ok) return one;
    looked.push(one.value);
  }
  const rows = await listRunnerEligibility(
    i.db,
    executorId,
    looked.flatMap((l) => (l.modelId === null ? [] : [l.modelId])),
    looked.flatMap((l) =>
      l.modelId !== null && l.compression ? [l.modelId] : [],
    ),
  );
  if (!rows.ok) return rows;
  const byId = new Map(rows.value.map((r) => [r.id, r]));
  const facts = looked.map((l) => {
    const row = byId.get(l.id);
    // With no agent there is no profile, so no model to have checked: its missing agent is the
    // reason, not a certification nobody could name.
    const unknowable =
      needAgent && l.agentId === undefined && l.modelId === null;
    const why = [
      ...exclusions(i, l.id, row).filter(
        (w) =>
          !unknowable || (w !== "not_certified" && w !== "not_gate_eligible"),
      ),
      ...(needAgent && l.agentId === undefined
        ? (["no_reviewer_agent"] as const)
        : []),
    ];
    return { ...l, row, why };
  });
  return ok({
    usable: facts.flatMap((f) =>
      f.why.length === 0 && f.row !== undefined ? [f.row] : [],
    ),
    agents: new Map(
      facts.flatMap((f) =>
        f.agentId === undefined ? [] : [[f.id, f.agentId] as const],
      ),
    ),
    models: new Map(
      facts.flatMap((f) =>
        f.modelId === null ? [] : [[f.id, f.modelId] as const],
      ),
    ),
    excluded: facts
      .filter((f) => f.why.length > 0)
      .map((f) => ({
        runner_id: f.id,
        ...(f.model === null ? {} : { model: f.model }),
        ...(f.compression ? { compression: true } : {}),
        why: f.why,
      })),
  });
}

/**
 * The model a certification exclusion was about, named where it is one, and whether the
 * certificate it lacks is the compression-on one.
 */
const modelNote = (r: ReviewerSearch["runners"][number]): string =>
  r.model != null &&
  r.why.some((w) => w === "not_certified" || w === "not_gate_eligible")
    ? ` (model ${r.model}${r.compression === true ? ", context compression" : ""})`
    : "";

/** The no_reviewer answer: what was looked at, as structure and as one line. */
function none(s: {
  readonly role: BindingRole;
  readonly executorId: string;
  /** How the runners were named: the binding, ce_review's builder, or every runner. */
  readonly how: string;
  readonly bound: boolean;
  readonly runners: ReviewerSearch["runners"];
}): NoReviewer {
  const each =
    s.runners.length === 0
      ? "no runner is registered"
      : s.runners
          .map(
            (r) =>
              `${r.runner_id}${modelNote(r)}: ${r.why.map((w) => WHY[w]).join(", ")}`,
          )
          .join("; ");
  return {
    found: null,
    detail: `${s.role} on ${s.executorId} (${s.how}): ${each}`,
    considered: {
      role: s.role,
      executor_id: s.executorId,
      bound: s.bound,
      runners: [...s.runners],
    },
  };
}

async function boundProfile(
  db: Db,
  profileId: string | null,
  runnerId: string,
): Promise<string | null> {
  if (profileId === null) return null;
  const profile = await getProfile(db, profileId);
  return profile.ok && profile.value.runner_id === runnerId ? profileId : null;
}

/** ce_review: the builder's own runner and agent, in a deeper pass (§10.3); still certified. */
async function builderReviewer(
  i: PickInput,
  builder: SessionRow | null,
): Promise<Result<ReviewerPickResult>> {
  if (builder === null) {
    return ok({
      found: null,
      detail:
        "ce_review runs as the builder's runner and agent, and the ticket has no builder session (no owner, no worktree with a session)",
    });
  }
  const agent = await getAgent(i.db, builder.agent_id);
  if (!agent.ok) return agent;
  const looked = await survey(
    i,
    builder.executor_id,
    [builder.runner_id],
    false,
    {
      bindingRole: "builder",
      boundProfileId: null,
      agentProfileId: agent.value.profile_id,
    },
  );
  if (!looked.ok) return looked;
  const modelId = looked.value.models.get(builder.runner_id);
  const pick = pickReviewer({
    builderRunnerId: builder.runner_id,
    binding: { runner_id: builder.runner_id, fallback_runner_id: null },
    runners: looked.value.usable,
    requireDistinct: false,
  });
  if (pick === null || modelId === undefined) {
    return ok(
      none({
        role: "builder",
        executorId: builder.executor_id,
        how: "the builder's runner",
        bound: true,
        runners: looked.value.excluded,
      }),
    );
  }
  return ok({
    found: {
      runnerId: pick.runnerId,
      fallbackFrom: null,
      singleRunnerReview: false,
      outputSchema: outputSchemaOf(i, pick.runnerId),
      agentId: builder.agent_id,
      profileId: null,
      executorId: builder.executor_id,
      bindingRole: "builder",
      modelId,
    },
  });
}

interface BoundRunners {
  readonly runner_id: string;
  readonly fallback_runner_id: string | null;
}

const bindingText = (b: BoundRunners): string =>
  b.fallback_runner_id === null
    ? `bound to ${b.runner_id}`
    : `bound to ${b.runner_id}, fallback ${b.fallback_runner_id}`;

/** A project's reviewer runners, the binding's runner and fallback first when it has them. */
const bindingFirst = (
  runners: readonly string[],
  bound: BoundRunners | null,
): string[] => {
  const named =
    bound === null ? [] : [bound.runner_id, bound.fallback_runner_id];
  const first = named.filter(
    (r): r is string => r !== null && runners.includes(r),
  );
  return [...new Set([...first, ...runners])];
};

/**
 * The runners a gate surveys, in order: its ticket's project's reviewer runners when the project has
 * reviewers of its own (null order otherwise); else the binding's pair, or every runner (null).
 */
async function namedRunners(
  i: PickInput,
  bound: BoundRunners | null,
): Promise<
  Result<{
    readonly order: string[] | null;
    readonly named: readonly (string | null)[] | null;
  }>
> {
  const own = await projectReviewerRunners(i.db, i.ticket.workspace_id);
  if (!own.ok) return own;
  const order = own.value === null ? null : bindingFirst(own.value, bound);
  const pair =
    bound === null ? null : [bound.runner_id, bound.fallback_runner_id];
  return ok({ order, named: order ?? pair });
}

/** The reviewer for the gate, or why there is none: no candidate can review, or none has an agent. */
export async function chooseReviewer(
  i: PickInput,
): Promise<Result<ReviewerPickResult>> {
  const builder = await builderSession(i.db, i.ticket);
  if (!builder.ok) return builder;
  if (i.gate.kind === "ce_review") return builderReviewer(i, builder.value);
  const role =
    i.gate.kind === "plan_review" ? "plan_reviewer" : "code_reviewer";
  const binding = await getRoleBinding(i.db, role);
  if (!binding.ok) return binding;
  const bound = binding.value;
  const executorId = bound?.executor_id ?? i.defaultExecutor;
  const runners = await namedRunners(i, bound);
  if (!runners.ok) return runners;
  const { order, named } = runners.value;
  const looked = await survey(i, executorId, named, true, {
    bindingRole: role,
    boundProfileId: bound?.profile_id ?? null,
  });
  if (!looked.ok) return looked;
  const builderBinding = await getRoleBinding(i.db, "builder");
  if (!builderBinding.ok) return builderBinding;
  const pick = pickReviewer({
    builderRunnerId:
      builder.value?.runner_id ?? builderBinding.value?.runner_id ?? "",
    binding:
      bound === null
        ? null
        : {
            runner_id: bound.runner_id,
            fallback_runner_id: bound.fallback_runner_id,
          },
    runners: looked.value.usable,
    requireDistinct:
      i.requireDistinct || bound?.require_distinct_from === "builder",
    ...(order === null ? {} : { order }),
  });
  const agentId =
    pick === null ? undefined : looked.value.agents.get(pick.runnerId);
  const modelId =
    pick === null ? undefined : looked.value.models.get(pick.runnerId);
  if (pick === null || agentId === undefined || modelId === undefined) {
    return ok(
      none({
        role,
        executorId,
        how:
          order !== null
            ? `project ${i.ticket.workspace_id ?? ""}'s reviewer runners`
            : bound === null
              ? "unbound: every runner"
              : bindingText(bound),
        bound: bound !== null,
        runners: looked.value.excluded,
      }),
    );
  }
  return ok({
    found: {
      runnerId: pick.runnerId,
      fallbackFrom: pick.fallbackFrom,
      singleRunnerReview: pick.singleRunnerReview,
      outputSchema: outputSchemaOf(i, pick.runnerId),
      agentId,
      profileId: await boundProfile(
        i.db,
        bound?.profile_id ?? null,
        pick.runnerId,
      ),
      executorId,
      bindingRole: role,
      modelId,
    },
  });
}
