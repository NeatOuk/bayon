import type { GateFailReason } from "../gates/schemas.js";
import type { MachineRule } from "../laws/machine.js";

// The sentences a ticket's next step is told in: one place, so the ticket page's line and
// the board card's short reason say the same thing in the same words.

/** A reason's most characters: one line in the ticket header. */
export const REASON_MAX = 160;

/** `text` on one line in at most `max` characters; a cut ends in "…". */
export function cap(text: string, max: number = REASON_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export const plural = (n: number, noun: string): string =>
  `${n} ${noun}${n === 1 ? "" : "s"}`;

const pausedWho = (scope: "fleet" | "project"): string =>
  scope === "fleet" ? "Fleet" : "Project";

export const SAY = {
  answers: (n: number) => `Waiting on your answer to ${plural(n, "question")}`,
  proposal: "Waiting on your approval of a staffing proposal",
  flagged: "Flagged needs human: look at it, then clear the flag",
  blocked: (reason: string | null) => `Blocked: ${reason ?? "no reason given"}`,
  parked: (note: string | null) => `Parked: ${note ?? "no note given"}`,
  splitClosable: "Its child tickets are closed: close the split",
  released: "Released: reclaim it to go on",
  /** Its pulse runs only when other work is due (§9.7's no-op check): a backlog ticket is not. */
  prioritise:
    "Waiting for the orchestrator to prioritise it (it wakes only when other work is due)",
  prioritiseYourself: "No orchestrator in this project: prioritise it yourself",
  staffYourself: (who: string) =>
    `No orchestrator in this project: staff ${who} yourself`,
  staff: (lead: string, who: string) =>
    `${lead}: waiting for the orchestrator to staff ${who}`,
  /** A reviewer's session on it is still live, so staffing refuses until it ends. */
  reviewerFinishing:
    "A reviewer is still finishing on this ticket: wait for it",
  /** Staffed, its spawn queued and no session row yet. */
  startingFor: (agent: string) => `Starting a session for ${agent}…`,
  /** An idle holder whose runner is a script: no model work, so idle is its end. */
  scriptIdle: (agent: string, turns: number) =>
    `${agent} is idle after turn ${turns}: its runner is a test script that does no real work, so this is where it stops`,
  humanQa: "Waiting on your human QA: pass it, or fail it with a reason",
  qaNote: "QA needs your note (no QA harness configured)",
  /** A CI gate waits for a pull request at the reviewed commit. */
  ciAwaitingPr: "Waiting for the PR to be opened",
  /** A CI gate reads the checks on the pull request. */
  ciRunning: (done: number, total: number) =>
    total === 0
      ? "CI running on the PR (no checks reported yet)"
      : `CI running on the PR (${done} of ${total} checks done)`,
  paused: (scope: "fleet" | "project") =>
    `${pausedWho(scope)} is paused: nothing new starts until you resume it`,
  /** A wait the pause holds, and what comes once it lifts. */
  pausedThen: (scope: "fleet" | "project", next: string) =>
    `${pausedWho(scope)} is paused. Next: ${next}`,
  notMoving: (name: string) => `${name} is not moving`,
  /** The drift cap: the machine stopped sending the round back; after the gate's name. */
  driftCapped: (rounds: number) =>
    `stopped: the base moved in ${rounds} rounds running, so you decide`,
  /** Every pull request is open, and a merge closes the ticket. */
  awaitingMerge: (urls: readonly string[]) =>
    urls.length > 1
      ? `Waiting for ${urls.length} PRs to be merged: ${urls.join(" ")}`
      : ["Waiting for the PR to be merged", ...urls].join(": "),
} as const;

/** What a machine step means, before "foreman moves it to <status> on its own". */
export const MACHINE_LEAD: Readonly<Record<MachineRule, string>> = {
  approve_plan: "Plan review passed",
  pass_review: "Review passed",
  request_fix: "Review failed on blocking findings",
  pass_harness: "QA passed",
  fail_harness: "QA failed on blocking findings",
  merge_close: "Its pull requests merged",
};

/**
 * `request_fix`'s lead when the round's base moved: the fix round brings the branch up to
 * date, so "failed on blocking findings" would name the wrong reason.
 */
export const DRIFT_LEAD = "Review stopped: the base branch moved";

/** What happened to a gate that failed for `reason`, after its name: "Review can't run: …". */
export const HAPPENED: Readonly<Record<GateFailReason, string>> = {
  no_reviewer: "can't run: no eligible reviewer",
  reviewer_error: "failed: the reviewer broke",
  timeout: "timed out",
  supervisor_restart: "was cut short by a restart",
  missing_evidence: "failed: its evidence did not pass the schema",
  base_drift: "stopped: the base branch moved, so send it back to fix",
  source_changes: "failed: the plan changed source files",
  blocking_findings: "failed on blocking findings",
  superseded: "was superseded",
};
