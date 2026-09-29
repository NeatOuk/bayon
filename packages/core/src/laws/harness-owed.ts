import { CI_PR_STATES } from "../gates/ci.js";
import { roundOf, type MachineInput } from "./machine.js";
import type { GateKind } from "./statuses.js";
import { EDGES, type GateOpen } from "./table.js";
import type { DeliveryFact } from "./types.js";

// The QA gate a ticket already at `qa_harness` is owed. `pass_review` opens it as the
// ticket enters the status, so a ticket that crossed `pass_review` while its project ran
// no QA — or before QA existed — sits at `qa_harness` with no gate, and `harnessStep` waits on it for
// ever. Once its project runs QA, the reconciler's machine sweep opens the round `pass_review` would
// have opened (db `openOwedHarness`). Pure over the facts the machine steps read.

const QA: GateKind = "qa_harness";

/**
 * What opens: the `qa_harness` entry of `pass_review`'s own `opens`, read off the table, so the table
 * stays the one list of when a QA gate opens (`when: "qa_configured"`).
 */
export const HARNESS_OPENS: readonly GateOpen[] = EDGES.filter(
  (e) => e.rule === "pass_review",
).flatMap((e) => e.gates.opens.filter((o) => o.gate === QA));

/**
 * A delivered row a CI gate can read: a pull request, in a state the CI sweep reads, at a known
 * head. The same test as the CI sweep's `readyOf` over the stored row; `readyOf` also checks the
 * row's branch is the ticket's and its head is the mirror's current one, which only the supervisor
 * can read — so a row that passes here may still read as "no pull request yet" there, and the gate
 * then waits for the next delivery, as a `pass_review`-opened CI gate does.
 */
const ciReadable = (d: DeliveryFact): boolean =>
  d.prUrl !== null && d.headSha !== null && CI_PR_STATES.has(d.state);

export interface HarnessOwedInput extends MachineInput {
  /** The project's QA is its CI (`qa_mode = 'ci'`): the gate would wait on a pull request. */
  readonly qaCi: boolean;
}

export type HarnessOwed =
  { readonly owed: true } | { readonly owed: false; readonly why: string };

const not = (why: string): HarnessOwed => ({ owed: false, why });

/**
 * Owed exactly when the ticket is at `qa_harness`, its project runs QA (`qaConfigured`), no QA gate
 * runs, its current round holds no QA gate — decided or not: one already there is never reopened
 * here, a rerun stays the operator's — and, for a CI project, every delivered repo has a pull
 * request at a known head for the gate to read (`ciReadable`). A CI gate with none records nothing until its deadline and then fails as infra,
 * which is a gate opened only to fail.
 */
export function harnessOwed(i: HarnessOwedInput): HarnessOwed {
  if (i.ticket.status !== "qa_harness") {
    return not(`${i.ticket.status} is not qa_harness`);
  }
  if (!i.gates.qaConfigured) {
    return not("the ticket's project runs no QA harness");
  }
  const { running, latest } = roundOf(i.gates, [QA]);
  if (running.length > 0) return not("a qa_harness gate is running");
  if (latest.length > 0) {
    return not("the round already has its qa_harness gate");
  }
  // Every delivered repo, not some: the CI gate judges each repo's pull request and waits while any
  // is missing, so one repo's request with another's still pending is a gate opened only to wait.
  const { deliveries } = i.merge;
  const readable = deliveries.length > 0 && deliveries.every(ciReadable);
  if (i.qaCi && !readable) {
    return not(
      "the project's QA is its CI, and not every delivered repo has a pull request at a known head for it to read",
    );
  }
  return { owed: true };
}
