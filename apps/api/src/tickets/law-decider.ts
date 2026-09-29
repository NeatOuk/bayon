import {
  decide,
  err,
  lawRefused,
  ok,
  type Actor,
  type GateSettings,
  type Result,
} from "@bayon/core";
import type { Decide } from "@bayon/db/api";
import type { TransitionRequest } from "@bayon/proto";
import type { GitFacts } from "./git-facts.js";
import { lawFacts, lawTicket, snapshotOf } from "./law-facts.js";

// The §3.2 laws as a writer runs them, inside its transaction over the facts it reads there. Every
// status move the API makes is decided here: a transition, a staffing's `staff` move, and the one an
// approved staffing proposal makes, which is why this is not TicketService's own.

/** The facts a git check produced, as law facts. */
export const gitLaw = (git: GitFacts | undefined) =>
  git === undefined
    ? {}
    : {
        ...(git.plan === undefined ? {} : { plan: git.plan }),
        ...(git.diff === undefined ? {} : { diff: git.diff }),
      };

/** Columns a transition may set with its move (a spike submits its own plan). */
export interface TransitionSet {
  readonly plan_path?: string;
}

/**
 * `decide` for one move, run by the writer inside its transaction. A git check's facts must still
 * describe the ticket's worktrees there (else `diff_unverifiable`), and the laws judge the row as
 * the move leaves it (`set`).
 */
export function lawDecider(
  actor: Actor,
  body: TransitionRequest,
  rule: string,
  git: GitFacts | undefined,
  gateSettings: Result<GateSettings>,
  /** The transition's set columns: the laws judge the row as the move leaves it. */
  set: TransitionSet = {},
): Decide {
  return (facts) => {
    if (git !== undefined) {
      const active = facts
        .worktrees()
        .filter((w) => w.state === "active")
        .map((w) => w.id);
      if (active.toSorted().join("\n") !== git.worktreeIds.join("\n")) {
        return err(
          lawRefused({
            allowed: false,
            rule,
            reason: "diff_unverifiable",
            detail:
              "the ticket's worktrees changed while they were being diffed; retry",
          }),
        );
      }
    }
    const ticket = lawTicket({ ...facts.ticket, ...set });
    if (!ticket.ok) return ticket;
    const decision = decide({
      ticket: ticket.value,
      actor,
      to: body.to,
      input: body,
      facts: {
        ...lawFacts(snapshotOf(facts, actor), gateSettings),
        ...gitLaw(git),
      },
    });
    return decision.allowed ? ok(undefined) : err(lawRefused(decision));
  };
}
