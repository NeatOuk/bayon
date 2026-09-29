// Who reviews (§9.8, §10.3): a runner distinct from the builder's, from the role's binding, among
// runners that are enabled, certified by conformance and gate-eligible. Pure over plain rows: a
// `runners` row and a `role_bindings` row satisfy these shapes as they are.

/** The `runners` columns the pick reads. */
export interface ReviewerRunner {
  readonly id: string;
  readonly enabled: number;
  readonly gate_eligible: number;
  /** NULL until conformance passes, and again after a version change decertifies it. */
  readonly conformance_passed_at: number | null;
}

/** `role_bindings[plan_reviewer | code_reviewer]`. */
export interface ReviewerBinding {
  readonly runner_id: string;
  readonly fallback_runner_id: string | null;
}

export interface PickReviewerInput {
  /** The runner of the session whose work is reviewed. */
  readonly builderRunnerId: string;
  /** Null: the role is unbound, so any eligible runner, by id. */
  readonly binding: ReviewerBinding | null;
  readonly runners: readonly ReviewerRunner[];
  /** `roles.require_distinct_reviewer` and the binding's `require_distinct_from`. */
  readonly requireDistinct: boolean;
  /**
   * The runners to try, in order, in place of the binding's pair: a project's own
   * reviewer runners, the binding's first. Its first runner is the one a pick falls back from.
   */
  readonly order?: readonly string[];
}

export interface ReviewerPick {
  readonly runnerId: string;
  /** The bound runner this one replaced: `sessions.fallback_from_runner_id`, `flags.fallback_from`. */
  readonly fallbackFrom: string | null;
  /** Reviewer and builder share a runner: the gate runs, and the evidence says so (§9.8). */
  readonly singleRunnerReview: boolean;
}

const eligible = (r: ReviewerRunner): boolean =>
  r.enabled === 1 && r.gate_eligible === 1 && r.conformance_passed_at !== null;

/**
 * An explicit order's runners; else the binding's runner, then its fallback; with neither, every
 * eligible runner by id. Among those that are eligible, the first distinct from the builder's when
 * distinctness is required, else the first. Only the builder's own runner left: it reviews, flagged
 * single_runner_review. Neither an order nor a binding ever falls through to a runner it does not
 * name. Null: no candidate.
 */
export function pickReviewer(i: PickReviewerInput): ReviewerPick | null {
  const usable = new Set(i.runners.filter(eligible).map((r) => r.id));
  const named =
    i.order ??
    (i.binding === null
      ? [...usable].toSorted()
      : [i.binding.runner_id, i.binding.fallback_runner_id]);
  const candidates = named.filter(
    (id): id is string => id !== null && usable.has(id),
  );
  const distinct = i.requireDistinct
    ? candidates.find((id) => id !== i.builderRunnerId)
    : undefined;
  const runnerId = distinct ?? candidates[0];
  if (runnerId === undefined) return null;
  const bound = i.order?.[0] ?? i.binding?.runner_id ?? runnerId;
  return {
    runnerId,
    fallbackFrom: runnerId === bound ? null : bound,
    singleRunnerReview: runnerId === i.builderRunnerId,
  };
}
