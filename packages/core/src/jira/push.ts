import { z } from "zod";
import type { TicketStatus } from "../laws/statuses.js";
import { jiraFingerprintPrefix } from "./issue-map.js";

// Jira follows the ticket: the pure half. What a project maps its moments to, which
// ticket events and pull requests file which push, the push's stored shape, and the comment's ADF.
// The API reads the rows (packages/db), this decides, the outbox writer writes, the pusher sends.

/** A Jira status name, as the operator types it and Jira's transitions name it. */
export const JIRA_STATUS_NAME_MAX = 100;
export const JiraStatusName = z
  .string()
  .trim()
  .min(1)
  .max(JIRA_STATUS_NAME_MAX);

/** The three moments a mirrored ticket moves its issue at. */
export const JIRA_PUSH_MOMENTS = ["started", "in_review", "done"] as const;
export const JiraPushMoment = z.enum(JIRA_PUSH_MOMENTS);
export type JiraPushMoment = z.infer<typeof JiraPushMoment>;

/** `workspaces.jira_status_map_json`: each moment's target status; a moment left out moves nothing. */
export const JiraStatusMap = z.strictObject({
  started: JiraStatusName.optional(),
  in_review: JiraStatusName.optional(),
  done: JiraStatusName.optional(),
});
export type JiraStatusMap = z.infer<typeof JiraStatusMap>;

/** A project's push settings, as stored and served. */
export interface JiraPushFields {
  readonly status_map: JiraStatusMap;
  readonly comment_prs: boolean;
}

/** A project's push settings as 041 creates them: move nothing, comment pull requests. */
export const DEFAULT_JIRA_PUSH: JiraPushFields = {
  status_map: {},
  comment_prs: true,
};

/** A stored map, read loosely: anything that does not parse moves nothing rather than throwing. */
export function statusMapOf(json: string | null): JiraStatusMap {
  if (json === null) return {};
  try {
    const parsed = JiraStatusMap.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** A map with every moment set to nothing is no map: stored as NULL. */
export const isEmptyStatusMap = (m: JiraStatusMap): boolean =>
  JIRA_PUSH_MOMENTS.every((k) => m[k] === undefined);

/**
 * The statuses in which Bayon has begun a ticket's work. A ticket that ever reached one is Bayon's:
 * the mirror never parks it again, whatever Jira says since (the loop guard, spike §1.4).
 */
export const WORK_STARTED_STATUSES = [
  "staffed",
  "spiking",
  "plan_review",
  "planned",
  "building",
  "code_review",
  "review_fix",
  "qa_harness",
  "qa_human",
  "rework",
  "done",
] as const satisfies readonly TicketStatus[];

/** The moves that file `started`: the first steps of the work, not the review or QA that follow. */
export const STARTED_TRIGGER: readonly TicketStatus[] = [
  "staffed",
  "spiking",
  "plan_review",
  "planned",
  "building",
];

/** A Jira issue key: `ABC-123`. Anything else never reaches a URL path. */
export const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,11}$/;
export const isJiraIssueKey = (key: string): boolean =>
  JIRA_ISSUE_KEY.test(key);

/** The longest url a comment carries; a longer one is not commented. */
export const JIRA_PUSH_URL_MAX = 500;
/** The longest lead text a comment carries. */
export const JIRA_COMMENT_LEAD_MAX = 200;
/** The most urls one comment links. */
export const JIRA_COMMENT_URLS_MAX = 10;
/** The longest error a push keeps. */
export const JIRA_PUSH_ERROR_MAX = 500;

/** An absolute http(s) url with no userinfo, at most JIRA_PUSH_URL_MAX long. */
export function isPushableUrl(url: string): boolean {
  if (url.length > JIRA_PUSH_URL_MAX) return false;
  try {
    const u = new URL(url);
    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      u.username === "" &&
      u.password === ""
    );
  } catch {
    return false;
  }
}

const PushUrl = z.string().refine(isPushableUrl, "an http(s) url");

export const JiraTransitionPayload = z.strictObject({ status: JiraStatusName });
export const JiraCommentPayload = z.strictObject({
  lead: z.string().min(1).max(JIRA_COMMENT_LEAD_MAX),
  urls: z.array(PushUrl).min(1).max(JIRA_COMMENT_URLS_MAX),
});
export type JiraTransitionPayload = z.infer<typeof JiraTransitionPayload>;
export type JiraCommentPayload = z.infer<typeof JiraCommentPayload>;

const PushCommon = {
  ticket_id: z.string().min(1),
  workspace_id: z.string().min(1),
  issue_key: z.string().regex(JIRA_ISSUE_KEY),
  moment: JiraPushMoment,
  dedupe_key: z.string().min(1).max(700),
};

/** One push to file: the outbox writer's input. */
export const NewJiraPush = z.discriminatedUnion("kind", [
  z.strictObject({
    ...PushCommon,
    kind: z.literal("transition"),
    payload: JiraTransitionPayload,
  }),
  z.strictObject({
    ...PushCommon,
    kind: z.literal("comment"),
    payload: JiraCommentPayload,
  }),
]);
export type NewJiraPush = z.infer<typeof NewJiraPush>;

export const transitionKey = (ticketId: string, m: JiraPushMoment): string =>
  `t:${ticketId}:${m}`;
export const prCommentKey = (ticketId: string, url: string): string =>
  `c:${ticketId}:pr:${url}`;
export const mergedCommentKey = (ticketId: string): string =>
  `c:${ticketId}:merged`;

/** A mirrored ticket as the source read found it, with its project's push settings. */
export interface JiraPushTicket {
  readonly id: string;
  readonly status: string;
  readonly workspace_id: string;
  /** The issue key (`origin_ref`). */
  readonly origin_ref: string | null;
  readonly origin_fingerprint: string | null;
  /** The project's current Jira site. */
  readonly jira_url: string;
  readonly status_map: JiraStatusMap;
  readonly comment_prs: boolean;
}

export interface JiraPushEvent {
  readonly id: number;
  readonly ticket_id: string;
  readonly actor_id: string | null;
  readonly from_status: string | null;
  readonly to_status: string | null;
  readonly payload_json: string | null;
}

export interface JiraPushLink {
  readonly seq: number;
  readonly ticket_id: string;
  readonly url: string;
}

export interface JiraPushRows {
  readonly events: readonly JiraPushEvent[];
  /** Pull requests a delivery opened: `ticket_links` of kind `pr` whose url a delivery recorded. */
  readonly links: readonly JiraPushLink[];
  /** The mirrored tickets the rows name, in projects with a Jira source. */
  readonly tickets: ReadonlyMap<string, JiraPushTicket>;
}

const MIRROR_ACTOR_PREFIX = "jira:";

/** The ticket's issue key when it is one of its project's current site; else null (no push). */
function issueKeyOf(t: JiraPushTicket): string | null {
  if (t.origin_ref === null || !isJiraIssueKey(t.origin_ref)) return null;
  const prefix = jiraFingerprintPrefix(t.jira_url.slice("https://".length));
  return t.origin_fingerprint?.startsWith(prefix) === true
    ? t.origin_ref
    : null;
}

function transition(
  t: JiraPushTicket,
  key: string,
  m: JiraPushMoment,
): NewJiraPush[] {
  const status = t.status_map[m];
  return status === undefined
    ? []
    : [
        {
          kind: "transition",
          ticket_id: t.id,
          workspace_id: t.workspace_id,
          issue_key: key,
          moment: m,
          dedupe_key: transitionKey(t.id, m),
          payload: { status },
        },
      ];
}

function comment(
  t: JiraPushTicket,
  key: string,
  m: JiraPushMoment,
  dedupe: string,
  lead: string,
  urls: readonly string[],
): NewJiraPush[] {
  const kept = urls.filter(isPushableUrl).slice(0, JIRA_COMMENT_URLS_MAX);
  if (!t.comment_prs || kept.length === 0) return [];
  return [
    {
      kind: "comment",
      ticket_id: t.id,
      workspace_id: t.workspace_id,
      issue_key: key,
      moment: m,
      dedupe_key: dedupe,
      payload: { lead: lead.slice(0, JIRA_COMMENT_LEAD_MAX), urls: kept },
    },
  ];
}

/** Who merged, and what, from a done event's payload (merge_close); tolerant. */
/**
 * `merge_close`'s transition payload: `{ rule: "merge_close", merged_by, pr_urls }`,
 * `merged_by` "unknown" when the forge named no one. Any other rule's move is not a merge.
 */
const MergedPayload = z.object({
  rule: z.literal("merge_close").optional(),
  merged_by: z.string().trim().min(1).max(100),
  pr_url: z.string().optional().catch(undefined),
  pr_urls: z.array(z.string()).optional().catch(undefined),
  prs: z
    .array(z.object({ url: z.string() }).loose())
    .optional()
    .catch(undefined),
});

/** The merger `merge_close` records when the forge named no one (db UNKNOWN_MERGER). */
export const UNKNOWN_MERGER = "unknown";

export interface MergedInfo {
  /** Who merged; null when the forge named no one. */
  readonly by: string | null;
  readonly urls: readonly string[];
}

export function mergedInfoOf(payloadJson: string | null): MergedInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson ?? "null");
  } catch {
    return null;
  }
  const p = MergedPayload.safeParse(raw);
  if (!p.success) return null;
  const urls = [
    ...(p.data.pr_url === undefined ? [] : [p.data.pr_url]),
    ...(p.data.pr_urls ?? []),
    ...(p.data.prs ?? []).map((pr) => pr.url),
  ];
  const unique = [...new Set(urls)].filter(isPushableUrl);
  const by = p.data.merged_by === UNKNOWN_MERGER ? null : p.data.merged_by;
  return unique.length === 0 ? null : { by, urls: unique };
}

function pushesOfEvent(e: JiraPushEvent, t: JiraPushTicket): NewJiraPush[] {
  const key = issueKeyOf(t);
  if (key === null || e.to_status === null || e.to_status === e.from_status)
    return [];
  if (STARTED_TRIGGER.includes(e.to_status as TicketStatus))
    return transition(t, key, "started");
  if (e.to_status !== "done") return [];
  const merged = mergedInfoOf(e.payload_json);
  return [
    ...transition(t, key, "done"),
    ...(merged === null
      ? []
      : comment(
          t,
          key,
          "done",
          mergedCommentKey(t.id),
          merged.by === null ? "Merged:" : `Merged by ${merged.by}:`,
          merged.urls,
        )),
  ];
}

const FINISHED = new Set(["done", "rejected"]);

function pushesOfLink(l: JiraPushLink, t: JiraPushTicket): NewJiraPush[] {
  const key = issueKeyOf(t);
  if (key === null || !isPushableUrl(l.url)) return [];
  return [
    // A pull request opened on delivery at `done` must not move a done issue back to review.
    ...(FINISHED.has(t.status) ? [] : transition(t, key, "in_review")),
    ...comment(
      t,
      key,
      "in_review",
      prCommentKey(t.id, l.url),
      "Pull request:",
      [l.url],
    ),
  ];
}

/**
 * Every push the rows call for, events first then pull requests, each in source order. The mirror's
 * own writes (`jira:<host>`) and tickets the rows do not name (not mirrored, or no Jira source) file
 * nothing.
 */
export function pushesOf(rows: JiraPushRows): NewJiraPush[] {
  const fromEvents = rows.events.flatMap((e) => {
    const t = rows.tickets.get(e.ticket_id);
    if (t === undefined || e.actor_id?.startsWith(MIRROR_ACTOR_PREFIX) === true)
      return [];
    return pushesOfEvent(e, t);
  });
  const fromLinks = rows.links.flatMap((l) => {
    const t = rows.tickets.get(l.ticket_id);
    return t === undefined ? [] : pushesOfLink(l, t);
  });
  return [...fromEvents, ...fromLinks];
}

/** Jira's Atlassian Document Format, as much of it as a comment of ours uses. */
export interface AdfText {
  readonly type: "text";
  readonly text: string;
  readonly marks?: readonly {
    readonly type: "link";
    readonly attrs: { readonly href: string };
  }[];
}
export interface AdfDoc {
  readonly type: "doc";
  readonly version: 1;
  readonly content: readonly [
    { readonly type: "paragraph"; readonly content: readonly AdfText[] },
  ];
}

/** One paragraph: the lead, then each url as a link, separated by ", ". */
export function commentAdf(p: JiraCommentPayload): AdfDoc {
  const links = p.urls.flatMap((url, i): AdfText[] => [
    ...(i === 0 ? [] : [{ type: "text" as const, text: ", " }]),
    {
      type: "text",
      text: url,
      marks: [{ type: "link", attrs: { href: url } }],
    },
  ]);
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: `${p.lead} ` }, ...links],
      },
    ],
  };
}

/**
 * The plain text of an ADF node, read loosely: every `text` node's text in document order. What a
 * retried comment compares against the issue's recent comments, so a comment whose POST landed
 * before its settle was lost is not posted twice.
 */
export function adfText(node: unknown, depth = 0): string {
  if (typeof node !== "object" || node === null || depth > 20) return "";
  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  const own = n.type === "text" && typeof n.text === "string" ? n.text : "";
  const children = Array.isArray(n.content)
    ? n.content.map((c) => adfText(c, depth + 1)).join("")
    : "";
  return own + children;
}

/** Text as compared between two comments: trimmed, runs of whitespace as one space. */
export const sameCommentText = (a: string, b: string): boolean =>
  a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");
