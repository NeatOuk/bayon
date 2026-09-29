import { z } from "zod";
import { CI_SUBJECT } from "../gates/ci.js";
import { isReviewGateKind } from "../gates/roles.js";
import { GateFailure, type GateFailReason } from "../gates/schemas.js";
import {
  FAILURE_CLASS,
  driftCapped,
  driftStreak,
  failReason,
  machineStep,
  roundOf,
} from "../laws/machine.js";
import { awaitingMerge, unmergedReason } from "../laws/merge.js";
import type { GateKind } from "../laws/statuses.js";
import { ROUND_KINDS } from "../laws/table.js";
import type {
  GateFact,
  GateFacts,
  Known,
  LawTicket,
  MergeFacts,
  TransitionOption,
} from "../laws/types.js";
import { STAFFABLE_STATUSES } from "../staffing.js";
import type { SessionState } from "../states.js";
import {
  DRIFT_LEAD,
  HAPPENED,
  MACHINE_LEAD,
  REASON_MAX,
  SAY,
  cap,
} from "./next-step-text.js";

// Why a ticket is not moving, and what moves it: a pure reading of facts that are
// already stored. Who it waits on, one sentence, and the operator's unblocking action. The laws
// still decide every move; this only reads them (the operator's own transition options) and says so.

/**
 * Who the ticket waits on. `nothing`: no one is expected to act — it is closed, parked by a decision
 * already made, or waits only on a machine step foreman takes on its own. `paused`: the
 * next thing to happen is something new starting, and the fleet or its project is paused.
 */
export const WaitingOn = z.enum([
  "you",
  "agent",
  "reviewer",
  "qa",
  "orchestrator",
  "nothing",
  "paused",
]);
export type WaitingOn = z.infer<typeof WaitingOn>;

/**
 * What the GUI turns the action into. `transition` targets a status, `rerun_gate` a gate id,
 * `unpause` `fleet` or `project`, `configure` `runners` or `settings`, `answer` `questions` or
 * `proposal`; `start` prioritises (from backlog) and staffs a builder through the operator's own
 * doors; `none` is a hint with no button.
 */
export const NextStepActionKind = z.enum([
  "answer",
  "start",
  "transition",
  "rerun_gate",
  "unpause",
  "configure",
  "none",
]);
export type NextStepActionKind = z.infer<typeof NextStepActionKind>;

export const NextStepAction = z.object({
  label: z.string().min(1).max(60),
  kind: NextStepActionKind,
  target: z.string().min(1).max(64).optional(),
});
export type NextStepAction = z.infer<typeof NextStepAction>;

/** `GET /tickets/:ref/next` (§12.1). */
export const NextStep = z.object({
  waiting_on: WaitingOn,
  reason: z.string().min(1).max(REASON_MAX),
  action: NextStepAction.optional(),
});
export type NextStep = z.infer<typeof NextStep>;

/** A session state that is not ended: what a ticket's holder can be in. */
export type LiveSessionState = Exclude<
  SessionState,
  "exited" | "resumable" | "handed_off"
>;

/** The live session holding the ticket (a reviewer's is never its holder). */
export interface NextStepHolder {
  /** `agents.name`: never a name written here. */
  readonly agent: string;
  readonly state: LiveSessionState;
  readonly turns: number;
  /** Its runner is a script (`runners.kind`): it does no model work, so idle is where it stops. */
  readonly scripted: boolean;
}

/** A live reviewer session on the ticket. */
export interface NextStepReviewing {
  /** `agents.name`. */
  readonly agent: string;
}

/** A `session.spawn` queued for the ticket that has no session row yet. */
export interface NextStepStarting {
  /** `agents.name` of the agent it will run on. */
  readonly agent: string;
}

export interface NextStepTicket extends LawTicket {
  readonly needs_human: boolean;
  readonly blocked_reason: string | null;
  readonly unblock_condition: string | null;
}

export interface NextStepFacts {
  readonly ticket: NextStepTicket;
  /** Its open questions to the operator. */
  readonly openQuestions: number;
  /** An open staffing proposal on it. */
  readonly proposalOpen: boolean;
  /** The gate facts the laws read. */
  readonly gates: Known<GateFacts>;
  /** Gates with a live reviewer session (`sessions.gate_id`). */
  readonly liveGateIds: readonly string[];
  readonly holder: NextStepHolder | null;
  /** The spawn staffing queued, before its session row exists: the window after "Staff". */
  readonly starting: NextStepStarting | null;
  /**
   * A live gate reviewer on the ticket. Never its holder, but staffing refuses while
   * one is live (admit counts every live session of the ticket), so nothing offers to staff it.
   */
  readonly reviewing: NextStepReviewing | null;
  /** An unaccepted hand-off (v_needs_attention's handoff_pending). */
  readonly handoffPending: boolean;
  /** The operator's options, from core's allowedTransitions: what the Actions panel shows. */
  readonly transitions: readonly TransitionOption[];
  /** The reason of the transition that parked it. */
  readonly parkNote: string | null;
  readonly pause: { readonly fleet: boolean; readonly project: boolean };
  /** An enabled orchestrator covers the ticket: its project's, or one of the fleet's. */
  readonly hasOrchestrator: boolean;
  /** An enabled builder in the ticket's agent pool (staffing's own agentPool rule). */
  readonly hasBuilder: boolean;
  /**
   * Whether the ticket's project runs a QA gate: `workspaces.qa_mode` is `command` or `ci` — the
   * laws' own `qa_configured`. False: `pass_harness` is the operator's note.
   */
  readonly qaConfigured: boolean;
  /** What the CI sweep last recorded for a running CI gate. */
  readonly ci: CiWait;
  /** Its deliveries and its project's close_on_merge, as the laws read them. */
  readonly merge: MergeFacts;
}

/**
 * A running CI gate's progress, from the `deliveries` rows the CI sweep wrote for it at their
 * current head: `pulls` is how many pull requests it has read, 0 while none is open at
 * the reviewed commit yet; `done` of `total` is how many required checks have settled.
 */
export interface CiWait {
  readonly pulls: number;
  readonly done: number;
  readonly total: number;
}

/** No CI read recorded: what every ticket without a running CI gate reads as. */
export const NO_CI_WAIT: CiWait = { pulls: 0, done: 0, total: 0 };

type Action = NextStepAction;

const step = (
  waiting_on: WaitingOn,
  reason: string,
  action?: Action,
): NextStep => ({
  waiting_on,
  reason: cap(reason),
  ...(action === undefined ? {} : { action }),
});

const optionOf = (f: NextStepFacts, rule: string) =>
  f.transitions.find((t) => t.rule === rule);

/** The operator's move by `rule`, as an action, only when the laws allow it now. */
function move(
  f: NextStepFacts,
  rule: string,
  label: string,
): Action | undefined {
  const option = optionOf(f, rule);
  return option?.allowed === true
    ? { kind: "transition", label, target: option.to }
    : undefined;
}

/** Why the laws refuse `rule`, or `otherwise`. */
const refusal = (f: NextStepFacts, rule: string, otherwise: string): string =>
  optionOf(f, rule)?.detail ?? otherwise;

const STAFF_HINT: Action = {
  kind: "none",
  label: "Staff it from the Actions panel",
};
const START: Action = { kind: "start", label: "Start work" };
const STAFFABLE: ReadonlySet<string> = new Set(STAFFABLE_STATUSES);

/**
 * "Start work", when a builder can take the ticket: from backlog while the laws let the
 * operator prioritise it, or from a status staffing takes. The GUI calls the operator's own doors.
 */
function startAction(f: NextStepFacts): Action | undefined {
  if (!f.hasBuilder || f.reviewing !== null) return undefined;
  const { status } = f.ticket;
  const can =
    status === "backlog"
      ? move(f, "prioritize", START.label) !== undefined
      : STAFFABLE.has(status);
  return can ? START : undefined;
}

const CONFIGURE_REVIEWER: Action = {
  kind: "configure",
  label: "Set up a reviewer",
  target: "runners",
};
const CHECK_SETTINGS: Action = {
  kind: "configure",
  label: "Check the gate settings",
  target: "settings",
};
const rerun = (g: GateFact): Action => ({
  kind: "rerun_gate",
  label: `Rerun ${g.kind}`,
  target: g.id,
});

/** A wait on something new starting: the pause's, while the fleet or the project is paused. */
function unlessPaused(f: NextStepFacts, next: NextStep): NextStep {
  const scope = f.pause.fleet ? "fleet" : f.pause.project ? "project" : null;
  if (scope === null) return next;
  return step("paused", SAY.pausedThen(scope, next.reason), {
    kind: "unpause",
    label: scope === "fleet" ? "Resume the fleet" : "Resume the project",
    target: scope,
  });
}

/** Nothing holds the ticket: the orchestrator staffs it, or the operator when none covers it. */
function staffing(f: NextStepFacts, lead: string, mine?: Action): NextStep {
  // Staffed already: its spawn is queued and its session row not written yet.
  if (f.starting !== null) {
    return step("agent", SAY.startingFor(f.starting.agent));
  }
  // Staffing refuses while a reviewer's session on it is live: that is the wait, not staffing.
  if (f.reviewing !== null) return step("reviewer", SAY.reviewerFinishing);
  const who = f.handoffPending ? "a successor" : "it";
  const start = startAction(f);
  if (!f.hasOrchestrator) {
    return step(
      "you",
      `${lead}. ${SAY.staffYourself(who)}`,
      mine ?? start ?? STAFF_HINT,
    );
  }
  return unlessPaused(f, step("orchestrator", SAY.staff(lead, who), start));
}

const starting = (h: NextStepHolder): NextStep =>
  step("agent", `${h.agent} is starting (${h.state})`);

const HOLDING: Readonly<
  Record<LiveSessionState, (h: NextStepHolder, verb: string) => NextStep>
> = {
  pending: starting,
  preparing: starting,
  spawning: starting,
  running: (h, verb) =>
    step("agent", `${h.agent} is ${verb} (turn ${h.turns})`),
  idle: (h, verb) =>
    step(
      "agent",
      h.scripted
        ? SAY.scriptIdle(h.agent, h.turns)
        : `${h.agent} is ${verb} (turn ${h.turns}, between turns)`,
    ),
  awaiting_approval: (h) =>
    step("you", `${h.agent} waits for your approval of a tool call`, {
      kind: "none",
      label: "Decide it in its session",
    }),
  human_attached: (h) =>
    step("you", `You are attached to ${h.agent}'s session (turn ${h.turns})`),
  handoff_writing: (h) => step("agent", `${h.agent} is writing its hand-off`),
  stopping: (h) => step("agent", `${h.agent} is stopping`),
};

/** A status a worker works in: its holder, or the staffing of one. */
function worker(f: NextStepFacts, verb: string, idle: string): NextStep {
  if (f.holder !== null) return HOLDING[f.holder.state](f.holder, verb);
  return staffing(f, f.handoffPending ? "A hand-off is pending" : idle);
}

/** A status a gate decides. */
interface ReviewSpec {
  readonly name: string;
  readonly kinds: readonly GateKind[];
  /** The kind the round is named for, shown first while it runs. */
  readonly anchor: GateKind;
  readonly running: string;
  readonly waiter: WaitingOn;
  /** The edge the round passes by, whose refusal says why it has not. */
  readonly forward: string;
  /** The edge back to the work, and its label. */
  readonly back: { readonly rule: string; readonly label: string };
  /** A code or subject failure sends the work back through the orchestrator (a plan's). */
  readonly revise: boolean;
}

const PLAN: ReviewSpec = {
  name: "Plan review",
  kinds: ["plan_review"],
  anchor: "plan_review",
  running: "Reviewer is reviewing the plan",
  waiter: "reviewer",
  forward: "approve_plan",
  back: { rule: "revise_plan", label: "Revise the plan" },
  revise: true,
};
const CODE: ReviewSpec = {
  name: "Review",
  kinds: ROUND_KINDS,
  anchor: "code_review",
  running: "Reviewer is reviewing",
  waiter: "reviewer",
  forward: "pass_review",
  back: { rule: "request_fix", label: "Send back to fix" },
  revise: false,
};
const QA: ReviewSpec = {
  name: "QA",
  kinds: ["qa_harness"],
  anchor: "qa_harness",
  running: "The QA harness is running",
  waiter: "qa",
  forward: "pass_harness",
  back: { rule: "fail_harness", label: "Fail QA" },
  revise: false,
};

/** The failed latest gates whose reason reads, with it. */
const failuresOf = (failed: readonly GateFact[]) =>
  failed.flatMap((gate) => {
    const reason = failReason(gate.evidence);
    return reason === null ? [] : [{ gate, reason }];
  });

/** A pre-review failure's own detail line (GateFailure), in brackets. */
function detailOf(g: GateFact): string {
  const detail = GateFailure.safeParse(g.evidence).data?.detail;
  return detail === undefined ? "" : ` (${detail})`;
}

function reviewing(
  f: NextStepFacts,
  spec: ReviewSpec,
  running: readonly GateFact[],
): NextStep {
  const shown = running.reduce((best, g) =>
    g.kind === spec.anchor ? g : best,
  );
  // A CI gate runs nothing: it waits for a pull request at the reviewed commit, then
  // for the checks the forge runs on it.
  if (shown.subjectKind === CI_SUBJECT) {
    return step(
      spec.waiter,
      f.ci.pulls === 0
        ? SAY.ciAwaitingPr
        : SAY.ciRunning(f.ci.done, f.ci.total),
    );
  }
  const attempt = `(attempt ${shown.attempt})`;
  // Review gates run a reviewer session; while none of them has one live, the reviewer has yet to
  // start, and a pause is what holds it. A script job (parity, lint) runs no session.
  const reviews = running.filter((g) => isReviewGateKind(g.kind));
  if (
    reviews.length > 0 &&
    !reviews.some((g) => f.liveGateIds.includes(g.id))
  ) {
    return unlessPaused(
      f,
      step(
        spec.waiter,
        `Waiting for a reviewer to start ${shown.kind} ${attempt}`,
      ),
    );
  }
  const what =
    shown.kind === spec.anchor ? spec.running : `${shown.kind} is running`;
  return step(spec.waiter, `${what} ${attempt}`);
}

/** The latest failures in the round that someone must answer, most urgent first. */
function failedStep(
  f: NextStepFacts,
  spec: ReviewSpec,
  gates: GateFacts,
  failures: readonly {
    readonly gate: GateFact;
    readonly reason: GateFailReason;
  }[],
): NextStep | undefined {
  const infra = failures.find((x) => FAILURE_CLASS[x.reason] === "infra");
  if (infra !== undefined) {
    return step(
      "you",
      `${spec.name} ${HAPPENED[infra.reason]}${detailOf(infra.gate)}`,
      infra.reason === "no_reviewer" ? CONFIGURE_REVIEWER : rerun(infra.gate),
    );
  }
  const drift = failures.find((x) => x.reason === "base_drift");
  if (drift !== undefined) {
    // the machine sends a drifted round back itself, up to gates.drift_rounds_max.
    const capped = driftCapped(gates)
      ? SAY.driftCapped(driftStreak(gates.gates))
      : null;
    return step(
      "you",
      `${spec.name} ${capped ?? HAPPENED.base_drift}`,
      move(f, spec.back.rule, spec.back.label),
    );
  }
  const redo = failures.find(
    (x) => x.reason === "blocking_findings" || x.reason === "source_changes",
  );
  if (!spec.revise || redo === undefined) return undefined;
  const lead = `${spec.name} ${HAPPENED[redo.reason]}`;
  const action = move(f, spec.back.rule, spec.back.label);
  if (!f.hasOrchestrator) {
    return step(
      "you",
      `${lead}: send it back yourself (${spec.back.rule})`,
      action,
    );
  }
  return unlessPaused(
    f,
    step(
      "orchestrator",
      `${lead}: waiting for the orchestrator to send it back (${spec.back.rule})`,
      action,
    ),
  );
}

/** A latest gate of the review round failed because its base moved. */
const drifted = (gates: GateFacts): boolean =>
  roundOf(gates, ROUND_KINDS).latest.some(
    (g) => g.state === "failed" && failReason(g.evidence) === "base_drift",
  );

function review(f: NextStepFacts, spec: ReviewSpec): NextStep {
  const { gates } = f;
  if (gates.state === "unavailable") {
    return step(
      "you",
      `Gate facts are unavailable: ${gates.detail}`,
      CHECK_SETTINGS,
    );
  }
  const machine = machineStep({
    ticket: f.ticket,
    gates: gates.value,
    merge: f.merge,
  });
  if (machine.take) {
    const lead =
      machine.rule === "request_fix" && drifted(gates.value)
        ? DRIFT_LEAD
        : MACHINE_LEAD[machine.rule];
    return step(
      "nothing",
      `${lead}: foreman moves it to ${machine.to} on its own`,
      move(f, machine.rule, "Move it now"),
    );
  }
  const { running, latest } = roundOf(gates.value, spec.kinds);
  if (running.length > 0) return reviewing(f, spec, running);
  const failed = latest.filter((g) => g.state === "failed");
  const answered = failedStep(f, spec, gates.value, failuresOf(failed));
  if (answered !== undefined) return answered;
  // Nothing runs, nothing will: the law's own refusal says why, and a rerun or the edge back is the
  // way on (a superseded review of a reclaimed ticket, a gate that became required mid-round).
  const [last] = failed;
  return step(
    "you",
    `${SAY.notMoving(spec.name)}: ${refusal(f, spec.forward, machine.why)}`,
    last === undefined ? move(f, spec.back.rule, spec.back.label) : rerun(last),
  );
}

/**
 * What a pull request says about a ticket after review: all merged, and foreman closes
 * it on its own; all still open in a project that closes on merge, and it waits for the merge,
 * with the operator's own way on as the action. Undefined when neither holds.
 */
function merging(
  f: NextStepFacts,
  forward?: { readonly rule: string; readonly label: string },
): NextStep | undefined {
  if (unmergedReason(f.merge) === null) {
    return step(
      "nothing",
      `${MACHINE_LEAD.merge_close}: foreman moves it to done on its own`,
    );
  }
  const urls = awaitingMerge(f.merge);
  if (urls.length === 0) return undefined;
  return step(
    "you",
    SAY.awaitingMerge(urls),
    forward === undefined ? undefined : move(f, forward.rule, forward.label),
  );
}

/** A QA harness of the ticket's round is running: the harness, not the merge, is the wait. */
const harnessRunning = (f: NextStepFacts): boolean =>
  f.gates.state === "known" &&
  roundOf(f.gates.value, QA.kinds).running.length > 0;

function qaHarness(f: NextStepFacts): NextStep {
  if (unmergedReason(f.merge) === null || !harnessRunning(f)) {
    const merge = merging(f, { rule: "pass_harness", label: "Pass QA" });
    if (merge !== undefined) return merge;
  }
  return f.qaConfigured
    ? review(f, QA)
    : step("you", SAY.qaNote, move(f, "pass_harness", "Pass with a note"));
}

function rework(f: NextStepFacts): NextStep {
  const merge =
    unmergedReason(f.merge) === null || f.holder === null
      ? merging(f)
      : undefined;
  return merge ?? worker(f, "reworking it", "No session holds it");
}

function humanQa(f: NextStepFacts): NextStep {
  const merge = merging(f, { rule: "pass_human_qa", label: "Pass human QA" });
  if (merge !== undefined) return merge;
  const pass = move(f, "pass_human_qa", "Pass human QA");
  if (pass !== undefined) return step("you", SAY.humanQa, pass);
  return step(
    "you",
    `${SAY.humanQa}; it cannot pass yet: ${refusal(f, "pass_human_qa", "the laws refuse it")}`,
    move(f, "fail_human_qa", "Fail human QA"),
  );
}

function blocked(f: NextStepFacts): NextStep {
  const until = f.ticket.unblock_condition;
  return step(
    "you",
    `${SAY.blocked(f.ticket.blocked_reason)}${until === null ? "" : ` · unblocks when ${until}`}`,
    move(f, "unblock", "Unblock"),
  );
}

function split(f: NextStepFacts): NextStep {
  const close = move(f, "close_split", "Close the split");
  if (close !== undefined) return step("you", SAY.splitClosable, close);
  return step(
    "nothing",
    `Split: waits for its child tickets (${refusal(f, "close_split", "not closable yet")})`,
  );
}

/** handoff_pending: the operator released it (M1, plan rule 3). */
function released(f: NextStepFacts): NextStep {
  const reclaim = move(f, "reclaim", "Reclaim");
  if (f.handoffPending) return staffing(f, "Released with a hand-off", reclaim);
  return step("you", SAY.released, reclaim);
}

type WorkStatus = Exclude<
  LawTicket["status"],
  "done" | "rejected" | "blocked" | "parked" | "split" | "handoff_pending"
>;

function working(f: NextStepFacts, status: WorkStatus): NextStep {
  switch (status) {
    case "backlog":
      return f.hasOrchestrator
        ? unlessPaused(f, step("orchestrator", SAY.prioritise, startAction(f)))
        : step(
            "you",
            SAY.prioritiseYourself,
            startAction(f) ?? move(f, "prioritize", "Prioritise"),
          );
    case "prioritized":
      return worker(f, "starting", "Prioritised");
    case "staffed":
      return worker(f, "starting", "No session holds it");
    case "spiking":
      return worker(f, "writing the plan", "No session holds it");
    case "planned":
      return worker(f, "starting the build", "No session holds it");
    case "building":
      return worker(f, "building", "No session holds it");
    case "rework":
      return rework(f);
    case "review_fix":
      return worker(f, "fixing the review's findings", "No session holds it");
    case "plan_review":
      return review(f, PLAN);
    case "code_review":
      return review(f, CODE);
    case "qa_harness":
      return qaHarness(f);
    case "qa_human":
      return humanQa(f);
  }
}

/**
 * The ticket's next step. Closed first; then what is already asked of the operator (questions, a
 * staffing proposal); then the held statuses; then the needs-human flag; then the status's own rule.
 */
export function nextStep(f: NextStepFacts): NextStep {
  const { status } = f.ticket;
  if (status === "done" || status === "rejected") {
    return step(
      "nothing",
      `${status === "done" ? "Done" : "Rejected"}: nothing left to do`,
    );
  }
  if (f.openQuestions > 0) {
    return step("you", SAY.answers(f.openQuestions), {
      kind: "answer",
      label: f.openQuestions === 1 ? "Answer it" : "Answer them",
      target: "questions",
    });
  }
  if (f.proposalOpen) {
    return step("you", SAY.proposal, {
      kind: "answer",
      label: "Review the proposal",
      target: "proposal",
    });
  }
  switch (status) {
    case "blocked":
      return blocked(f);
    case "parked":
      return step(
        "nothing",
        SAY.parked(f.parkNote),
        move(f, "unpark", "Unpark"),
      );
    case "split":
      return split(f);
    case "handoff_pending":
      return released(f);
    default:
      return f.ticket.needs_human
        ? step("you", SAY.flagged, {
            kind: "none",
            label: "Clear the flag once handled",
          })
        : working(f, status);
  }
}

/** The step waits on the operator: on you, or on a pause only you can lift. */
export const waitsOnYou = (s: Pick<NextStep, "waiting_on">): boolean =>
  s.waiting_on === "you" || s.waiting_on === "paused";
