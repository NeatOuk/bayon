// §10.3 evidence has one definition, core's GateEvidence: a gate without it cannot count as passed.
import { GateEvidence } from "../gates/schemas.js";
import { unmergedReason } from "./merge.js";
import { currentRound, gateWhenHolds } from "./rounds.js";
import {
  isPerRepoGate,
  type GateKind,
  type RefusalReason,
} from "./statuses.js";
import type { GateWhen, Predicate, Requirement } from "./table.js";
import type { GateFact, GateFacts, LawInput } from "./types.js";

// One check per requirement kind. Each is total: a missing, unavailable or deferred fact fails;
// nothing defaults to pass (M1: gate and QA facts land in M3, so those laws refuse).

export interface Failure {
  readonly reason: RefusalReason;
  readonly detail: string;
}

const fail = (reason: RefusalReason, detail: string): Failure => ({
  reason,
  detail,
});

export const hasText = (text: string | null | undefined): boolean =>
  (text ?? "").trim().length > 0;

const CLOSED_CHILD = new Set(["done", "rejected", "parked"]);

/** The attempt with the highest number, the latest round; undefined when there is none. */
const latestOf = (gates: readonly GateFact[]): GateFact | undefined =>
  gates.reduce<GateFact | undefined>(
    (best, g) => (best === undefined || g.attempt > best.attempt ? g : best),
    undefined,
  );

/**
 * One repo's law for `kind`, over every attempt of it (M3): the latest attempt decides, except that
 * an open finding at a blocking severity on any attempt blocks until it is resolved or waived
 * (§10.3). A waived latest attempt passes, whatever is open: the waive is the explicit decision.
 *
 * Still cross-round on purpose. `nextAttempt` counts up per kind across rounds, so the highest
 * attempt of a kind is always the most recently opened one — this round's, once gatePassed's round
 * guard (023) has established that this round opened one. The blocking-findings scan spans every
 * attempt because §10.3 says an open blocker blocks, whichever round found it.
 */
function gateForRepo(
  kind: GateKind,
  repo: string | null,
  facts: GateFacts,
): Failure | null {
  const attempts = facts.gates.filter(
    (g) => g.kind === kind && g.repoId === repo,
  );
  const latest = latestOf(attempts);
  const where = repo === null ? kind : `${kind} (${repo})`;
  if (latest === undefined) return fail("missing_evidence", `no ${where} gate`);
  if (latest.state === "waived") {
    return hasText(latest.waiveReason)
      ? null
      : fail("gate_not_passed", `${where} was waived without a reason`);
  }
  const blocking = attempts.flatMap((g) =>
    g.openSeverities.filter((s) => facts.blockingSeverities.includes(s)),
  ).length;
  if (blocking > 0) {
    return fail(
      "unresolved_findings",
      `${where} has ${blocking} open finding(s) at ${facts.blockingSeverities.join(", ")}`,
    );
  }
  if (latest.state !== "passed") {
    return fail("gate_not_passed", `${where} is ${latest.state}`);
  }
  return GateEvidence.safeParse(latest.evidence).success
    ? null
    : fail("missing_evidence", `${where} passed without evidence`);
}

/**
 * The repos that each owe a gate of `kind`: the list `gatePassed` loops over, and the one
 * machineStep reads, so a machine step can never count a round complete that the law
 * would still hold for a missing repo. A kind that is not per repo was opened once, repo-less, so
 * that one gate is what is asked for (§3.1) — never one per touched repo, which would look
 * for gates no round opened.
 *
 * `lint_check` asks for the repos its own fact named, which is the list `planRound`
 * opened it for: a repo of the ticket that declares no `repos.lint_cmd` has no lint gate and is
 * owed none, so asking `ticket_repos` here would hold the ticket in code_review for a gate the
 * round deliberately skipped.
 */
export const owedRepos = (
  kind: GateKind,
  facts: Pick<GateFacts, "repos" | "lintRepos">,
): readonly (string | null)[] =>
  !isPerRepoGate(kind)
    ? [null]
    : kind === "lint_check"
      ? facts.lintRepos
      : facts.repos.length > 0
        ? facts.repos
        : [null];

/** The stale-review guard: no gate of `kind` running. The operator's edge supersedes instead. */
function gateIdle(kind: GateKind, i: LawInput): Failure | null {
  if (i.actor.kind === "operator") return null;
  const facts = i.facts.gates;
  if (facts.state === "unavailable") {
    return fail("facts_unavailable", `${kind}: ${facts.detail}`);
  }
  const running = facts.value.gates.filter(
    (g) => g.kind === kind && g.state === "running",
  );
  return running.length === 0
    ? null
    : fail(
        "gate_running",
        `${kind} attempt ${running.map((g) => g.attempt).join(", ")} is still running; wait for it, or ask the operator`,
      );
}

function gatePassed(
  kind: GateKind,
  when: GateWhen,
  i: LawInput,
): Failure | null {
  // A `when` the ticket alone settles is settled first: a trivial ticket's ce_review is not
  // required whether or not the gate facts can be read (M1, where they never could).
  if (when === "non_trivial" && !i.ticket.non_trivial) return null;
  const facts = i.facts.gates;
  if (facts.state === "unavailable") {
    return fail("facts_unavailable", `${kind}: ${facts.detail}`);
  }
  const holds = gateWhenHolds(when, {
    non_trivial: i.ticket.non_trivial,
    multiRepo: facts.value.multiRepo,
    lintRepos: facts.value.lintRepos,
    qaConfigured: facts.value.qaConfigured,
  });
  if (!holds) return null;
  // A conditional gate became required after this round opened (): the round
  // opened no gate of this kind, so there is nothing to pass — and nothing to waive either, since
  // waiveGate takes a gate id and there is no row to name. Say what the way out is instead of
  // leaving the reader at "no gate", which reads like a bug in the round.
  //
  // The question is per ROUND, not per ticket (023). Asking only whether a gate of the kind ever
  // existed let this sequence through: gate on, round 1 opens and passes it, operator turns it off,
  // request_fix -> resubmit opens round 2 without it, the fix moves the workspace, operator turns
  // it back on, pass_review. `gates.some(kind)` was round 1's row, and `gateForRepo`'s latest
  // attempt was its passed gate — so the ticket left code_review on evidence for a commit two
  // rounds old. `ce_review` via `non_trivial` had the identical hole (mark trivial, resubmit, mark
  // non-trivial, pass), which is why this is keyed on `when` and not on the kind.
  //
  // `always` is excluded: a round always opens an `always` gate, so the hole cannot exist for it.
  // The one case where a round opens none is a gate of that kind still running from an earlier
  // round, which gateForRepo already refuses as `gate_not_passed` — the true reason, which firing
  // this guard would replace with a misleading one.
  const round = currentRound(facts.value.gates);
  if (
    when !== "always" &&
    !facts.value.gates.some((g) => g.kind === kind && g.round === round)
  ) {
    return fail(
      "missing_evidence",
      `no ${kind} gate in this ticket's current review round (${round}): ${kind} became required after the round opened, so the round opened none and there is no gate to waive. Take request_fix, then resubmit: the new round opens it.`,
    );
  }
  // Each repo that owes one (owedRepos: the list machineStep reads too).
  for (const repo of owedRepos(kind, facts.value)) {
    const failed = gateForRepo(kind, repo, facts.value);
    if (failed !== null) return failed;
  }
  return null;
}

function qaPassed(i: LawInput): Failure | null {
  if (i.actor.kind === "operator" && hasText(i.input.override_note))
    return null;
  const qa = i.facts.qa;
  if (qa.state === "unavailable")
    return fail("facts_unavailable", `qa: ${qa.detail}`);
  return qa.value.latest === "passed"
    ? null
    : fail(
        "qa_not_passed",
        `the latest qa_run is ${qa.value.latest ?? "missing"}`,
      );
}

/** Every pull request of the ticket merged, in a project that closes on merge. */
function prsMerged(i: LawInput): Failure | null {
  const why = unmergedReason(i.facts.merge);
  return why === null ? null : fail("prs_not_merged", why);
}

function planArtifact(i: LawInput): Failure | null {
  if (!hasText(i.ticket.plan_path))
    return fail("missing_artifact", "plan_path is not set");
  const plan = i.facts.plan;
  if (plan === undefined) {
    return fail("facts_unavailable", "the plan artifact was not checked");
  }
  if (plan.state === "present") return null;
  return fail(
    plan.state === "missing" ? "missing_artifact" : "diff_unverifiable",
    plan.detail,
  );
}

function noSourceChanges(i: LawInput): Failure | null {
  const diff = i.facts.diff;
  if (diff === undefined)
    return fail("facts_unavailable", "the diff was not checked");
  switch (diff.state) {
    case "clean":
      return null;
    case "deferred":
      return fail(
        "facts_deferred",
        "the diff is checked when the transition is submitted",
      );
    case "unverifiable":
      return fail("diff_unverifiable", diff.detail);
    case "dirty": {
      const more = diff.total - diff.paths.length;
      const tail = more > 0 ? ` and ${more} more` : "";
      return fail(
        "source_changes",
        `${diff.total} source file(s) changed: ${diff.paths.join(", ")}${tail}`,
      );
    }
  }
}

function sessionAndWorktree(i: LawInput): Failure | null {
  const live = new Set(
    i.facts.ticketSessions.filter((s) => s.live).map((s) => s.id),
  );
  if (live.size === 0) {
    return fail("no_session", `no live session holds ticket ${i.ticket.id}`);
  }
  const materialized = i.facts.worktrees.some(
    (w) => w.active && live.has(w.sessionId ?? ""),
  );
  return materialized
    ? null
    : fail(
        "no_worktree",
        `no active worktree of a live session on ticket ${i.ticket.id}`,
      );
}

function childrenClosed(i: LawInput): Failure | null {
  const open = i.facts.children.filter((c) => !CLOSED_CHILD.has(c.status));
  return open.length === 0
    ? null
    : fail(
        "children_open",
        `${open.length} child ticket(s) still open: ${open.map((c) => c.id).join(", ")}`,
      );
}

function noActiveWorktree(i: LawInput): Failure | null {
  const active = i.facts.worktrees.filter((w) => w.active);
  return active.length === 0
    ? null
    : fail(
        "worktree_active",
        `the parent still holds active worktree(s): ${active.map((w) => w.id).join(", ")}`,
      );
}

function enteredFromHumanQa(i: LawInput): Failure | null {
  const prior = i.facts.priorStatus;
  return prior === "qa_human"
    ? null
    : fail(
        "not_from_human_qa",
        `rework was entered from ${prior ?? "unknown"}; only a failed human QA returns to building`,
      );
}

const PREDICATES: Readonly<Record<Predicate, (i: LawInput) => Failure | null>> =
  {
    no_source_changes: noSourceChanges,
    session_and_worktree: sessionAndWorktree,
    children_closed: childrenClosed,
    no_active_worktree: noActiveWorktree,
    entered_from_human_qa: enteredFromHumanQa,
  };

/** null when `req` holds for `i`, else why not. */
export function checkRequirement(
  req: Requirement,
  i: LawInput,
): Failure | null {
  switch (req.kind) {
    case "gate_passed":
      return gatePassed(req.gate, req.when, i);
    case "gate_idle":
      return gateIdle(req.gate, i);
    case "qa_passed":
      return qaPassed(i);
    case "prs_merged":
      return prsMerged(i);
    case "artifact":
      return planArtifact(i);
    case "predicate":
      return PREDICATES[req.name](i);
    case "note":
      return hasText(i.input.reason)
        ? null
        : fail("missing_note", "this transition needs a reason");
    case "endpoint":
      // Never name a door that was not built: §7.5 auto-split is deferred past M4, so there is no
      // split endpoint to send anyone to.
      return fail(
        "illegal_transition",
        "splitting a ticket is not built yet: the watchdog asks the operator instead",
      );
  }
}
