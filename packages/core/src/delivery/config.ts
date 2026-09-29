import type { TicketStatus } from "../laws/statuses.js";

// A project's delivery settings (spike §1.1–§1.2), pure: what `workspaces.delivery_*`
// holds, and the one question the sweep asks of a ticket — has it reached the moment this project
// delivers at?
//
// Nothing here knows a forge, a remote or a repository. `delivery-remote.ts` decides the forge kind
// from a URL; this file decides only whether, and when.

/**
 * `workspaces.delivery_mode`. `none`: the project's work stays on this host, as every project's did
 * before M7.7. `push`: its branches reach the project's own remote. `pull_request`: and a pull
 * request is opened for each of them on the remote's forge.
 */
export const DELIVERY_MODES = ["none", "push", "pull_request"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const isDeliveryMode = (mode: string): mode is DeliveryMode =>
  (DELIVERY_MODES as readonly string[]).includes(mode);

/**
 * `workspaces.delivery_when`: the moment a ticket's work is delivered. `review_passed` is the
 * default — code review is what says the change is fit to be seen, and a reviewer of the pull
 * request is exactly who the remaining statuses are waiting on.
 */
export const DELIVERY_MOMENTS = ["review_passed", "done"] as const;
export type DeliveryMoment = (typeof DELIVERY_MOMENTS)[number];

export const isDeliveryMoment = (when: string): when is DeliveryMoment =>
  (DELIVERY_MOMENTS as readonly string[]).includes(when);

/**
 * `deliveries.state` (040's CHECK): the branch is on the remote, its pull request is open, merged or
 * closed unmerged, or the delivery failed. Named here so a reader (the GUI's status map) is typed from
 * the one list rather than retyping it.
 */
export const DELIVERY_ROW_STATES = [
  "pushed",
  "pr_open",
  "merged",
  "closed",
  "failed",
] as const;
export type DeliveryRowState = (typeof DELIVERY_ROW_STATES)[number];

/**
 * The statuses each moment names — a set, not an edge (spike §1.2). A ticket that ran on to
 * `qa_human` or `done` has still passed review, and asking where the ticket *is* needs no one to
 * have watched the transition go by. `review_fix` and `rework` are absent on purpose: work sent back
 * is not delivered. The ticket reached its moment when it entered this set, and only an entry at or
 * after its project's `delivery_since` is delivered: switching delivery on is not a
 * reason to deliver the project's history.
 */
export const DELIVERY_STATUSES: Readonly<
  Record<DeliveryMoment, readonly TicketStatus[]>
> = {
  review_passed: ["qa_harness", "qa_human", "done"],
  done: ["done"],
};

/** Every status any moment delivers at: what the candidate query narrows to first. */
export const DELIVERABLE_STATUSES: readonly TicketStatus[] = [
  ...new Set(Object.values(DELIVERY_STATUSES).flat()),
];

/** Whether a ticket in `status` has reached `when`. */
export const deliveryDue = (when: DeliveryMoment, status: string): boolean =>
  (DELIVERY_STATUSES[when] as readonly string[]).includes(status);

/** A project's delivery settings as they are stored and served: one shape for every reader. */
export interface DeliveryConfigFields {
  readonly mode: DeliveryMode;
  readonly when: DeliveryMoment;
  /**
   * `workspaces.close_on_merge` (040): a ticket goes to `done` once every pull request
   * its delivery opened has merged. On by default; off records the merge and moves nothing.
   */
  readonly close_on_merge: boolean;
}

/** What a project that delivers nothing reads as, and what every project starts at. */
export const NO_DELIVERY_CONFIG: DeliveryConfigFields = {
  mode: "none",
  when: "review_passed",
  close_on_merge: true,
};

/**
 * `workspaces.delivery_since` (047) once a project's delivery moves from `from` — marked
 * `since` — to `to`, at `now`: when delivery was last turned on, which is where it starts to apply.
 * Off clears it. On, or on again, sets a new mark: what reached its moment while delivery was off
 * stays undelivered. A change between two ways of delivering, or of the moment, keeps the mark it
 * has; a delivering project with none yet (one no writer marked) gets one now.
 */
export const deliverySinceAfter = (
  from: DeliveryMode,
  since: number | null,
  to: DeliveryMode,
  now: number,
): number | null => {
  if (to === "none") return null;
  return from === "none" || since === null ? now : since;
};

/** Whether `mode` opens pull requests as well as pushing. */
export const opensPullRequests = (mode: DeliveryMode): boolean =>
  mode === "pull_request";
