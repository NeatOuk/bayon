import {
  RunnerConformancePayload,
  type CertificationView,
  type CommandView,
  type ExecutorView,
  type QueuedCommand,
  type RunnerModelView,
} from "@bayon/proto";
import { conformanceResult } from "@/runners/runners-api";

// What the Runners screen says while a conformance run is queued or running. A run
// takes minutes and the supervisor runs them one at a time, so "queued" on its own leaves a slow
// run and a wedged one looking identical. Every elapsed time here is measured between two stamps
// the API sent (`now`, `ts`, `claimed_at`), never against the browser's clock.

const pad = (n: number): string => String(n).padStart(2, "0");

/** A duration, coarse enough to read at a glance and fine enough to tick: 8s, 1m 30s, 1h 06m. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

/**
 * The models something runs (GET /runners' bound_roles): a role binding, a project's step tier or an
 * enabled agent. What "Certify the models in use" queues, one run each.
 */
export const modelsInUse = (
  models: readonly RunnerModelView[],
): readonly RunnerModelView[] => models.filter((m) => m.bound_roles.length > 0);

/**
 * The model "Run conformance" offers first (a certificate is per model): the first one in
 * use, else the runner's standard tier — its default, as `frm runner conformance` certifies with
 * nothing in use — else its first; null when it has none active.
 */
export function defaultModel(
  models: readonly RunnerModelView[],
): string | null {
  return (
    modelsInUse(models)[0]?.id ??
    models.find((m) => m.tier === "standard")?.id ??
    models[0]?.id ??
    null
  );
}

/** One line on what a run of `model` certifies, and for whom. */
export function modelUseText(model: RunnerModelView | undefined): string {
  if (model === undefined) return "";
  return model.bound_roles.length > 0
    ? `Certifies ${model.id}, used by ${model.bound_roles.join(", ")}.`
    : `Certifies ${model.id}, which no project, agent or role uses yet.`;
}

/**
 * The executors "Run conformance" offers at all: the enabled ones. `frm executor
 * disable` takes a box out of service, and the API and the supervisor now both refuse a
 * conformance run on a disabled one, as admission refuses a spawn on it. Listing one would offer
 * the operator a choice the server rejects; certifying a box before it returns to service means
 * enabling it first.
 */
export const offeredExecutors = (
  all: readonly ExecutorView[],
): readonly ExecutorView[] => all.filter((e) => e.enabled);

/**
 * The executor "Run conformance" offers first: the one this runner was most recently certified on
 * and that is still registered and enabled, else an enabled local executor, else the first enabled
 * one the registry lists. The registry's order is nobody's preference, and defaulting to it is how
 * a run lands on an executor the operator never meant to use.
 *
 * With every executor disabled there is no default at all — and nothing to pick either: the screen
 * says so rather than choosing.
 */
export function defaultExecutor(
  all: readonly ExecutorView[],
  certifications: readonly CertificationView[],
): string | null {
  const executors = offeredExecutors(all);
  const offered = new Set(executors.map((e) => e.id));
  const best = certifications
    .filter(
      (c) =>
        c.passed_at !== null &&
        c.decertified_at === null &&
        offered.has(c.executor_id),
    )
    .reduce<CertificationView | null>(
      (found, c) =>
        found === null || c.certified_at > found.certified_at ? c : found,
      null,
    );
  if (best !== null) return best.executor_id;
  return (
    executors.find((e) => e.kind === "local")?.id ?? executors[0]?.id ?? null
  );
}

/** A queued command's payload as far as the line reads it: one queued before an earlier change names no model. */
const Queued = RunnerConformancePayload.partial({ model_id: true });

/**
 * Where a queued `runner.conformance` command says it will run, and with which model when it names
 * one; null if its payload is not one.
 */
function target(payload: unknown): string | null {
  const parsed = Queued.safeParse(payload);
  if (!parsed.success) return null;
  const { executor_id, model_id } = parsed.data;
  return model_id === undefined
    ? executor_id
    : `${executor_id} with ${model_id}`;
}

/** The runs holding the lane in front of this one — the fact the screen never used to admit. */
function waitingFor(ahead: readonly QueuedCommand[], now: number): string {
  const front = ahead[0];
  if (front === undefined) return "";
  const going = formatElapsed(now - (front.claimed_at ?? front.ts));
  const where = target(front.payload);
  const lead = `${where === null ? "" : `on ${where}, `}going ${going}`;
  return ahead.length === 1
    ? `waiting behind 1 other conformance run, ${lead}`
    : `waiting behind ${ahead.length} other conformance runs; the one in front, ${lead}`;
}

/** One line for the run's state: how long it has been going, and what it is waiting for. */
export function progressText(
  command: CommandView | undefined,
  id: string,
): string {
  if (command === undefined) return `Conformance queued (command ${id}).`;
  switch (command.state) {
    case "pending":
    case "claimed": {
      const queued = formatElapsed(command.now - command.ts);
      if (command.ahead.length > 0) {
        return `Conformance queued ${queued} ago, ${waitingFor(command.ahead, command.now)} (command ${id}).`;
      }
      if (command.state === "pending") {
        return `Conformance queued ${queued} ago; the supervisor has not claimed it yet (command ${id}).`;
      }
      const running = formatElapsed(
        command.now - (command.claimed_at ?? command.ts),
      );
      return `Conformance running on the supervisor for ${running} (command ${id})…`;
    }
    case "failed":
      return `Conformance failed: ${command.error?.message ?? "the supervisor gave no reason"}.`;
    case "done": {
      const result = conformanceResult(command);
      if (result === null) return `Conformance done (command ${id}).`;
      const { passed, failed, na, incomplete } = result.summary;
      return [
        `Conformance done on ${result.executor_id}: ${passed.length} passed, ${failed.length} failed, ${na.length} n/a, ${incomplete.length} incomplete.`,
        result.stored
          ? "Certification updated."
          : "Not stored: not a certifiable run.",
        `Report: ${result.report_path}`,
      ].join(" ");
    }
  }
}
