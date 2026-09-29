import type { AgentPulse, CommandView, PulseView } from "@bayon/proto";
import { z } from "zod";
import { formatIdle } from "@/fleet/fleet-model";
import { formatTime, formatUtc } from "@/lib/format";

// How the GUI reads pulses (§9.7, §10.1). The pulses, their checks and next wakes are the server's.

/** A snapshot's rows over the known ones, by id, newest scheduled first. */
export function mergePulses(
  known: readonly PulseView[],
  fresh: readonly PulseView[],
): PulseView[] {
  const byId = new Map([...known, ...fresh].map((pulse) => [pulse.id, pulse]));
  return [...byId.values()].sort(
    (a, b) => b.scheduled_at - a.scheduled_at || b.id.localeCompare(a.id),
  );
}

const Flagged = z.object({ untrusted: z.boolean() });

/** What a check's result says of itself (result_json): true, false, or null if silent. */
export const untrustedOf = (result: unknown): boolean | null => {
  const flagged = Flagged.safeParse(result);
  return flagged.success ? flagged.data.untrusted : null;
};

/** Epoch millis as UTC time, or a dash. */
export const timeOrDash = (ms: number | null): string =>
  ms === null ? "—" : formatTime(ms);

/** The next pulse as of `now`, or what alone wakes the agent. */
export function describeNextPulse(agent: AgentPulse, now: number): string {
  if (agent.next_pulse_at === null)
    return agent.mode === "manual"
      ? "manual: pulses only when run"
      : "next pulse on a completion";
  const wait = agent.next_pulse_at - now;
  const when = wait > 0 ? `in ${formatIdle(wait)}` : "due";
  const sooner = agent.mode === "hybrid" ? ", sooner on a completion" : "";
  return `next pulse ${when} (${formatTime(agent.next_pulse_at)} UTC${sooner})`;
}

/**
 * The next pulse as a schedule's cell reads it: "in 41m" (the absolute time for its `title`), "Due
 * now", or what alone wakes the agent.
 */
export function nextPulseCell(
  agent: AgentPulse,
  now: number,
): { readonly text: string; readonly title: string | undefined } {
  if (agent.next_pulse_at === null)
    return {
      text: agent.mode === "manual" ? "Only when run" : "On a completion",
      title: undefined,
    };
  const wait = agent.next_pulse_at - now;
  const sooner = agent.mode === "hybrid" ? ", or sooner on a completion" : "";
  return {
    text: wait > 0 ? `in ${formatIdle(wait)}` : "Due now",
    title: `${formatUtc(agent.next_pulse_at)}${sooner}`,
  };
}

/** The summary's first line as plain text: the one-line preview drops emphasis and code marks. */
export const firstLine = (markdown: string | null): string =>
  markdown === null
    ? "—"
    : (markdown.split("\n", 1)[0] ?? "").replace(/\*\*|__|`/g, "");

/**
 * A settled `pulse.run` command's result (the supervisor's run-now): the pulse it made or joined,
 * and what happened. `outcome` stays a string: a new one is shown as given, not refused.
 */
const PulseRunOutcome = z.object({
  pulse_id: z.string().nullable(),
  outcome: z.string(),
});

const OUTCOMES: Readonly<Record<string, string>> = {
  running: "a pulse is running",
  coalesced: "a pulse was already running: this joined it",
  capped: "capped: this hour's most pulses have run",
  skipped: "skipped: see its pulse",
  denied: "denied by the pulse gate",
};

/**
 * What a run-now's command says as the supervisor moves it (§9.7 manual): queued, then running,
 * then its outcome — or the refusal, in the server's words (the fleet or the project paused, an
 * agent that does not pulse).
 */
export function runNowText(command: CommandView | undefined): string {
  switch (command?.state) {
    case undefined:
    case "pending":
      return "queued";
    case "claimed":
      return "starting…";
    case "failed":
      return `Not run: ${command.error?.message ?? "the supervisor gave no reason"}`;
    case "done": {
      const result = PulseRunOutcome.safeParse(command.result);
      if (!result.success) return "done";
      return OUTCOMES[result.data.outcome] ?? `done: ${result.data.outcome}`;
    }
  }
}
