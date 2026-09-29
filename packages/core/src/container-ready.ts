// Container readiness: whether a runner can run in a container executor's image, as its
// adapter declares it in its own defaults (Invariant 1: nothing here names a runner). A runner is
// ready when its defaults give the image at least one `containerInstall` line and no
// `containerUnready` reason. The API and the supervisor refuse `runner.conformance` on this rule
// before anything runs.
import { z } from "zod";
import type { FrmError } from "./errors.js";

/** The container facts in a runner's `defaults_json`; every other key is the adapter's own. */
export const ContainerFacts = z.looseObject({
  /** Dockerfile RUN lines that put the runner into the runner-neutral image. */
  containerInstall: z.array(z.string().min(1)).default([]),
  /** Why the runner cannot run in a container, install line or not. */
  containerUnready: z.string().min(1).optional(),
});

export type ContainerReadiness =
  { readonly ready: true } | { readonly ready: false; readonly reason: string };

/** `defaults`: the runner row's defaults_json, parsed (undefined when it is not JSON). */
export function containerReadiness(defaults: unknown): ContainerReadiness {
  const facts = ContainerFacts.safeParse(defaults ?? {});
  if (!facts.success) {
    return {
      ready: false,
      reason: `its defaults' container fields do not parse: ${z.prettifyError(facts.error)}`,
    };
  }
  if (facts.data.containerUnready !== undefined) {
    return { ready: false, reason: facts.data.containerUnready };
  }
  return facts.data.containerInstall.length === 0
    ? {
        ready: false,
        reason: "it has no containerInstall line, so no image holds it",
      }
    : { ready: true };
}

export interface ContainerCheck {
  readonly runnerId: string;
  /** The runner row's defaults_json, parsed (undefined when it is not JSON). */
  readonly defaults: unknown;
  readonly executorId: string;
  /** The executor row's kind. */
  readonly executorKind: string;
}

/**
 * Why the runner cannot run on that executor, as the typed error to refuse with; null when it can,
 * or when the executor is not a container. Not retryable: the same pair fails the same way until
 * the runner's adapter changes.
 */
export function containerRefusal(c: ContainerCheck): FrmError | null {
  if (c.executorKind !== "container") return null;
  const readiness = containerReadiness(c.defaults);
  if (readiness.ready) return null;
  return {
    class: "validation",
    message: `runner ${c.runnerId} cannot run on container executor ${c.executorId}: ${readiness.reason}`,
    retryable: false,
    cause: {
      rule: "container_ready",
      runner: c.runnerId,
      executor: c.executorId,
      reason: readiness.reason,
    },
  };
}
