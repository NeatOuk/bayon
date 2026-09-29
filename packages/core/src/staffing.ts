import { z } from "zod";
import { isTerminal, type TicketStatus } from "./laws/statuses.js";
import type { SessionState } from "./states.js";

// Staffing (M2 amendment h): the run class a ticket's status asks for, and the agent that takes it.
// Pure over plain rows: the API's writer reads them inside its transaction and asks these.

/** The roles ticket_staff spawns (§11.1): every worker kind, never the orchestrator itself. */
export const StaffRole = z.enum(["builder", "reviewer", "investigator"]);
export type StaffRole = z.infer<typeof StaffRole>;

/** Why staffing said no: a closed set, so a caller can act on it. */
export const StaffRefusalReason = z.enum([
  /** Its status takes no session, or a live session or queued spawn already works it. */
  "not_staffable",
  /** Today's spend reached `budget.daily_cap_usd` (amendment f). */
  "over_budget",
  /** No enabled agent of the role has a free slot. */
  "no_agent",
  /**
   * Not yet, rather than no: the ticket's holder has been silent past
   * `watchdog.silent_ms` — the `stale_session` arm's own rule — so the server queued its hand-off
   * and this call staffs once the session has ended. Distinct from `not_staffable` because the
   * caller should ask again, and because something was written.
   */
  "holder_releasing",
  /**
   * The caller is a session whose agent belongs to one project, and the ticket is in another or in
   * none. The operator is never refused this, nor is an agent with no project.
   */
  "cross_project",
  /**
   * Not yet: the operator decides. The ticket's project requires approval for a
   * session's staffing, so the call filed a proposal — or found its phase's proposal still open —
   * and nothing was started. Like `holder_releasing` it may have written (a new proposal); unlike
   * any other reason it is not an error to its caller, whose proposal is the outcome it asked for.
   */
  "approval_pending",
  /**
   * Not yet: the ticket has an open question to the operator, a human request of any
   * kind but `staff_approval`. The session that asked went on or handed off (`human.ask` never
   * blocks it); the ticket waits for the answer, whose arrival wakes the orchestrator. The
   * operator's own staffing overrides it, audited. Writes nothing.
   */
  "awaiting_human",
]);
export type StaffRefusalReason = z.infer<typeof StaffRefusalReason>;

/**
 * The states a holder can be released from: exactly the `stale_session` arm's
 * (`v_needs_attention`). `human_attached` and `awaiting_approval` are alive with someone in the
 * room, `handoff_writing` is already releasing, and the rest have ended.
 */
export const RELEASABLE_HOLDER_STATES = [
  "running",
  "idle",
] as const satisfies readonly SessionState[];

/** A ticket's holder as the silence rule sees it. */
export interface HolderSilence {
  readonly state: SessionState;
  /** Written by ingest on every canonical event; null before the first one. */
  readonly last_event_at: number | null;
}

/**
 * Whether the holder has stopped being one in anything but the row: silent for at
 * least `silentMs`, in a state the arm flags. Null `silentMs` (the setting is missing or
 * unreadable) is never stale — a ticket is never taken away on a number we could not read — and
 * nor is a session that has never emitted an event, whose spawn is simply still landing.
 */
export function staleHolder(
  holder: HolderSilence,
  now: number,
  silentMs: number | null,
): boolean {
  if (silentMs === null || holder.last_event_at === null) return false;
  if (!(RELEASABLE_HOLDER_STATES as readonly string[]).includes(holder.state)) {
    return false;
  }
  return now - holder.last_event_at >= silentMs;
}

export interface StaffPlan {
  /** A prioritized ticket moves to staffed (law `staff`) with the spawn. */
  readonly transition: boolean;
  readonly runClass: string;
}

/** The statuses a ticket can be staffed from. */
export const STAFFABLE_STATUSES = [
  "prioritized",
  "staffed",
  "spiking",
  "planned",
  "building",
  "rework",
  "review_fix",
] as const satisfies readonly TicketStatus[];

/**
 * The run class from the status: staffed and spiking spike, planned, building and rework build
 * (build_complex for a complex tier), review_fix fixes. Prioritized is staffed first, so it spikes.
 * Null: not staffable.
 */
export function staffPlan(
  status: TicketStatus,
  tier: string,
): StaffPlan | null {
  switch (status) {
    case "prioritized":
      return { transition: true, runClass: "spike" };
    case "staffed":
    case "spiking":
      return { transition: false, runClass: "spike" };
    case "planned":
    case "building":
    case "rework":
      return {
        transition: false,
        runClass: tier === "complex" ? "build_complex" : "build",
      };
    case "review_fix":
      return { transition: false, runClass: "fix" };
    default:
      return null;
  }
}

/**
 * Statuses a pending hand-off does not reopen: the operator's holds, and a split parent. The
 * supervisor's blockTicket reads the same list: it never blocks over a park or a split.
 */
export const HELD_STATUSES: readonly TicketStatus[] = [
  "blocked",
  "parked",
  "split",
];

/**
 * The waiting rooms: statuses whose next move belongs to a gate or a human, never to a
 * worker. `staffPlan` already refuses them — they ask for no run class — but plan rule 3 used to
 * reopen them for a pending hand-off *with the predecessor's class*, so a hand-off written at
 * `code_review` let a pulse staff a builder while the reviewers were still running. That hazard
 * predates the phase-boundary hand-off (a session dying mid-review leaves a degraded row with the
 * same effect); a phase change only makes it routine. `handoff_pending` is deliberately absent:
 * reopening it is what rule 3 exists for.
 */
export const AWAITING_STATUSES: readonly TicketStatus[] = [
  "plan_review",
  "code_review",
  "qa_harness",
  "qa_human",
];

/**
 * Plan rule 3: a ticket with a pending hand-off is staffable whatever its status (a legacy release
 * left it in handoff_pending), unless it is closed, held, or waiting on a review; the successor
 * continues its predecessor's run class. Without a pending hand-off, staffPlan decides.
 */
export function staffPlanFor(
  status: TicketStatus,
  tier: string,
  pending: { readonly runClass: string } | null,
): StaffPlan | null {
  const plan = staffPlan(status, tier);
  if (plan !== null || pending === null) return plan;
  if (isTerminal(status) || HELD_STATUSES.includes(status)) return null;
  // Once the gate's own edge moves the ticket on (approve_plan, request_fix, fail_harness),
  // staffPlan answers again — with the new, correct class rather than the predecessor's stale one.
  if (AWAITING_STATUSES.includes(status)) return null;
  return { transition: false, runClass: pending.runClass };
}

/** Where a phase ends: the run class the ticket now asks for, when it is not the session's. */
export interface PhaseBoundary {
  /** The run class the landed status asks for; null when it asks for none (a waiting room). */
  readonly to: string | null;
}

/**
 * Whether a session that was spawned as `runClass` has finished its phase (§7.1's `phase_change`):
 * the run class `status` now asks for is no longer the one it carries. Derived from `staffPlan`,
 * never a second hand-written list of phase transitions, so the two cannot drift.
 *
 * `status` must be the status the move actually **landed** on (`advanceTo ?? to`):  * trivial-ticket path carries `submit_plan` past `plan_review` to `planned`, and judging the edge's
 * nominal target instead would strand exactly that ticket.
 */
export function phaseBoundary(
  runClass: string,
  status: TicketStatus,
  tier: string,
): PhaseBoundary | null {
  const asked = staffPlan(status, tier)?.runClass ?? null;
  return asked === runClass ? null : { to: asked };
}

/** An agent as the selection rule sees it. */
export interface StaffCandidate {
  readonly id: string;
  readonly kind: string;
  readonly runner_id: string;
  readonly enabled: boolean;
  readonly max_concurrency: number;
  readonly created_at: number;
  /** Its live sessions plus its spawns not yet a session. */
  readonly busy: number;
}

/** `role_bindings[role]`: the runner that plays the role, and the one to use when it has no slot. */
export interface StaffBinding {
  readonly runner_id: string;
  readonly fallback_runner_id: string | null;
}

const oldestFirst = (a: StaffCandidate, b: StaffCandidate): number =>
  a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Whose agents the candidates are: `project` — the ticket's project's own; `fleet` —
 * the fleet's: every agent, for a ticket with no project, or the agents with no project, for a
 * ticket whose project has none of the role.
 */
export type StaffScope = "project" | "fleet";

/**
 * Why `agent` cannot take a session in `role` now: another kind, disabled, or every slot held.
 * Null: it can. Its project is the caller's check (the candidates are already scoped).
 */
export function agentUnfit(
  role: StaffRole,
  agent: StaffCandidate,
): string | null {
  if (agent.kind !== role) {
    return `agent ${agent.id} is a ${agent.kind}, not a ${role}`;
  }
  if (!agent.enabled) return `agent ${agent.id} is disabled`;
  return agent.busy < agent.max_concurrency
    ? null
    : `agent ${agent.id} is at its max_concurrency (${agent.max_concurrency})`;
}

/**
 * The oldest enabled agent of the role below its max_concurrency. In the fleet's scope a binding
 * narrows that to agents on its runner, then on its fallback runner; it never falls through to any
 * other runner, since who runs what is the operator's choice (§9.8). In a project's scope that
 * choice is already made — the project's own agents, on whichever runners it mixes — so the
 * binding does not narrow them. Null: none qualifies.
 */
export function pickAgent<A extends StaffCandidate>(
  role: StaffRole,
  binding: StaffBinding | null,
  agents: readonly A[],
  scope: StaffScope,
): A | null {
  const free = agents
    .filter((a) => agentUnfit(role, a) === null)
    .toSorted(oldestFirst);
  if (binding === null || scope === "project") return free[0] ?? null;
  const on = (runner: string | null) =>
    runner === null ? undefined : free.find((a) => a.runner_id === runner);
  return on(binding.runner_id) ?? on(binding.fallback_runner_id) ?? null;
}
