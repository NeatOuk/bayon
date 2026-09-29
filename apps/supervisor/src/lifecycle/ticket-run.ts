// Run 1 of a spawn (§8.2): the operator's prompt through the `operator` template; else, for a
// ticket session (staffing sends no prompt), its run class's template with the mission
// and the ticket, and a successor's hand-off packet directly under the mission (§7.3, M2-c). Every
// question asked on the ticket rides under it with its answer and both times, so the
// session neither asks one again nor has to guess which of two answers came last.
import {
  TEMPLATES,
  ok,
  ticketKey,
  type JsonValue,
  type PromptTemplate,
  type Result,
} from "@bayon/core";
import { getTicket, listTicketQuestions, type TicketQuestion } from "@bayon/db";
import type { Ctx } from "./context.js";
import { ticketKeyPrefix } from "./facts.js";
import { operatorRun, type RunRequest } from "./prompt.js";
import type { Resolved } from "./resolve.js";

/**
 * Staffing's run classes (core staffPlan): spike runs the spike template; build, build_complex
 * and fix the build one (the fix template's required findings come with M3's gates).
 */
const templateOf = (runClass: string): PromptTemplate =>
  runClass === "spike" ? TEMPLATES.spike : TEMPLATES.build;

const iso = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

/** The ticket's questions as the template's `questions` input, oldest first; none: left out. */
export function questionsInput(
  questions: readonly TicketQuestion[],
): JsonValue | undefined {
  if (questions.length === 0) return undefined;
  return questions.map((q) => ({
    asked_at: iso(q.asked_at),
    kind: q.kind,
    question: q.question,
    status: q.status,
    answer: q.answer,
    answered_at: iso(q.answered_at),
  }));
}

/** Run 1, or none: a spawn with neither a prompt nor a ticket waits idle. */
export async function firstRun(
  ctx: Ctx,
  r: Resolved,
): Promise<Result<RunRequest | undefined>> {
  const { payload: p, successor } = r;
  if (successor === null && p.prompt !== undefined) {
    return ok(operatorRun(p.prompt, r.missionText));
  }
  if (p.ticket_id === undefined) return ok(undefined);
  const t =
    successor === null
      ? await getTicket(ctx.db, p.ticket_id)
      : ok(successor.ticket);
  if (!t.ok) return t;
  const prefix = await ticketKeyPrefix(ctx);
  if (!prefix.ok) return prefix;
  const questions = await listTicketQuestions(ctx.db, t.value.id);
  if (!questions.ok) return questions;
  return ok({
    seq: 1,
    trigger: "orchestrator",
    template: templateOf(r.runClass.name),
    inputs: {
      mission: r.missionText ?? undefined,
      handoff_packet: successor?.packet,
      ticket: {
        key: ticketKey(prefix.value, t.value.num),
        title: t.value.title,
        type: t.value.type,
        status: t.value.status,
        body: t.value.body_md,
        acceptance: t.value.acceptance_md,
      },
      questions: questionsInput(questions.value),
      // A successor's spawn may carry a prompt too (never from REST): the current step.
      current_step: p.prompt,
    },
  });
}
