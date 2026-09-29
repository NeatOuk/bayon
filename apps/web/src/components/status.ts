import {
  CiCheckState,
  ConformanceStatus,
  DELIVERY_ROW_STATES,
  ExitReason,
  GateFailReason,
  GateState,
  HandoffQuality,
  PulseSkipReason,
  QA_RUN_STATES,
  SessionState,
  TICKET_STATUSES,
  WaitingOn,
  type DeliveryRowState,
  type QaRunState,
  type TicketStatus,
} from "@bayon/core";
import {
  AttentionItem,
  ExecutorHealthResult,
  InboxStatus,
  PulseState,
  type FeedStatus,
} from "@bayon/proto";
import {
  Activity,
  ArrowRightLeft,
  Ban,
  Bot,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleMinus,
  CirclePause,
  CircleSlash,
  CircleX,
  ClipboardCheck,
  Eye,
  FlaskConical,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Hand,
  HeartPulse,
  Hourglass,
  KeyRound,
  ListChecks,
  MessageCircleQuestion,
  Moon,
  PencilLine,
  Play,
  Power,
  PowerOff,
  RotateCcw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  SkipForward,
  Split,
  TimerOff,
  TriangleAlert,
  Upload,
  UserRound,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import {
  CERTIFICATION_STATES,
  type CertificationState,
} from "@/ide/runner-certification";

// One map from entity to state to how it reads: a tone, a human label and an icon. Every
// badge that shows a state renders from here, so a crashed session and a blocked ticket can no longer
// be green in one place and red in another. Each map is typed against its enum, so a state the
// server adds fails typecheck here until it is given a tone and a label (status.test.ts walks the
// enum arrays).
//
// The tones mean one thing each: `success` it finished well (the only green); `danger` it failed or
// is stuck; `warning` someone has to look — you, a pause, a retry; `info` something is at work;
// `neutral` at rest, not started, or already decided.

export const TONES = [
  "success",
  "warning",
  "danger",
  "info",
  "neutral",
] as const;
export type Tone = (typeof TONES)[number];

export interface StatusEntry {
  readonly tone: Tone;
  /** Human text, sentence case: never the stored snake_case. */
  readonly label: string;
  /** Beside the label, so colour is never the only signal. */
  readonly icon: LucideIcon;
}

const TONE_ICON: Readonly<Record<Tone, LucideIcon>> = {
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleX,
  info: CircleDot,
  neutral: Circle,
};

const entry = (
  tone: Tone,
  label: string,
  icon: LucideIcon = TONE_ICON[tone],
): StatusEntry => ({ tone, label, icon });

/** A stored value as words: `qa_harness` → "Qa harness". Only for values no map knows yet. */
export const humanize = (value: string): string => {
  const words = value.replaceAll("_", " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** How a state no map knows reads: as stored, in words, neutral. A newer server can add states. */
export const unknownStatus = (state: string): StatusEntry =>
  entry("neutral", humanize(state), CircleHelp);

const TICKET = {
  backlog: entry("neutral", "Backlog", CircleDashed),
  prioritized: entry("neutral", "Prioritized"),
  staffed: entry("info", "Staffed", UserRound),
  spiking: entry("info", "Spiking", FlaskConical),
  plan_review: entry("info", "Plan review", Eye),
  planned: entry("neutral", "Planned", ListChecks),
  building: entry("info", "Building", Activity),
  code_review: entry("info", "Code review", Eye),
  review_fix: entry("info", "Review fix", RotateCcw),
  qa_harness: entry("info", "QA harness", ClipboardCheck),
  qa_human: entry("warning", "Human QA", Hand),
  rework: entry("warning", "Rework", RotateCcw),
  done: entry("success", "Done"),
  blocked: entry("danger", "Blocked", Ban),
  parked: entry("neutral", "Parked", CirclePause),
  rejected: entry("neutral", "Rejected", CircleSlash),
  handoff_pending: entry("info", "Hand-off pending", ArrowRightLeft),
  split: entry("neutral", "Split", Split),
} as const satisfies Record<TicketStatus, StatusEntry>;

const SESSION = {
  pending: entry("neutral", "Pending", CircleDashed),
  preparing: entry("info", "Preparing", Hourglass),
  spawning: entry("info", "Starting", Hourglass),
  running: entry("info", "Running", Activity),
  idle: entry("neutral", "Idle", CirclePause),
  awaiting_approval: entry("warning", "Awaiting approval", Hand),
  human_attached: entry("info", "Human attached", UserRound),
  handoff_writing: entry("info", "Writing hand-off", PencilLine),
  handed_off: entry("neutral", "Handed off", ArrowRightLeft),
  stopping: entry("neutral", "Stopping", CircleMinus),
  exited: entry("neutral", "Exited", CircleMinus),
  resumable: entry("warning", "Resumable", RotateCcw),
} as const satisfies Record<SessionState, StatusEntry>;

/** An exited session reads by how it ended: `error` is a crash. */
const SESSION_EXIT = {
  ok: entry("success", "Finished"),
  error: entry("danger", "Crashed"),
  killed: entry("warning", "Killed", Ban),
  timeout: entry("danger", "Timed out", TimerOff),
  abandoned: entry("neutral", "Abandoned", CircleSlash),
} as const satisfies Record<ExitReason, StatusEntry>;

const GATE = {
  running: entry("info", "Running", Activity),
  passed: entry("success", "Passed"),
  failed: entry("danger", "Failed"),
  waived: entry("neutral", "Waived", SkipForward),
} as const satisfies Record<GateState, StatusEntry>;

/**
 * Why a gate failed, as its badge reads "Failed (<label>)". Findings are the code's failure (danger);
 * a reviewer that failed or was never found is not, and someone must look (warning); a round the
 * operator moved past, or that is retried on its own, is neither (neutral).
 */
const GATE_FAILURE = {
  timeout: entry("neutral", "timeout", TimerOff),
  supervisor_restart: entry("neutral", "supervisor restart", RotateCcw),
  no_reviewer: entry("warning", "no reviewer", CircleAlert),
  reviewer_error: entry("warning", "reviewer error", CircleAlert),
  missing_evidence: entry("danger", "missing evidence"),
  source_changes: entry("danger", "source changes"),
  base_drift: entry("danger", "base drift"),
  blocking_findings: entry("danger", "blocking findings"),
  superseded: entry("neutral", "superseded", SkipForward),
} as const satisfies Record<GateFailReason, StatusEntry>;

const PULSE = {
  leased: entry("info", "Starting", Hourglass),
  running: entry("info", "Running", Activity),
  done: entry("success", "Done"),
  skipped: entry("neutral", "Skipped", SkipForward),
  failed: entry("danger", "Failed"),
  expired: entry("warning", "Expired", TimerOff),
} as const satisfies Record<PulseState, StatusEntry>;

/** A skipped pulse reads "Skipped (<label>)": the per-hour guard firing wants a look. */
const PULSE_SKIP = {
  nothing_to_do: entry("neutral", "nothing to do", SkipForward),
  rate_capped: entry("warning", "rate capped"),
  paused: entry("neutral", "paused", CirclePause),
  over_budget: entry("warning", "over budget"),
} as const satisfies Record<PulseSkipReason, StatusEntry>;

/** Who a ticket waits on (its next step): you are asked to act, never alarmed. */
const WAITING = {
  you: entry("warning", "Waiting on you", Hand),
  paused: entry("warning", "Paused", CirclePause),
  agent: entry("info", "Agent at work", Bot),
  reviewer: entry("info", "In review", Eye),
  qa: entry("info", "In QA", ClipboardCheck),
  orchestrator: entry("info", "Orchestrator's turn", Bot),
  nothing: entry("neutral", "Nothing to do"),
} as const satisfies Record<WaitingOn, StatusEntry>;

/** Agents, runners and executors alike. */
const ENABLED = {
  enabled: entry("info", "Enabled", Power),
  disabled: entry("neutral", "Disabled", PowerOff),
} as const;

/** An orchestrator is awake while it has a live session. */
const PRESENCE = {
  awake: entry("info", "Awake", Activity),
  asleep: entry("neutral", "Asleep", Moon),
} as const;

/** `executors.health`: `unknown` until the first check, then what the check found. */
export const EXECUTOR_HEALTHS = [
  "unknown",
  ...ExecutorHealthResult.shape.health.options,
] as const;
export type ExecutorHealth = (typeof EXECUTOR_HEALTHS)[number];

const HEALTH = {
  unknown: entry("neutral", "Unknown", CircleHelp),
  healthy: entry("success", "Healthy", HeartPulse),
  unhealthy: entry("danger", "Unhealthy"),
} as const satisfies Record<ExecutorHealth, StatusEntry>;

/** `executors.trust` (001): where untrusted roles run. Neither is good or bad. */
export const EXECUTOR_TRUSTS = ["trusted", "untrusted"] as const;

const TRUST = {
  trusted: entry("neutral", "Trusted", ShieldCheck),
  untrusted: entry("neutral", "Untrusted", Shield),
} as const satisfies Record<(typeof EXECUTOR_TRUSTS)[number], StatusEntry>;

/**
 * A runner's certification on one executor, and runner-wide (`uncertified`: no executor has passed
 * it, so unattended work there is refused while admission requires it).
 */
const CERTIFICATION = {
  certified: entry("success", "Certified", ShieldCheck),
  "not certified": entry("danger", "Not certified", ShieldX),
  decertified: entry("danger", "Decertified", ShieldAlert),
  "never run": entry("neutral", "Never run", Shield),
  uncertified: entry("warning", "Uncertified", ShieldAlert),
} as const satisfies Record<CertificationState | "uncertified", StatusEntry>;

/** Whether a role binding's runner is one the registry knows. */
const RUNNER_REF = {
  unknown: entry("danger", "Unknown runner", CircleHelp),
} as const;

/** Whether a runner may review (gate eligibility). */
const ELIGIBILITY = {
  eligible: entry("info", "Gate-eligible", Eye),
  ineligible: entry("neutral", "Not gate-eligible", CircleMinus),
} as const;

/** A runner's declared capability. */
const CAPABILITY = {
  yes: entry("info", "Yes", CircleCheck),
  no: entry("neutral", "No", CircleMinus),
} as const;

/** One §15 test's result in a stored run; `not run` when the summary does not list it. */
export const CONFORMANCE_STATES = [
  ...ConformanceStatus.options,
  "not run",
] as const;
export type ConformanceState = (typeof CONFORMANCE_STATES)[number];

const CONFORMANCE = {
  pass: entry("success", "pass"),
  fail: entry("danger", "fail"),
  na: entry("neutral", "n/a", CircleMinus),
  incomplete: entry("warning", "incomplete"),
  "not run": entry("neutral", "not run", CircleDashed),
} as const satisfies Record<ConformanceState, StatusEntry>;

const DELIVERY = {
  pushed: entry("success", "Pushed", Upload),
  pr_open: entry("info", "PR open", GitPullRequest),
  merged: entry("success", "Merged", GitMerge),
  closed: entry("warning", "Closed unmerged", GitPullRequestClosed),
  failed: entry("danger", "Failed"),
} as const satisfies Record<DeliveryRowState, StatusEntry>;

const QA_RUN = {
  passed: entry("success", "Passed"),
  failed: entry("danger", "Failed"),
  error: entry("warning", "Could not run"),
} as const satisfies Record<QaRunState, StatusEntry>;

const CI_CHECK = {
  pending: entry("info", "Pending", Hourglass),
  success: entry("success", "Passed"),
  failure: entry("danger", "Failed"),
  neutral: entry("neutral", "Neutral"),
  skipped: entry("neutral", "Skipped", SkipForward),
} as const satisfies Record<CiCheckState, StatusEntry>;

/** A hand-off packet: `writing` is not takeable yet; `degraded` lost the agent's own judgement. */
const HANDOFF = {
  writing: entry("info", "Writing", PencilLine),
  full: entry("success", "Full"),
  degraded: entry("warning", "Degraded"),
} as const satisfies Record<HandoffQuality, StatusEntry>;

const INBOX = {
  open: entry("warning", "Open", MessageCircleQuestion),
  answered: entry("success", "Answered"),
  dismissed: entry("neutral", "Dismissed", CircleSlash),
} as const satisfies Record<InboxStatus, StatusEntry>;

/** The fleet's or a project's admission switch. */
const PAUSE = {
  paused: entry("warning", "Paused", CirclePause),
  running: entry("neutral", "Running", Play),
} as const;

const FEED = {
  connecting: entry("warning", "Feed connecting…", Wifi),
  reconnecting: entry("danger", "Feed disconnected", WifiOff),
  open: entry("success", "Live", Wifi),
} as const satisfies Record<FeedStatus, StatusEntry>;

/** A notification channel. */
const CHANNEL = {
  configured: entry("info", "Configured", CircleCheck),
  unconfigured: entry("neutral", "Not configured", CircleDashed),
} as const;

/** `admission.require_certified`: off lets a runner nobody certified run unattended. */
const CERT_RULE = {
  on: entry("success", "On: uncertified runners are refused", ShieldCheck),
  off: entry("danger", "Off: uncertified runners run unattended", ShieldAlert),
} as const;

/** What a pulse check flagged of the content it read. */
const CONTENT = {
  trusted: entry("neutral", "Trusted", ShieldCheck),
  untrusted: entry("danger", "Untrusted", ShieldAlert),
} as const;

/** A secret the host store should hold (a token): found, or not stored yet. Its value is never read. */
const SECRET = {
  found: entry("success", "Token found", KeyRound),
  missing: entry("neutral", "Not stored", CircleDashed),
} as const;

/**
 * What the Fleet's "Needs you" lists (amendment 8): a live session gone quiet, and a session that
 * ended in an error.
 */
const ATTENTION = {
  stale: entry("warning", "Stale", Hourglass),
  errored: entry("danger", "Crashed"),
} as const satisfies Record<AttentionItem["why"], StatusEntry>;

/** A timeline event: an error event reads as a failure. */
const EVENT = {
  ok: entry("neutral", "Event"),
  error: entry("danger", "Error"),
} as const;

export const STATUS = {
  ticket: TICKET,
  session: SESSION,
  sessionExit: SESSION_EXIT,
  gate: GATE,
  gateFailure: GATE_FAILURE,
  pulse: PULSE,
  pulseSkip: PULSE_SKIP,
  waiting: WAITING,
  enabled: ENABLED,
  presence: PRESENCE,
  health: HEALTH,
  trust: TRUST,
  certification: CERTIFICATION,
  runnerRef: RUNNER_REF,
  eligibility: ELIGIBILITY,
  capability: CAPABILITY,
  conformance: CONFORMANCE,
  delivery: DELIVERY,
  qaRun: QA_RUN,
  ciCheck: CI_CHECK,
  handoff: HANDOFF,
  inbox: INBOX,
  pause: PAUSE,
  feed: FEED,
  channel: CHANNEL,
  certRule: CERT_RULE,
  content: CONTENT,
  secret: SECRET,
  attention: ATTENTION,
  event: EVENT,
} as const;

export type StatusEntity = keyof typeof STATUS;
export type StateOf<E extends StatusEntity> = keyof (typeof STATUS)[E] & string;

/** The enum each typed entity is checked against (status.test.ts): every value must be mapped. */
export const ENTITY_STATES = {
  ticket: TICKET_STATUSES,
  session: SessionState.options,
  sessionExit: ExitReason.options,
  gate: GateState.options,
  gateFailure: GateFailReason.options,
  pulse: PulseState.options,
  pulseSkip: PulseSkipReason.options,
  waiting: WaitingOn.options,
  health: EXECUTOR_HEALTHS,
  trust: EXECUTOR_TRUSTS,
  certification: [...CERTIFICATION_STATES, "uncertified"],
  conformance: CONFORMANCE_STATES,
  delivery: DELIVERY_ROW_STATES,
  qaRun: QA_RUN_STATES,
  ciCheck: CiCheckState.options,
  handoff: HandoffQuality.options,
  inbox: InboxStatus.options,
  attention: AttentionItem.shape.why.options,
} as const satisfies Partial<Record<StatusEntity, readonly string[]>>;

/** `entity`'s reading of `state`; a state it does not know reads as stored, neutral. */
export function statusOf(entity: StatusEntity, state: string): StatusEntry {
  const map: Readonly<Record<string, StatusEntry>> = STATUS[entity];
  return Object.hasOwn(map, state)
    ? (map[state] ?? unknownStatus(state))
    : unknownStatus(state);
}

/** The label alone, for a state named inside a sentence. */
export const labelOf = (entity: StatusEntity, state: string): string =>
  statusOf(entity, state).label;

/** A session: an exited one by how it ended (`error` is a crash), any other by its state. */
export function sessionStatus(
  state: string,
  exitReason: string | null = null,
): StatusEntry {
  return state === "exited" && exitReason !== null
    ? statusOf("sessionExit", exitReason)
    : statusOf("session", state);
}

/**
 * "Failed (blocking findings)": a failed gate reads by its reason. A reason core does not know yet
 * reads as stored and keeps its state's tone — the gate still failed — as a skip's does (neutral).
 */
export function gateStatus(gate: {
  readonly state: string;
  readonly reason: string | null;
}): StatusEntry {
  if (gate.state !== "failed" || gate.reason === null)
    return statusOf("gate", gate.state);
  const reason = Object.hasOwn(GATE_FAILURE, gate.reason)
    ? statusOf("gateFailure", gate.reason)
    : entry("danger", gate.reason.replaceAll("_", " "));
  return { ...reason, label: `Failed (${reason.label})` };
}

/** "Skipped (rate capped)": a skipped pulse reads by why it was skipped. */
export function pulseStatus(pulse: {
  readonly state: string;
  readonly skip_reason: string | null;
}): StatusEntry {
  if (pulse.state !== "skipped" || pulse.skip_reason === null)
    return statusOf("pulse", pulse.state);
  const reason = Object.hasOwn(PULSE_SKIP, pulse.skip_reason)
    ? statusOf("pulseSkip", pulse.skip_reason)
    : entry("neutral", pulse.skip_reason.replaceAll("_", " "), SkipForward);
  return { ...reason, label: `Skipped (${reason.label})` };
}

/** The text colour of a tone, for an icon or a dot outside a badge. */
export const TONE_TEXT: Readonly<Record<Tone, string>> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  neutral: "text-muted-foreground",
};
