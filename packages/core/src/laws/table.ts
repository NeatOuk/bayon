import {
  TICKET_STATUSES,
  isTerminal,
  type ActorKind,
  type GateKind,
  type TicketStatus,
} from "./statuses.js";

// The transition table of §3.2 (M1 contract 2), as data: each edge lists who may take it and
// what it requires. The laws are here and in the server, never only in a prompt (§10.3).

export type Predicate =
  | "no_source_changes"
  | "session_and_worktree"
  | "children_closed"
  | "no_active_worktree"
  | "entered_from_human_qa";

/**
 * When a gate is opened, and when it is required. `multi_repo` is `parity_check`'s (§10.3's
 * "required when workspace kind != 'single'"): the fact behind it also carries the operator's
 * `gates.parity_check` switch, so while that is off — its default — nothing opens the gate and
 * nothing waits for it. One fact answers both questions, which is what keeps a round and an edge
 * from disagreeing about a gate and stalling the ticket between them.
 */
export type GateWhen =
  | "always"
  | "non_trivial"
  | "multi_repo"
  /**
   * `lint_check`'s, built exactly as `multi_repo` is: `gates.lint_check` on **and** the
   * ticket's workspace declaring a `repos.lint_cmd` for the job to run. The second half is what
   * makes the switch safe to flip — a fleet that has configured no lint command has nothing for the
   * gate to run, so turning it on changes nothing rather than stalling every ticket behind a job
   * with no command.
   */
  | "lint_configured"
  /**
   * `qa_harness`'s: the ticket's project has `workspaces.qa_mode = 'command'`, so there
   * is a harness command to run — or, `'ci'`, so there are pull request checks to
   * wait on (the gate then opens with the `pull_request` subject: `RoundInput.qaCi`). `none` and `pending` are both false — `pending` means Bayon has
   * been asked to *build* a harness, which is not the same as having one — and then no gate opens,
   * nothing waits for one, and `pass_harness` stays the operator's override with a note, exactly as
   * it was. No fleet-wide switch beside it, unlike the two above: configuring a harness on a
   * project *is* asking for it.
   */
  | "qa_configured";

export type Requirement =
  | {
      readonly kind: "gate_passed";
      readonly gate: GateKind;
      readonly when: GateWhen;
    }
  /**
   * No gate of `gate` is running (the stale-review guard, M3). The operator is exempt: its edge
   * supersedes the running gates instead (`Edge.supersede`).
   */
  | { readonly kind: "gate_idle"; readonly gate: GateKind }
  | { readonly kind: "qa_passed"; readonly override: "operator_note" }
  /**
   * Every pull request the ticket's delivery opened has merged, and its project closes on merge
   *. Read from `deliveries` and `workspaces.close_on_merge`; core's `prsMerged`.
   */
  | { readonly kind: "prs_merged" }
  | { readonly kind: "artifact"; readonly field: "plan_path" }
  | { readonly kind: "predicate"; readonly name: Predicate }
  | { readonly kind: "note"; readonly field: "reason" }
  | { readonly kind: "endpoint"; readonly name: "split" };

/** Columns that move with the status (planTransition turns them into the writer's patch). */
export interface EdgeEffects {
  readonly needsHuman?: true;
  readonly setBlocked?: true;
  readonly clearBlocked?: true;
  readonly close?: true;
}

/** A gate an edge opens a round of (M3 amendment h), and when. */
export interface GateOpen {
  readonly gate: GateKind;
  readonly when: GateWhen;
}

/** What an edge does to gates, in its own transaction (M3): rounds it opens, running gates it fails. */
export interface EdgeGates {
  readonly opens: readonly GateOpen[];
  /** Running gates of these kinds (or every kind) end `failed{superseded}`. */
  readonly supersede: readonly GateKind[] | "all";
}

/**
 * Where an edge lands when the review it would have opened is not required (M3 amendment c).
 * A status whose only way on needs that gate is a waiting room, so an edge that opens no such gate
 * carries the ticket past it in the same move instead of parking it there for nobody to collect.
 */
export interface EdgeAdvance {
  readonly whenNoGate: GateKind;
  readonly to: TicketStatus;
}

export interface Edge {
  readonly rule: string;
  /** `*`: any status but done, rejected and the target. */
  readonly from: TicketStatus | "*";
  /** `@prior`: the status the ticket was in before the current one. */
  readonly to: TicketStatus | "@prior";
  readonly actors: readonly ActorKind[];
  /** A worker may take it on its own ticket only. */
  readonly ownOnly: boolean;
  readonly requires: readonly Requirement[];
  readonly effects: EdgeEffects;
  readonly gates: EdgeGates;
  /** Set when the edge's `to` is only passable with a gate this edge may not open. */
  readonly advance?: EdgeAdvance;
}

const STAFF: readonly ActorKind[] = ["operator", "orchestrator"];
const ANY: readonly ActorKind[] = ["operator", "orchestrator", "worker"];
const OPERATOR: readonly ActorKind[] = ["operator"];
/** `block` admits the supervisor too: the circuit breaker (§13.2, rule 2). */
const BLOCKERS: readonly ActorKind[] = [...ANY, "supervisor"];
/**
 * The machine steps: the edges a gate's decision settles, which the supervisor takes
 * through advanceTicket in the decision's own transaction (core's `machineStep` says which). These
 * five and `block` are the only rows that admit it; every other row, the owner-only ones included,
 * refuses it `actor_not_allowed`.
 */
const MACHINE: readonly ActorKind[] = [...ANY, "supervisor"];
/**
 * `merge_close`: the supervisor alone. A merge is a fact only the pull-request sweep
 * reads from the forge, and the operator already has its own ways into `done` from each of these
 * statuses (`pass_human_qa`, `finish_rework`) or none by design (`qa_harness`, which QA leaves).
 */
const SUPERVISOR_ONLY: readonly ActorKind[] = ["supervisor"];
/** The statuses a merged pull request closes a ticket from: after review, before done. */
export const MERGE_STATUSES = ["qa_harness", "qa_human", "rework"] as const;
const NONE: EdgeEffects = {};
const CLOSE: EdgeEffects = { close: true };
const NO_GATES: EdgeGates = { opens: [], supersede: [] };
/**
 * The code review round: code_review always, ce_review when non-trivial, parity_check once,
 * repo-less, for a multi-repo workspace whose operator has turned the gate on (§10.3), and
 * lint_check where a repo declares a lint command and the operator has turned that gate on
 *.
 */
const REVIEW_ROUND: EdgeGates = {
  opens: [
    { gate: "code_review", when: "always" },
    { gate: "ce_review", when: "non_trivial" },
    { gate: "parity_check", when: "multi_repo" },
    { gate: "lint_check", when: "lint_configured" },
  ],
  supersede: [],
};
/**
 * The kinds a review round owns: a fix, a resubmit or a pass ends the ones still running.
 *
 * Hand-written, and one of three hand-written lists of the same concept — `REVIEW_ROUND.opens`
 * above, and `ROUND_GATE_KINDS` in gates/roles.ts. A kind added to those two and missed here would
 * be opened by a round and retried after a restart, and superseded by neither `request_fix` nor
 * `pass_review`: orphan-reviewer bug again, with nothing failing. Exported so
 * `table.test.ts` can hold the three against each other rather than reading this one on both sides
 * of an assertion.
 */
export const ROUND_KINDS: readonly GateKind[] = [
  "code_review",
  "ce_review",
  "parity_check",
  "lint_check",
];
/**
 * `pass_review` closes the round, so it leaves none of the round's gates running.
 * The required ones cannot be running — a running latest attempt is `gate_not_passed` — but one
 * that stopped being required while it ran can: `gates.parity_check` turned off, or a ticket
 * marked trivial after its ce_review opened. Without this the ticket advances to `qa_harness`
 * while a gate and its session run on to the wall clock, and `request_fix` (which is held to
 * `gate_idle` for every round kind) is then blocked by the orphan it left behind.
 *
 * And in the same move it opens the QA round for the status it lands in: one
 * `qa_harness` gate, repo-less, for a project that has a harness command. The gate is opened by the
 * edge that *enters* `qa_harness` rather than by a later one, because `pass_harness` and
 * `fail_harness` are the only ways out of that status and both read the round's gates — a gate
 * opened any later would be a gate nothing waits for.
 */
const CLOSE_ROUND_OPEN_QA: EdgeGates = {
  opens: [{ gate: "qa_harness", when: "qa_configured" }],
  supersede: ROUND_KINDS,
};
/**
 * Both ways out of `qa_harness` leave no harness running (the review's MEDIUM).
 *
 * The machine steps can never need it: `harnessStep` waits while a `qa_harness` gate runs, so their
 * supersede set is always empty in practice. The **operator's override** is what this is for — a
 * `pass_harness` with a note, taken while the harness is still running, used to move the ticket to
 * `qa_human` and leave the gate `running` and its job burning a slot until the wall clock. Now the
 * gate is failed `superseded` and `stopGateSessionsIn` stops the job, exactly as `park` and `reject`
 * already do for every gate.
 */
const CLOSE_QA: EdgeGates = { opens: [], supersede: ["qa_harness"] };
const SUPERSEDE_ALL: EdgeGates = { opens: [], supersede: "all" };
const idle = (g: GateKind): Requirement => ({ kind: "gate_idle", gate: g });

const predicate = (name: Predicate): Requirement => ({
  kind: "predicate",
  name,
});
const gate = (g: GateKind, when: GateWhen): Requirement => ({
  kind: "gate_passed",
  gate: g,
  when,
});

const row = (
  rule: string,
  from: Edge["from"],
  to: Edge["to"],
  actors: readonly ActorKind[],
  requires: readonly Requirement[],
  effects: EdgeEffects,
  gates: EdgeGates = NO_GATES,
  advance?: EdgeAdvance,
): Edge => ({
  rule,
  from,
  to,
  actors,
  ownOnly: actors.includes("worker"),
  requires,
  effects,
  gates,
  ...(advance === undefined ? {} : { advance }),
});

export const EDGES: readonly Edge[] = [
  row("prioritize", "backlog", "prioritized", STAFF, [], NONE),
  row("staff", "prioritized", "staffed", STAFF, [], NONE),
  row(
    "start_spike",
    "staffed",
    "spiking",
    ANY,
    [predicate("session_and_worktree")],
    NONE,
  ),
  row(
    "submit_plan",
    "spiking",
    "plan_review",
    ANY,
    [{ kind: "artifact", field: "plan_path" }, predicate("no_source_changes")],
    NONE,
    { opens: [{ gate: "plan_review", when: "non_trivial" }], supersede: [] },
    // The only way out of plan_review is approve_plan, which waits on the plan_review gate. A
    // trivial ticket opens none (M3 amendment c), so it would wait there for a review nobody owes
    // it — the dogfood stall of an earlier change. Then the plan is approved as it is submitted.
    { whenNoGate: "plan_review", to: "planned" },
  ),
  row(
    "approve_plan",
    "plan_review",
    "planned",
    MACHINE,
    [gate("plan_review", "non_trivial")],
    NONE,
  ),
  // M3 amendment c: back to the plan after its review; the next submit_plan opens attempt n+1.
  row(
    "revise_plan",
    "plan_review",
    "spiking",
    ANY,
    [idle("plan_review")],
    NONE,
    { opens: [], supersede: ["plan_review"] },
  ),
  row("start_build", "planned", "building", ANY, [], NONE),
  row("ask_human", "building", "prioritized", STAFF, [], { needsHuman: true }),
  row("request_review", "building", "code_review", ANY, [], NONE, REVIEW_ROUND),
  row(
    "request_fix",
    "code_review",
    "review_fix",
    MACHINE,
    ROUND_KINDS.map(idle),
    NONE,
    { opens: [], supersede: ROUND_KINDS },
  ),
  row("resubmit", "review_fix", "code_review", ANY, [], NONE, REVIEW_ROUND),
  row(
    "pass_review",
    "code_review",
    "qa_harness",
    MACHINE,
    [
      gate("code_review", "always"),
      gate("ce_review", "non_trivial"),
      gate("parity_check", "multi_repo"),
      gate("lint_check", "lint_configured"),
    ],
    NONE,
    CLOSE_ROUND_OPEN_QA,
  ),
  row(
    "pass_harness",
    "qa_harness",
    "qa_human",
    MACHINE,
    [{ kind: "qa_passed", override: "operator_note" }],
    NONE,
    CLOSE_QA,
  ),
  row("fail_harness", "qa_harness", "rework", MACHINE, [], NONE, CLOSE_QA),
  row(
    "fail_human_qa",
    "qa_human",
    "rework",
    OPERATOR,
    [{ kind: "note", field: "reason" }],
    NONE,
  ),
  row(
    "pass_human_qa",
    "qa_human",
    "done",
    OPERATOR,
    [predicate("children_closed")],
    CLOSE,
  ),
  row(
    "rebuild",
    "rework",
    "building",
    ANY,
    [predicate("entered_from_human_qa")],
    NONE,
  ),
  row(
    "finish_rework",
    "rework",
    "done",
    OPERATOR,
    [predicate("children_closed")],
    CLOSE,
  ),
  // M8.2: every pull request of the ticket merged on the forge, in a project that closes
  // on merge. One row per status it leaves from, each after the operator's own row for the same
  // pair, so `resolveEdge` gives the operator its row and the supervisor this one. A harness still
  // running is superseded: the change it was checking has already shipped.
  ...MERGE_STATUSES.map((from) =>
    row(
      "merge_close",
      from,
      "done",
      SUPERVISOR_ONLY,
      [{ kind: "prs_merged" }, predicate("children_closed")],
      CLOSE,
      from === "qa_harness" ? CLOSE_QA : NO_GATES,
    ),
  ),
  row("block", "*", "blocked", BLOCKERS, [], { setBlocked: true }),
  row("unblock", "blocked", "@prior", STAFF, [], { clearBlocked: true }),
  // Plan rule 3: a hand-off never moves tickets.status, so only the operator takes these (M1).
  // An operator release out of review never leaves a reviewer running.
  row("release", "*", "handoff_pending", OPERATOR, [], NONE, SUPERSEDE_ALL),
  row("reclaim", "handoff_pending", "@prior", OPERATOR, [], NONE),
  row("park", "*", "parked", STAFF, [], NONE, SUPERSEDE_ALL),
  row("unpark", "parked", "backlog", STAFF, [], NONE),
  // M4 amendment: done is otherwise only reachable down the QA path, so work finished
  // outside it — a branch the operator reviewed and merged — would rest at `parked`, which means set
  // aside, not finished. The operator alone may say it is done, and must say why.
  row(
    "close_out",
    "parked",
    "done",
    OPERATOR,
    [
      { kind: "note", field: "reason" },
      predicate("children_closed"),
      predicate("no_active_worktree"),
    ],
    CLOSE,
  ),
  row("reject", "*", "rejected", STAFF, [], CLOSE, SUPERSEDE_ALL),
  row(
    "split",
    "*",
    "split",
    STAFF,
    [{ kind: "endpoint", name: "split" }],
    NONE,
    SUPERSEDE_ALL,
  ),
  row(
    "close_split",
    "split",
    "done",
    STAFF,
    [predicate("children_closed"), predicate("no_active_worktree")],
    CLOSE,
  ),
];

/**
 * The edge from `from` to `to`: an exact row (with `@prior` resolved) wins over a `*` row. Two exact
 * rows share a pair only where they admit different actors (`pass_human_qa` and `merge_close`,
 *): the first that admits `actor` is the one, and with no actor, or none that admits it,
 * the first — so an actor who may take neither is refused by the pair's original row, as before.
 */
export function resolveEdge(
  from: TicketStatus,
  to: TicketStatus,
  prior: TicketStatus | null,
  actor?: ActorKind,
): Edge | undefined {
  const exact = EDGES.filter(
    (edge) =>
      edge.from === from &&
      (edge.to === to || (edge.to === "@prior" && prior === to)),
  );
  const mine =
    actor === undefined
      ? undefined
      : exact.find((edge) => edge.actors.includes(actor));
  const found = mine ?? exact[0];
  if (found !== undefined) return found;
  if (isTerminal(from) || from === to) return undefined;
  return EDGES.find((edge) => edge.from === "*" && edge.to === to);
}

/** Every target reachable from `from` in one edge, in status order, with its edge. */
export const outgoing = (
  from: TicketStatus,
  prior: TicketStatus | null,
  actor?: ActorKind,
): { readonly to: TicketStatus; readonly edge: Edge }[] =>
  TICKET_STATUSES.flatMap((to) => {
    const edge = resolveEdge(from, to, prior, actor);
    return edge === undefined ? [] : [{ to, edge }];
  });
