// One gate from claim to reviewer: pin, drift and source changes at
// pin, the pick, the spawn with its deadline and afterExit; every path that cannot review ends in
// decideGate, the supervisor's one gate writer (rule 2), whose retry row is started the same way.
import {
  REVIEW_OUTPUT_JSON_SCHEMA,
  SOURCE_CHANGE_PATHS_MAX,
  TEMPLATES,
  err,
  gateFailure,
  isCiGate,
  isRoundGateKind,
  newId,
  ok,
  sourceChangesOf,
  unlaunchedGateDeadline,
  type GateFailReason,
  type GateFailure,
  type PromptInputs,
  type PromptTemplate,
  type ReviewFinding,
  type ReviewerSearch,
  type SourceChanges,
} from "@bayon/core";
import {
  getGate,
  getSession,
  getTicket,
  type GateRow,
  type TicketRow,
} from "@bayon/db";
import { decideGate } from "@bayon/db/supervisor";
import type { AfterExitFacts } from "../lifecycle/after-exit.js";
import { readFleetHold } from "../fleet-hold.js";
import { frmError } from "../lifecycle/errors.js";
import { join } from "node:path";
import { gateArtifactsDir } from "../paths.js";
import { collect, type Collected } from "./collect.js";
import {
  background,
  execCtx,
  gitCtx,
  gitOn,
  kill,
  track,
  untrack,
  type GateCtx,
} from "./context.js";
import {
  PARITY_HEAD_ENV,
  PARITY_REPO_ENV,
  PARITY_ROLE,
  PARITY_RUN_CLASS,
} from "../jobs/parity-agent.js";
import {
  LINT_LOG_ENV,
  LINT_REPO_ENV,
  LINT_ROLE,
  LINT_RUN_CLASS,
} from "../jobs/lint-agent.js";
import {
  QA_ARTIFACTS_ENV,
  QA_ROLE,
  QA_RUN_CLASS,
  QA_TICKET_ENV,
  QA_WORKSPACE_ENV,
} from "../jobs/qa-agent.js";
import { chooseLintJob } from "./lint-pick.js";
import { chooseQaJob } from "./qa-pick.js";
import { chooseParityJob } from "./parity-pick.js";
import { chooseReviewer, type ReviewerChoice } from "./pick.js";
import { loadEngineSettings } from "./settings.js";
import { pinSubject, type Pin } from "./subject.js";

/** sessions.role and run class of every reviewer (McpRole `reviewer`; 002's `review` class). */
export const REVIEWER_ROLE = "reviewer";
export const REVIEW_RUN_CLASS = "review";

/** The lint job's log, under the gate's artifacts directory; its finding names the path. */
export const LINT_LOG = "lint.log";

/**
 * What a gate's session is, beyond its runner: a review, or a script job. `parity_check`
 * and `lint_check` are the gate kinds that are jobs — §9.8's `util` role,
 * their own run classes, and a template whose text no LLM ever reads (the `script` runner ignores
 * it; the run exists because a session spawned without a prompt opens no run, and a prompt is
 * compiled, never concatenated).
 */
interface GateJob {
  readonly role: string;
  readonly runClass: string;
  readonly template: PromptTemplate;
  readonly inputs: PromptInputs;
}

/** The gate kinds that run a script job rather than a reviewer (§10.3). */
const PARITY_KIND = "parity_check";
const LINT_KIND = "lint_check";
const QA_KIND = "qa_harness";

/**
 * A gate whose subject is not a diff: a plan document is not rebased, and neither is a whole
 * workspace, and a QA harness runs the branch as built rather than reading base..head ( * a drifted `qa_harness` had no way out of its status). Drift is judged only where base..head is
 * what was reviewed (H4).
 */
export const judgesDrift = (kind: string): boolean =>
  kind !== "plan_review" && kind !== PARITY_KIND && kind !== QA_KIND;

/**
 * Starts `gate` under `sessionId` unless it is already starting or tracked. A CI gate
 * starts nothing at all: it waits on the pull request's checks, which the CI sweep reads and decides.
 * The API's `pass_review` still inserts a `gate.run` for it, as for any gate; the claim ends here.
 */
export function launch(ctx: GateCtx, gate: GateRow, sessionId: string): void {
  if (ctx.state.stopped) return;
  if (isCiGate(gate)) {
    ctx.d.log.info(
      { gateId: gate.id },
      "a CI gate runs nothing: the CI sweep decides it from the pull request's checks",
    );
    return;
  }
  if (ctx.inFlight.has(gate.id) || ctx.byGate.has(gate.id)) return;
  ctx.inFlight.add(gate.id);
  background(
    ctx,
    `gate ${gate.id}`,
    runGate(ctx, gate, sessionId).finally(() => ctx.inFlight.delete(gate.id)),
  );
}

/**
 * decideGate, logged. A retry row is started under a fresh session id; a conflict (superseded or
 * waived meanwhile) stops the reviewer when `stopOnConflict`.
 */
export async function decide(
  ctx: GateCtx,
  gateId: string,
  sessionId: string | null,
  evidence: unknown,
  findings: readonly ReviewFinding[],
  stopOnConflict = false,
): Promise<void> {
  const d = await decideGate(ctx.d.db, {
    gate_id: gateId,
    session_id: sessionId,
    evidence,
    findings,
  });
  if (!d.ok) {
    if (d.error.class !== "conflict") {
      ctx.d.log.error(
        { gateId, error: d.error },
        "decideGate failed; the poll decides at the deadline",
      );
      return;
    }
    ctx.d.log.info(
      { gateId, cause: d.error.cause },
      "the gate stopped running first (superseded or waived)",
    );
    if (stopOnConflict && sessionId !== null) kill(ctx, sessionId);
    return;
  }
  ctx.d.log.info(
    { gateId, sessionId, state: d.value.gate.state },
    "gate decided",
  );
  // The machine step the decision settled, taken in its transaction (advanceTicket).
  const step = d.value.advance;
  if (step.advanced) {
    ctx.d.log.info(
      { gateId, ticketId: step.ticket.id, rule: step.rule, to: step.to },
      "the decision moved its ticket on",
    );
    // The round the step opened (`pass_review`'s QA gate), launched here as the retry
    // below is. It carries no `gate.run` command — the supervisor never inserts one (§9.5) — so
    // this is what starts it; the poll's `untracked` arm is the net if this engine is stopping.
    for (const gate of step.opened) {
      launch(ctx, gate, newId(ctx.d.clock.now()));
    }
  } else {
    ctx.d.log.info(
      { gateId, status: step.status, rule: step.rule, why: step.why },
      "the decision moved no ticket",
    );
  }
  if (d.value.retry !== null) {
    launch(ctx, d.value.retry, newId(ctx.d.clock.now()));
  }
}

interface FailExtra {
  readonly findings?: readonly ReviewFinding[];
  /** no_reviewer: the runners the pick looked at, and why each could not review. */
  readonly considered?: ReviewerSearch;
  /** base_drift: the pinned base and the tip. */
  readonly drift?: GateFailure["drift"];
}

/** A failure before any review: its reason and detail go into the gate row, not only the log. */
const fail = (
  ctx: GateCtx,
  gate: GateRow,
  reason: GateFailReason,
  detail: string,
  extra: FailExtra = {},
): Promise<void> => {
  ctx.d.log.warn(
    { gateId: gate.id, reason, detail },
    "the gate failed before a review",
  );
  const { findings = [], ...structured } = extra;
  return decide(
    ctx,
    gate.id,
    null,
    gateFailure({ reason, detail, ...structured }),
    findings,
  );
};

/** amendment (i): a plan_review that changed source files, as one blocker finding. */
function sourceFinding(sc: SourceChanges): ReviewFinding {
  const more = sc.total - sc.paths.length;
  return {
    severity: "blocker",
    summary: `plan_review changed ${sc.total} source file(s)`,
    file: sc.paths[0] ?? null,
    line: null,
    category: "source_changes",
    detail_md: [
      ...sc.paths.map((p) => `- ${p}`),
      ...(more > 0 ? [`- … and ${more} more`] : []),
    ].join("\n"),
  };
}

/**
 * no_source_changes for a plan_review across every repo the ticket has pinnable worktrees in
 *: each repo's changed files against the plan paths; another repo's
 * paths are shown as `<repo>:<path>`.
 */
export function sourceChangesAcross(
  pin: Pick<Pin, "files" | "others">,
  planPaths: Parameters<typeof sourceChangesOf>[1],
): SourceChanges {
  const parts = [
    { prefix: "", files: pin.files },
    ...pin.others.map((o) => ({ prefix: `${o.repoId}:`, files: o.files })),
  ];
  let total = 0;
  const paths: string[] = [];
  for (const part of parts) {
    const sc = sourceChangesOf(part.files, planPaths);
    total += sc.total;
    paths.push(...sc.paths.map((p) => `${part.prefix}${p}`));
  }
  return { total, paths: paths.slice(0, SOURCE_CHANGE_PATHS_MAX) };
}

async function runGate(
  ctx: GateCtx,
  gate: GateRow,
  sessionId: string,
): Promise<void> {
  // Held: nothing is decided and no reviewer spawns; the poll launches it after resume.
  const hold = await readFleetHold(ctx.d.db);
  if (!hold.ok || hold.value.paused) {
    ctx.d.log.info(
      { gateId: gate.id },
      "the fleet is held: the reviewer launches after the resume",
    );
    return;
  }
  const s = await loadEngineSettings(ctx.d.db);
  if (!s.ok) return fail(ctx, gate, "reviewer_error", s.error.message);
  const ticket = await getTicket(ctx.d.db, gate.ticket_id);
  if (!ticket.ok)
    return fail(ctx, gate, "reviewer_error", ticket.error.message);
  if (!isRoundGateKind(gate.kind)) {
    return fail(ctx, gate, "no_reviewer", `${gate.kind} has no reviewer in M3`);
  }
  const g = gitCtx(ctx);
  if (!g.ok) return fail(ctx, gate, "reviewer_error", g.error.message);
  const pin = await pinSubject({
    db: ctx.d.db,
    git: g.value,
    gitOn: (executorId) => gitOn(ctx, executorId),
    ticket: ticket.value,
    gateId: gate.id,
    kind: gate.kind,
    repoId: gate.repo_id,
    subjectKind: gate.subject_kind,
    artifactsDir: gateArtifactsDir(ctx.d.frmHome, gate.id),
    mirrors: ctx.mirrors,
    ...(ctx.d.secrets === undefined ? {} : { secrets: ctx.d.secrets }),
  });
  if (!pin.ok)
    return fail(
      ctx,
      gate,
      "reviewer_error",
      `unpinnable: ${pin.error.message}`,
    );
  // Drift at pin only (H4), and never where base..head is not the subject.
  const drift = judgesDrift(gate.kind) && pin.value.base !== pin.value.tip;
  if (drift && s.value.gate.base_drift === "fail") {
    return fail(
      ctx,
      gate,
      "base_drift",
      `the pinned base ${pin.value.base} is not the tip ${pin.value.tip}`,
      { drift: { base_sha: pin.value.base, tip_sha: pin.value.tip } },
    );
  }
  const sourceChanges =
    gate.kind === "plan_review"
      ? sourceChangesAcross(pin.value, s.value.planPaths)
      : undefined;
  if (sourceChanges !== undefined && sourceChanges.total > 0) {
    return fail(
      ctx,
      gate,
      "source_changes",
      `${sourceChanges.total} source file(s) outside the plan paths: ${sourceChanges.paths.join(", ")}`,
      { findings: [sourceFinding(sourceChanges)] },
    );
  }
  const choice =
    gate.kind === PARITY_KIND
      ? await chooseParityJob({ db: ctx.d.db, adapters: ctx.d.adapters })
      : gate.kind === LINT_KIND
        ? await chooseLintJob({
            db: ctx.d.db,
            adapters: ctx.d.adapters,
            // Where the subject was built: the pick refuses anything but `local`, because the
            // command it would run is the repo's own (see lint-pick.ts).
            subjectExecutorId: pin.value.executorId,
          })
        : gate.kind === QA_KIND
          ? await chooseQaJob({
              db: ctx.d.db,
              adapters: ctx.d.adapters,
              // The same limit, for the same reason: the command is the project's own.
              subjectExecutorId: pin.value.executorId,
            })
          : await chooseReviewer({
              db: ctx.d.db,
              adapters: ctx.d.adapters,
              gate,
              ticket: ticket.value,
              requireDistinct: s.value.requireDistinct,
              // Where the subject was built, not `local`: on a server deployment local's
              // trust refuses every work role, so defaulting there left every gate with no reviewer. A
              // binding that names an executor still wins.
              defaultExecutor: pin.value.executorId,
              // The project the reviewer is placed in, whose review tier it runs.
              workspaceId: pin.value.workspaceId,
            });
  if (!choice.ok)
    return fail(ctx, gate, "reviewer_error", choice.error.message);
  const picked = choice.value;
  if (picked.found === null) {
    return fail(
      ctx,
      gate,
      "no_reviewer",
      picked.detail,
      picked.considered === undefined ? {} : { considered: picked.considered },
    );
  }
  return spawnGate(ctx, {
    gate,
    ticket: ticket.value,
    pin: pin.value,
    choice: picked.found,
    job: jobOf(gate.kind, ticket.value, pin.value),
    sessionId,
    // A gate the pause held starts its wall clock at the resume (MEDIUM-4).
    deadline: unlaunchedGateDeadline({
      startedAt: gate.started_at ?? ctx.d.clock.now(),
      wallClockMs: s.value.gate.wall_clock_ms,
      resumedAt: hold.value.resumedAt,
    }),
    baseDrift: drift,
    ...(sourceChanges === undefined ? {} : { sourceChanges }),
  });
}

/** The one section a script job's prompt carries: which ticket the run was for (§8.1). */
const jobTicket = (ticket: TicketRow): PromptInputs => ({
  ticket: `#${String(ticket.num)} ${ticket.title}`,
});

/** What the gate's session runs: a review, or one of the two script jobs. */
const jobOf = (kind: string, ticket: TicketRow, pin: Pin): GateJob =>
  kind === PARITY_KIND
    ? {
        role: PARITY_ROLE,
        runClass: PARITY_RUN_CLASS,
        template: TEMPLATES.parity,
        inputs: jobTicket(ticket),
      }
    : kind === LINT_KIND
      ? {
          role: LINT_ROLE,
          runClass: LINT_RUN_CLASS,
          template: TEMPLATES.lint,
          inputs: jobTicket(ticket),
        }
      : kind === QA_KIND
        ? {
            role: QA_ROLE,
            runClass: QA_RUN_CLASS,
            template: TEMPLATES.qa,
            inputs: jobTicket(ticket),
          }
        : {
            role: REVIEWER_ROLE,
            runClass: REVIEW_RUN_CLASS,
            template: TEMPLATES.review,
            inputs: reviewInputs(ticket, pin),
          };

interface Launch {
  readonly gate: GateRow;
  readonly ticket: TicketRow;
  readonly pin: Pin;
  readonly choice: ReviewerChoice;
  readonly job: GateJob;
  readonly sessionId: string;
  readonly deadline: number;
  readonly baseDrift: boolean;
  readonly sourceChanges?: SourceChanges;
}

/** review v2's inputs: the ticket, the plan at head, and the pinned range with its stat. */
export function reviewInputs(ticket: TicketRow, pin: Pin): PromptInputs {
  const done = ticket.acceptance_md.trim();
  return {
    ticket: [
      `#${ticket.num} ${ticket.title}`,
      ticket.body_md.trim(),
      done === "" ? "" : `Done when:\n${done}`,
    ]
      .filter((part) => part !== "")
      .join("\n\n"),
    ...(pin.planText === null ? {} : { plan: pin.planText }),
    change: [
      `Repository: ${pin.repoId}`,
      `Range: ${pin.base}..${pin.head} (${pin.files.length} file(s))`,
      `Read the change with: git diff ${pin.base}..${pin.head}`,
      "",
      pin.stat,
    ].join("\n"),
  };
}

/**
 * The gate's session: a reviewer, or the parity job. One spawn path for both, so the gate tracking,
 * the still-running check at creation, the deadline and every failure path stay shared — the parts
 * a second, parallel path would silently drift away from.
 */
async function spawnGate(ctx: GateCtx, r: Launch): Promise<void> {
  const { gate, pin, choice, job, sessionId } = r;
  const parity = gate.kind === PARITY_KIND;
  const at = { at: { sha: pin.head, baseSha: pin.base, repoId: pin.repoId } };
  // The lint job's two names: the repo whose `lint_cmd` it runs, and where the whole of
  // that command's output goes. Both through InternalSpawn.env, which an earlier change made a validated,
  // hashed path — so two runs of the lint profile on different commits do not hash alike (§8.1).
  const lintEnv = {
    env: {
      [LINT_REPO_ENV]: pin.repoId,
      [LINT_LOG_ENV]: join(gateArtifactsDir(ctx.d.frmHome, gate.id), LINT_LOG),
    },
  };
  // The QA job's three names: the project whose harness runs, the ticket whose row the
  // placeholders come from, and the artifacts directory the log, the run file and the copied
  // reports go into. Through the same validated, hashed env path.
  const qaEnv = {
    env: {
      [QA_WORKSPACE_ENV]: pin.workspaceId,
      [QA_TICKET_ENV]: r.ticket.id,
      [QA_ARTIFACTS_ENV]: gateArtifactsDir(ctx.d.frmHome, gate.id),
    },
  };
  const spawned = await ctx.d.lifecycle.spawnInternal({
    payload: {
      session_id: sessionId,
      agent_id: choice.agentId,
      role: job.role,
      run_class: job.runClass,
      ticket_id: r.ticket.id,
      workspace_id: pin.workspaceId,
      runner_id: choice.runnerId,
      executor_id: choice.executorId,
    },
    // A reviewer reads the change, so it gets the subject checked out detached at the pinned head.
    // The parity job reads the database and this host's mirrors and nothing else
    // (jobs/parity-facts.ts), so a worktree buys it nothing — and costs it its answer (H2): a
    // submodule workspace whose gitlink no mirror holds fails planChild's ensureCommit, the
    // session dies `spawn_failed`, collect sees no run, and the gate ends `reviewer_error` instead
    // of writing the blocking finding rule 2 exists to produce. It is handed the pin in its env
    // instead (H1) — the only place the ticket's head exists, `worktrees.head_sha` having no
    // writer.
    //
    // The lint job takes the other branch and then some: it needs the files, so it gets the same
    // detached worktree at the pinned head a reviewer gets, plus its own two names.
    ...(parity
      ? {
          workspace: "none" as const,
          env: { [PARITY_REPO_ENV]: pin.repoId, [PARITY_HEAD_ENV]: pin.head },
        }
      : gate.kind === LINT_KIND
        ? { workspace: at, ...lintEnv }
        : gate.kind === QA_KIND
          ? { workspace: at, ...qaEnv }
          : { workspace: at }),
    gate: { id: gate.id, fallbackFrom: choice.fallbackFrom },
    ...(choice.profileId === null ? {} : { profileId: choice.profileId }),
    ...(choice.bindingRole === undefined
      ? {}
      : { bindingRole: choice.bindingRole }),
    deadline: r.deadline,
    run: {
      seq: 1,
      trigger: "gate",
      template: job.template,
      inputs: job.inputs,
      ...(choice.outputSchema
        ? { output: { schema: REVIEW_OUTPUT_JSON_SCHEMA } }
        : {}),
      // One run per session: its end stops the session, whose afterExit collects.
      onEnded: () => {
        background(
          ctx,
          `stop reviewer ${sessionId}`,
          ctx.d.lifecycle.stop(sessionId, "graceful"),
        );
      },
    },
    afterExit: (facts) => collectFor(ctx, sessionId, facts),
    onCreated: async (sid) => {
      const current = await getGate(ctx.d.db, gate.id);
      if (!current.ok || current.value.state !== "running") {
        return err(
          frmError(
            "conflict",
            `gate ${gate.id} stopped running before its reviewer`,
          ),
        );
      }
      track(ctx, {
        gateId: gate.id,
        kind: gate.kind,
        sessionId: sid,
        deadline: r.deadline,
        pin,
        choice,
        baseDrift: r.baseDrift,
        ...(r.sourceChanges === undefined
          ? {}
          : { sourceChanges: r.sourceChanges }),
      });
      return ok(undefined);
    },
  });
  if (spawned.ok) return;
  untrack(ctx, sessionId);
  const exists = (await getSession(ctx.d.db, sessionId)).ok;
  ctx.d.log.warn(
    { gateId: gate.id, sessionId, error: spawned.error },
    "the reviewer did not spawn",
  );
  const reason: GateFailReason =
    spawned.error.class === "timeout" ? "timeout" : "reviewer_error";
  return decide(
    ctx,
    gate.id,
    exists ? sessionId : null,
    gateFailure({
      reason,
      detail: `the reviewer did not spawn: ${spawned.error.message}`,
    }),
    [],
  );
}

/** afterExit: the evidence from the exit and the output together (H1), then the decision. */
async function collectFor(
  ctx: GateCtx,
  sessionId: string,
  facts: AfterExitFacts,
): Promise<void> {
  const t = ctx.tracked.get(sessionId);
  // After stop() the gate is the next boot's to decide (supervisor_restart), not this engine's.
  if (t === undefined || ctx.state.stopped) return;
  ctx.collected.add(sessionId);
  let out: Collected = { evidence: { reason: "reviewer_error" }, findings: [] };
  const g = gitCtx(ctx);
  try {
    if (g.ok) {
      out = await collect({
        db: ctx.d.db,
        frmHome: ctx.d.frmHome,
        exec: execCtx(ctx),
        git: g.value,
        gateId: t.gateId,
        kind: t.kind,
        sessionId,
        pin: t.pin,
        choice: t.choice,
        baseDrift: t.baseDrift,
        ...(t.sourceChanges === undefined
          ? {}
          : { sourceChanges: t.sourceChanges }),
        artifactsDir: gateArtifactsDir(ctx.d.frmHome, t.gateId),
        facts,
      });
    }
  } catch (e) {
    ctx.d.log.error(
      { gateId: t.gateId, sessionId, err: String(e) },
      "collecting the evidence failed",
    );
  }
  await decide(ctx, t.gateId, sessionId, out.evidence, out.findings);
}
