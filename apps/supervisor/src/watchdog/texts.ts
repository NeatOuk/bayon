// What the watchdog's human requests say: ids, counts, states and
// times, never a body. Error text is quoted from what the runs already store, cut to 200 characters.
import {
  ERROR_EXCERPT_MAX,
  SYSTEM_CONTEXT_MAX,
  excerpt,
  type TicketFailure,
} from "@bayon/core";

const iso = (at: number): string => new Date(at).toISOString();
const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;

export const CIRCUIT_OPTIONS = [
  "unblock and retry",
  "re-plan",
  "park",
  "reject",
] as const;
export const SPLIT_OPTIONS = [
  "split by hand",
  "keep going",
  "re-plan",
  "park",
] as const;
export const STORM_OPTIONS = [
  "ack",
  "disable the runner",
  "disable the executor",
] as const;

export const circuitReason = (count: number, resetAt: number): string =>
  `circuit breaker: ${count} failed runs since ${iso(resetAt)}`;

export const CIRCUIT_UNBLOCK =
  "answer the request, then unblock (operator or orchestrator)";

export const circuitQuestion = (num: number, count: number): string =>
  `Ticket #${num} failed ${count} times in a row and is blocked. Retry it, re-plan it, or park it?`;

export function circuitContext(
  failures: readonly TicketFailure[],
  resetAt: number,
): string {
  const lines = failures.map((f) => {
    const what =
      f.kind === "run" ? `run ${f.runId ?? "?"}` : "a start with no run";
    const message =
      f.errorMessage === null
        ? ""
        : `: ${excerpt(f.errorMessage.replaceAll("\n", " "), ERROR_EXCERPT_MAX)}`;
    return `- ${iso(f.at)} session ${f.sessionId}, ${what} ${f.state} (${f.errorClass ?? "no class"})${message}`;
  });
  return excerpt(
    [
      `Failures since ${iso(resetAt)}, the last good run or unblock:`,
      ...lines,
    ].join("\n"),
    SYSTEM_CONTEXT_MAX,
  );
}

export const stormQuestion = (o: {
  readonly runnerId: string;
  readonly executorId: string;
  readonly count: number;
  readonly windowMs: number;
  readonly until: number;
}): string =>
  `Runner ${o.runnerId} on executor ${o.executorId} failed ${o.count} runs within ${minutes(o.windowMs)}: new sessions on it are held until ${iso(o.until)} (retry storm). Check the provider or the executor.`;

export const stormContext = (o: {
  readonly burstStart: number;
  readonly triggeredAt: number;
  readonly until: number;
  readonly recoveredAt: number | null;
  readonly failures: number;
}): string =>
  [
    `- burst: ${iso(o.burstStart)} → ${iso(o.triggeredAt)}; admission reopens at ${iso(o.until)}`,
    `- runner_error failures read: ${o.failures}`,
    `- last ok run on this pair: ${o.recoveredAt === null ? "never" : iso(o.recoveredAt)}`,
    "- one request per outage: a new one only after this pair succeeds again",
  ].join("\n");

export const splitQuestion = (o: {
  readonly num: number;
  readonly handoffs: number;
  readonly threshold: number;
}): string =>
  `Ticket #${o.num} has ${o.handoffs} hand-offs, at or past autosplit.handoff_threshold ${o.threshold}: it is probably sliced too big. Split it by hand, keep going, or re-plan?`;

export const splitContext = (o: {
  readonly handoffs: number;
  readonly degraded: number;
  readonly status: string;
}): string =>
  [
    `- ${o.handoffs} hand-offs, ${o.degraded} of them degraded (a death or a restart, not a sizing signal)`,
    `- status: ${o.status}; nothing is split automatically (auto-split is deferred past M4)`,
  ].join("\n");
