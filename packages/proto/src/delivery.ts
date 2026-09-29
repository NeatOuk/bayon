import { DELIVERY_MODES, DELIVERY_MOMENTS } from "@bayon/core";
import { z } from "zod";

// A project's delivery, as `POST /projects`, `PATCH /projects/:id` and `GET /projects`
// carry it. Three switches — what leaves, when, and whether a merge closes the ticket —
// and nothing else: no remote, no base branch, no token, no forge. The
// remote is the one recorded when the project was created, the base is each repo's own
// `default_base_branch`, and the token is a host-store secret named by the forge kind (§14).
//
// Setting `mode` to anything but `none` is the operator's standing approval for the network writes
// the delivery job then makes (the design §1.7), which is why it lives on the audited
// `project.set` door and nowhere else.

/** `workspaces.delivery_mode`: `none`, `push`, or `pull_request`. */
export const DeliveryMode = z.enum(DELIVERY_MODES);
export type DeliveryMode = z.infer<typeof DeliveryMode>;

/** `workspaces.delivery_when`: `review_passed` or `done`. */
export const DeliveryWhen = z.enum(DELIVERY_MOMENTS);
export type DeliveryWhen = z.infer<typeof DeliveryWhen>;

export const DeliveryConfig = z.strictObject({
  mode: DeliveryMode,
  when: DeliveryWhen.default("review_passed"),
  /**
   * Close a ticket when every pull request its delivery opened has merged (040). On
   * unless said otherwise, as every project's column is.
   */
  close_on_merge: z.boolean().default(true),
});
export type DeliveryConfig = z.infer<typeof DeliveryConfig>;

/** A stored configuration, as the views serve it. */
export const DeliveryConfigView = z.object({
  mode: DeliveryMode,
  when: DeliveryWhen,
  close_on_merge: z.boolean(),
});
export type DeliveryConfigView = z.infer<typeof DeliveryConfigView>;

/** What a project that delivers nothing reads as — every project, until an operator says so. */
export const NO_DELIVERY: DeliveryConfigView = {
  mode: "none",
  when: "review_passed",
  close_on_merge: true,
};

// ─── Push targets (migration 039) ────────────────────────────────────────────────────────────
// Where one repo's delivered work is pushed when that is not its origin: a folder project's own
// remote. The shape rule (https, ssh:// or scp-like, no credential) is core's `checkPushUrl`, run by
// the writer — not duplicated here, so every door refuses with the same sentence.

const repoId = z.string().min(1).max(64);

/** One entry of `PATCH /projects/:id {push_urls}`: a URL, or null to push to the origin again. */
export const PushTargetPatch = z.strictObject({
  repo_id: repoId,
  push_url: z.string().max(2_000).nullable(),
});
export type PushTargetPatch = z.infer<typeof PushTargetPatch>;

/** One repo's push target, as the settings answer carries it. */
export const PushTargetView = z.object({
  repo_id: z.string(),
  /** Its path in the superproject; null for the primary or a lone repo. */
  submodule_path: z.string().nullable(),
  push_url: z.string().nullable(),
});
export type PushTargetView = z.infer<typeof PushTargetView>;

/** One repo's proposal from `POST /projects/:id/push-targets/detect`: read, never saved. */
export const PushTargetProposal = PushTargetView.extend({
  /** The folder's own origin, credentials removed and checked; null when there is none to use. */
  detected: z.string().nullable(),
  /** Why `detected` is null, or what was removed from it; null when there is nothing to say. */
  warning: z.string().nullable(),
});
export type PushTargetProposal = z.infer<typeof PushTargetProposal>;

export const PushTargetsDetected = z.object({
  targets: z.array(PushTargetProposal),
});
export type PushTargetsDetected = z.infer<typeof PushTargetsDetected>;
