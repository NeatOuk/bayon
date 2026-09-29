import { CI_SUBJECT } from "../gates/ci.js";
import { isPerRepoGate, type GateKind, type TicketStatus } from "./statuses.js";
import type { EdgeAdvance, EdgeGates, GateOpen, GateWhen } from "./table.js";

// A transition's gate effects (M3 amendment h), planned from the rows the writer reads inside its
// transaction: which running gates it supersedes, and which gates it opens. A round opens every
// touched repo at one shared attempt number; a kind already running opens nothing new.

/** The gates columns a plan reads: a `gates` row satisfies it as it is. */
export interface RoundGateFact {
  readonly id: string;
  readonly kind: string;
  readonly repo_id: string | null;
  readonly attempt: number;
  /** `gates.round` (023): the review round that opened it. */
  readonly round: number;
  readonly state: string;
}

/**
 * What a gate reviews: a plan document, one repo's diff, or the whole workspace. `workspace` is
 * `parity_check`'s: the subject is the ticket's workspace, not a repo's range, so H3 —
 * which refuses a repo-less **diff** gate whose worktrees span repos — does not apply to it, and
 * `subjectWorktree` falls back to the primary repo, the right place to read the tree from.
 * `pull_request` is a CI project's `qa_harness` (core `CI_SUBJECT`): the checks the forge
 * reports on the ticket's pull request, which nothing launches and only the CI sweep decides.
 */
export type GateSubjectKind = "plan" | "diff" | "workspace" | typeof CI_SUBJECT;

/** One gate row to insert, `running`. */
export interface RoundGate {
  readonly kind: GateKind;
  readonly repo_id: string | null;
  readonly attempt: number;
  /** The review round it belongs to (023): `nextRound`, or an existing one for a rerun. */
  readonly round: number;
  readonly subject_kind: GateSubjectKind;
  readonly subject_ref: string;
}

/** A diff's subject until the gate engine pins base..head (decideGate writes it). */
export const UNPINNED = "unpinned";

export interface RoundTicket {
  readonly non_trivial: boolean;
  readonly plan_path: string | null;
}

export interface RoundInput {
  readonly opens: readonly GateOpen[];
  readonly ticket: RoundTicket;
  readonly gates: readonly RoundGateFact[];
  /** `ticket_repos`; empty means one repo-less gate. */
  readonly repos: readonly string[];
  /**
   * §10.3's "required when workspace kind != 'single'" **and** `gates.parity_check` on (020 seeds
   * it off). One fact, because the same one answers `pass_review`'s requirement: while it
   * is false, `when: "multi_repo"` opens nothing and blocks nothing, so the two can never disagree
   * and leave a ticket waiting for a gate no round opened.
   */
  readonly multiRepo: boolean;
  /**
   * What `when: "lint_configured"` reads: the repos whose `repos.lint_cmd`
   * a `lint_check` would run, empty when `gates.lint_check` is off or none declares one. `[null]`
   * is the repo-less gate a ticket with no `ticket_repos` opens. One fact for the round and for the
   * edge, for the reason `multiRepo` gives — a gate a round opens and no edge requires, or the
   * reverse, stalls the ticket between them — and a **list** because `lint_check` is per repo:
   * a flag read for one repo opens gates on repos whose command it never looked at.
   */
  readonly lintRepos: readonly (string | null)[];
  /**
   * What `when: "qa_configured"` reads: the ticket's project has a harness command. One
   * fact for the round and for the edge, for the reason `multiRepo` gives.
   */
  readonly qaConfigured: boolean;
  /**
   * The project's QA is its CI (`qa_mode = 'ci'`): a `qa_harness` gate opens with the
   * `pull_request` subject, the mark it keeps whatever the project's mode later becomes. Read from
   * the same `qa_mode` as `qaConfigured`.
   */
  readonly qaCi: boolean;
  /** Open for this repo only (a rerun). */
  readonly only?: { readonly repo_id: string | null };
}

/** The next attempt of `kind` on the ticket: one past the highest, across every repo. */
export const nextAttempt = (
  kind: string,
  gates: readonly RoundGateFact[],
): number =>
  1 +
  gates
    .filter((g) => g.kind === kind)
    .reduce((max, g) => Math.max(max, g.attempt), 0);

/**
 * The ticket's current review round: the highest any of its gates carries, 0 when it has none
 * (023). A ticket whose rounds all predate the migration reads 1, the backfill, so
 * every gate it has is in its current round and the laws see what they saw before.
 */
export const currentRound = (
  /** Any gate fact with a round: `RoundGateFact` for a writer, `GateFact` for a law. */
  gates: readonly { readonly round: number }[],
): number => gates.reduce((max, g) => Math.max(max, g.round), 0);

/** The round a new batch of gates opens: one past the ticket's current one. */
export const nextRound = (
  gates: readonly { readonly round: number }[],
): number => currentRound(gates) + 1;

/** The subject a new gate of `kind` starts with; `qaCi` makes a `qa_harness` a CI gate. */
export const subjectOf = (
  kind: GateKind,
  ticket: RoundTicket,
  qaCi = false,
): Pick<RoundGate, "subject_kind" | "subject_ref"> => {
  if (kind === "qa_harness" && qaCi) {
    return { subject_kind: CI_SUBJECT, subject_ref: UNPINNED };
  }
  switch (kind) {
    case "plan_review":
      return { subject_kind: "plan", subject_ref: ticket.plan_path ?? "" };
    // `qa_harness` joins parity here: the harness is the project's one command over the
    // whole workspace, not one repo's range, so H3 — which refuses a repo-less *diff* gate whose
    // worktrees span repos — does not apply, and `subjectWorktree` pins the primary, which is the
    // right tree to run it in.
    case "parity_check":
    case "qa_harness":
      return { subject_kind: "workspace", subject_ref: UNPINNED };
    default:
      return { subject_kind: "diff", subject_ref: UNPINNED };
  }
};

/** The ticket facts every `GateWhen` is judged on. */
export interface WhenFacts {
  readonly non_trivial: boolean;
  readonly multiRepo: boolean;
  /** The repos a `lint_check` opens for; empty means the gate is not in force. */
  readonly lintRepos: readonly (string | null)[];
  /** The ticket's project runs a QA harness: `workspaces.qa_mode = 'command'`. */
  readonly qaConfigured: boolean;
}

/** Whether the ticket's facts satisfy a `GateOpen.when` / `gate_passed.when`. */
export const gateWhenHolds = (when: GateWhen, facts: WhenFacts): boolean => {
  switch (when) {
    case "always":
      return true;
    case "non_trivial":
      return facts.non_trivial;
    case "multi_repo":
      return facts.multiRepo;
    case "lint_configured":
      return facts.lintRepos.length > 0;
    case "qa_configured":
      return facts.qaConfigured;
  }
};

/** The kind whose per-repo list is its own fact rather than `ticket_repos`. */
const LINT: GateKind = "lint_check";

export function planRound(i: RoundInput): RoundGate[] {
  const perRepo: readonly (string | null)[] =
    i.only !== undefined
      ? [i.only.repo_id]
      : i.repos.length > 0
        ? i.repos
        : [null];
  // A rerun (`only`) opens another attempt **inside** the round that is already open: it is the
  // same review asked again, not a new one, so it must not move the ticket's current round — which
  // would leave every other kind of that round looking one round stale to `gatePassed`
  // (023). Everything else opens the next round.
  const round =
    i.only !== undefined ? currentRound(i.gates) : nextRound(i.gates);
  return i.opens.flatMap((open) => {
    const holds = gateWhenHolds(open.when, {
      non_trivial: i.ticket.non_trivial,
      multiRepo: i.multiRepo,
      lintRepos: i.lintRepos,
      qaConfigured: i.qaConfigured,
    });
    if (!holds) return [];
    const running = i.gates.some(
      (g) => g.kind === open.gate && g.state === "running",
    );
    if (running) return [];
    const attempt = nextAttempt(open.gate, i.gates);
    // A kind that is not per repo opens once, repo-less, however many repos the ticket touches:
    // parity is a property of the workspace, not of a repo (§3.1). `isPerRepoGate` wins over
    // `only` too (L6): a rerun that named a repo would otherwise open the gate at that
    // repo_id, where `gatePassed` — which always looks for a non-per-repo kind at repo_id = null —
    // could never find it, so the round would open a gate no law would ever see.
    //
    // `lint_check` narrows that further to the repos that declare a `repos.lint_cmd`:
    // the gate runs *that repo's* command, so a repo without one is an explicit skip rather than a
    // gate whose job has nothing to run. `only` still wins — a rerun names one existing gate, and
    // its repo was in the list the round that opened it used.
    const repos = !isPerRepoGate(open.gate)
      ? [null]
      : i.only === undefined && open.gate === LINT
        ? i.lintRepos
        : perRepo;
    return repos.map((repo_id) => ({
      kind: open.gate,
      repo_id,
      attempt,
      round,
      ...subjectOf(open.gate, i.ticket, i.qaCi),
    }));
  });
}

/** What the writer does to gates with a transition. */
export interface GateEffects {
  /** Running gates to fail with reason `superseded`. */
  readonly supersede: readonly string[];
  readonly open: readonly RoundGate[];
}

export const NO_GATE_EFFECTS: GateEffects = { supersede: [], open: [] };

/**
 * Where an advancing edge lands once its gates are known: `null` to stay on the edge's own `to`,
 * or the advance's status when no gate of that kind opened, so the ticket carries on past a status
 * it could never leave (M3 amendment c). Only for an edge that declares an `advance`;
 * the caller checks that, so there is no second, untestable check for it here.
 */
export function advanceStatus(
  advance: EdgeAdvance,
  open: readonly RoundGate[],
): TicketStatus | null {
  const opened = open.some((g) => g.kind === advance.whenNoGate);
  return opened ? null : advance.to;
}

export function planGateEffects(i: {
  readonly edge: EdgeGates;
  readonly ticket: RoundTicket;
  readonly gates: readonly RoundGateFact[];
  readonly repos: readonly string[];
  /** RoundInput.multiRepo: the workspace is multi-repo and `gates.parity_check` is on. */
  readonly multiRepo: boolean;
  /** RoundInput.lintRepos: the repos whose lint command a `lint_check` would run. */
  readonly lintRepos: readonly (string | null)[];
  /** RoundInput.qaConfigured: the ticket's project has a QA harness command. */
  readonly qaConfigured: boolean;
  /** RoundInput.qaCi: the project's QA is its CI, so a QA gate opens as a CI gate. */
  readonly qaCi: boolean;
}): GateEffects {
  const kinds = i.edge.supersede;
  const supersede = i.gates
    .filter(
      (g) =>
        g.state === "running" &&
        (kinds === "all" || kinds.some((k) => k === g.kind)),
    )
    .map((g) => g.id);
  // Superseded gates no longer run, so a round the edge opens is not skipped for them.
  const gone = new Set(supersede);
  const open = planRound({
    opens: i.edge.opens,
    ticket: i.ticket,
    gates: i.gates.map((g) => (gone.has(g.id) ? { ...g, state: "failed" } : g)),
    repos: i.repos,
    multiRepo: i.multiRepo,
    lintRepos: i.lintRepos,
    qaConfigured: i.qaConfigured,
    qaCi: i.qaCi,
  });
  return { supersede, open };
}
