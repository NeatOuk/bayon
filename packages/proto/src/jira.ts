import {
  ErrorClass,
  JiraStatusMap,
  JiraStatusName,
  JIRA_SITE,
  JIRA_SITE_MAX,
  JIRA_TOKEN_SECRET,
  normalizeJiraSite,
} from "@bayon/core";
import { z } from "zod";
import { KeychainScopeView, SecretStoreKindView } from "./secret-store.js";

// A project's Jira mirror: its source, `POST /projects/:id/jira/sync`'s answer,
// `GET /projects/:id/jira`, and the `jira.sync` audit row both of those read.

const count = z.int().nonnegative();
const epochMs = z.int().nonnegative();

/**
 * The site, as the operator types it: trimmed, lowercased and stripped of one trailing slash, then
 * held to `https://<name>.atlassian.net` exactly. This is the security control: the API sends the
 * operator's Jira token to this site, and the request can come from any page on the LAN holding the
 * operator's bearer, so only Atlassian's own cloud origin may ever receive it.
 */
export const JiraSiteUrl = z
  .string()
  .max(JIRA_SITE_MAX * 2)
  .transform(normalizeJiraSite)
  .pipe(
    z
      .string()
      .max(JIRA_SITE_MAX)
      .regex(JIRA_SITE, "a Jira Cloud site: https://<name>.atlassian.net"),
  );

/** `jira` on `POST /projects` and `PATCH /projects/:id`. No token: that is the host store's. */
export const JiraSource = z.strictObject({
  url: JiraSiteUrl,
  /** The Atlassian account the token belongs to. */
  email: z.email().max(254),
  /** Whose To Do issues the project mirrors. */
  jql: z.string().trim().min(1).max(2_000),
});
export type JiraSource = z.infer<typeof JiraSource>;

/** A stored source, as the views serve it. */
export const JiraSourceView = z.object({
  url: z.string(),
  email: z.string(),
  jql: z.string(),
});
export type JiraSourceView = z.infer<typeof JiraSourceView>;

/** An issue another project already mirrors: skipped, naming that project. */
export const JiraSkipped = z.object({
  key: z.string(),
  project: z.string().nullable(),
});
export type JiraSkipped = z.infer<typeof JiraSkipped>;

const JiraCounts = z.object({
  /**
   * The issues Jira returned for the query, before the To Do filter. 0 on a sync that
   * succeeded says the account the token belongs to sees nothing the query names.
   */
  matched: count,
  created: count,
  updated: count,
  unchanged: count,
  /** Unstarted tickets parked because their issue left the query or its To Do. */
  parked: count,
  /** Issues in the result that are not To Do: not mirrored. */
  ignored: count,
  skipped: z.array(JiraSkipped),
  /** The query matched more than a sync reads (1000 issues): nothing was parked. */
  capped: z.boolean(),
});

/** `POST /projects/:id/jira/sync`'s 200. */
export const JiraSyncResult = JiraCounts.extend({ project: z.string() });
export type JiraSyncResult = z.infer<typeof JiraSyncResult>;

/** A failed sync's error as its audit row keeps it; the message is capped and names no secret. */
export const JiraSyncError = z.object({
  class: ErrorClass,
  message: z.string(),
  retryable: z.boolean(),
});
export type JiraSyncError = z.infer<typeof JiraSyncError>;

export const JiraSyncVia = z.enum(["rest", "timer"]);
export type JiraSyncVia = z.infer<typeof JiraSyncVia>;

/**
 * The `jira.sync` audit row's payload: one per run, button or timer. A failed run keeps what it
 * wrote before the failure (earlier pages stay committed) and its error.
 */
export const JiraSyncRecord = JiraCounts.extend({
  /** Rows written before an earlier change have none. */
  matched: count.optional(),
  via: JiraSyncVia,
  ok: z.boolean(),
  error: JiraSyncError.optional(),
});
export type JiraSyncRecord = z.infer<typeof JiraSyncRecord>;

/**
 * The `jira.quick_sync` audit row's payload: a quick pass, by the timer, that created or
 * updated a ticket (one that changed nothing writes no row). It read only the issues updated in the
 * last `window_minutes`, so it parks nothing: that is the full sync's, whose `jira.sync` row stays
 * the project's last sync. A pass that failed part-way keeps what it wrote and its error.
 */
export const JiraQuickSyncRecord = JiraCounts.omit({ parked: true }).extend({
  window_minutes: z.int().positive(),
  /** More changed issues than a quick pass reads (5 pages): the rest wait for the full sync. */
  capped: z.boolean(),
  ok: z.boolean(),
  error: JiraSyncError.optional(),
});
export type JiraQuickSyncRecord = z.infer<typeof JiraQuickSyncRecord>;

/** `GET /projects/:id/jira`: the source, and the newest sync with when it ran. */
export const ProjectJiraView = z.object({
  source: JiraSourceView.nullable(),
  last_sync: JiraSyncRecord.extend({ at: epochMs }).nullable(),
});
export type ProjectJiraView = z.infer<typeof ProjectJiraView>;

/**
 * `GET /jira`: whether a sync could read the operator's Jira token right now, from which host store
 * (the Mac's Keychain, or the docker host's files). Global, since the New project form asks before a
 * project exists. A boolean only: the value never leaves the API.
 */
export const JiraTokenStatus = z.object({
  secret: z.literal(JIRA_TOKEN_SECRET),
  store: SecretStoreKindView,
  /** Which install's Keychain service the API reads; null with the file store. */
  keychain: KeychainScopeView.nullable(),
  present: z.boolean(),
});
export type JiraTokenStatus = z.infer<typeof JiraTokenStatus>;

/**
 * `jira_push` on `PATCH /projects/:id`: what Bayon writes back to the project's Jira
 * issues. `status_map` names the status each moment moves an issue to (a moment left out moves
 * nothing); `comment_prs` comments each delivered pull request, and who merged it. Setting it is the
 * operator's standing approval for those writes, made with the mirror's own token (§14).
 */
export const JiraPushConfig = z.strictObject({
  status_map: JiraStatusMap,
  comment_prs: z.boolean(),
});
export type JiraPushConfig = z.infer<typeof JiraPushConfig>;

/** A project's push settings, as the views serve them. */
export const JiraPushView = z.object({
  status_map: z.object({
    started: z.string().optional(),
    in_review: z.string().optional(),
    done: z.string().optional(),
  }),
  comment_prs: z.boolean(),
});
export type JiraPushView = z.infer<typeof JiraPushView>;

/** A project that has never set its push settings: move nothing, comment pull requests (041). */
export const DEFAULT_JIRA_PUSH_VIEW: JiraPushView = {
  status_map: {},
  comment_prs: true,
};

/** The most statuses `GET /projects/:id/jira/statuses` answers. */
export const JIRA_STATUSES_MAX = 500;

/** `GET /projects/:id/jira/statuses`: every status name the account sees on the site, sorted. */
export const JiraStatuses = z.object({
  statuses: z.array(JiraStatusName).max(JIRA_STATUSES_MAX),
});
export type JiraStatuses = z.infer<typeof JiraStatuses>;
