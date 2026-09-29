import { decide } from "./decide.js";
import type { TicketStatus } from "./statuses.js";
import { outgoing, type Edge } from "./table.js";
import type {
  Actor,
  LawFacts,
  LawTicket,
  NoteField,
  TransitionInput,
  TransitionOption,
} from "./types.js";

// What the GUI may offer (contract 8): decide, run per outgoing row, so the options can never
// disagree with the POST. Notes are assumed given (the form collects them); a deferred diff is
// shown as allowed-but-checked-on-submit.

/** The notes a form will collect, assumed present when listing options. */
export const ASSUMED_INPUT: TransitionInput = {
  reason: "(given on submit)",
  override_note: "(given on submit)",
};

export interface LawView {
  readonly ticket: LawTicket;
  readonly actor: Actor;
  readonly facts: LawFacts;
}

const notesOf = (edge: Edge, actor: Actor): NoteField[] =>
  edge.requires.flatMap((r): NoteField[] => {
    if (r.kind === "note") return ["reason"];
    return r.kind === "qa_passed" && actor.kind === "operator"
      ? ["override_note"]
      : [];
  });

function toOption(to: TicketStatus, edge: Edge, v: LawView): TransitionOption {
  const d = decide({ ...v, to, input: ASSUMED_INPUT });
  if (!d.allowed && d.reason !== "facts_deferred") {
    return {
      to,
      rule: d.rule,
      allowed: false,
      reason: d.reason,
      detail: d.detail,
    };
  }
  const input = notesOf(edge, v.actor);
  return {
    to,
    rule: d.rule,
    allowed: true,
    ...(d.allowed ? {} : { deferred: ["no_source_changes"] as const }),
    ...(input.length > 0 ? { input } : {}),
  };
}

export const allowedTransitions = (v: LawView): TransitionOption[] =>
  outgoing(v.ticket.status, v.facts.priorStatus, v.actor.kind)
    // An endpoint-guarded edge (split, §7.5) has its own route; decide() refuses it on /transition
    // for everyone, so offering it here can only ever be a dead option on the form.
    .filter(({ edge }) => !edge.requires.some((r) => r.kind === "endpoint"))
    // A row only the supervisor takes (`merge_close`) has no API door at all, so it is
    // never an option on anyone's form: a disabled "done" at qa_harness would only be noise.
    .filter(
      ({ edge }) =>
        v.actor.kind === "supervisor" ||
        edge.actors.some((a) => a !== "supervisor"),
    )
    .map(({ to, edge }) => toOption(to, edge, v));
