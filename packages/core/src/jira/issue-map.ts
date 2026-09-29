import { z } from "zod";
import { adfToMarkdown } from "./adf.js";
import { jiraHost } from "./site.js";

// One Jira issue as the ticket its mirror keeps. Pure: the client parses the issue at
// the boundary; this decides every column the mirror writes from it.

/** A Jira issue key: a project key, a dash, a number. It is linked in Markdown, so nothing else. */
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}-[0-9]{1,18}$/;

const Named = z.object({ name: z.string() });

/** The fields the mirror asks for (`JIRA_FIELDS`), as REST v3 returns them. */
export const JiraIssue = z.object({
  /** Numeric and stable when the issue moves project, unlike its key. */
  id: z.string().regex(/^[0-9]{1,20}$/),
  key: z.string().regex(JIRA_KEY),
  fields: z.object({
    summary: z.string().nullish(),
    /** ADF; parsed loosely by adfToMarkdown. */
    description: z.unknown().optional(),
    issuetype: Named.nullish(),
    priority: Named.nullish(),
    /** The epic, for an issue in one. */
    parent: z
      .object({
        key: z.string().regex(JIRA_KEY),
        fields: z.object({ summary: z.string().nullish() }).nullish(),
      })
      .nullish(),
    status: z.object({
      name: z.string(),
      /** `new` (To Do), `indeterminate` (In Progress) or `done`. */
      statusCategory: z.object({ key: z.string() }),
    }),
  }),
});
export type JiraIssue = z.infer<typeof JiraIssue>;

/** What the search asks Jira for: exactly what `JiraIssue` reads. */
export const JIRA_FIELDS = [
  "summary",
  "description",
  "issuetype",
  "priority",
  "parent",
  "status",
] as const;

/** A ticket title's limit: proto's `title` (`POST /tickets`). */
export const JIRA_TITLE_MAX = 200;
/**
 * A mirrored body's limit, far below proto's 200 000: a ticket body is read into prompts, so the
 * spirit of §8.5's caps applies, and the full text stays one click away in Jira.
 */
export const JIRA_BODY_MAX = 20_000;
export const JIRA_TRUNCATED = "\n\n_…truncated; full text in Jira._";
/** Bayon's default priority (tickets.priority DEFAULT 3; `POST /tickets` without one). */
export const DEFAULT_TICKET_PRIORITY = 3;
/** The status category of a To Do issue: the only one the mirror keeps. */
export const JIRA_TODO = "new";

const PRIORITY: ReadonlyMap<string, number> = new Map([
  ["highest", 1],
  ["high", 2],
  ["medium", 3],
  ["low", 4],
  ["lowest", 5],
]);

export type MirroredType = "bug" | "spike" | "feature";

export interface JiraMirrorItem {
  readonly issue_id: string;
  /** `jira:<host>:<issue id>` (jiraFingerprint). */
  readonly fingerprint: string;
  /** The issue key, e.g. `ABC-12`. */
  readonly origin_ref: string;
  readonly title: string;
  readonly body_md: string;
  readonly type: MirroredType;
  readonly priority: number;
  readonly status_category: string;
  readonly status_name: string;
}

export const jiraFingerprintPrefix = (host: string): string => `jira:${host}:`;
export const jiraFingerprint = (host: string, issueId: string): string =>
  `${jiraFingerprintPrefix(host)}${issueId}`;
/** Who the mirror's ticket writes name: `operator`, with this id. */
export const jiraActorId = (host: string): string => `jira:${host}`;

/** At most `max` UTF-16 units, never splitting a surrogate pair. */
function cut(value: string, max: number): string {
  const end = /[\uD800-\uDBFF]/.test(value.charAt(max - 1)) ? max - 1 : max;
  return value.slice(0, end);
}

function capTitle(title: string): string {
  return title.length <= JIRA_TITLE_MAX
    ? title
    : `${cut(title, JIRA_TITLE_MAX - 1)}…`;
}

function capBody(body: string): string {
  return body.length <= JIRA_BODY_MAX
    ? body
    : `${cut(body, JIRA_BODY_MAX - JIRA_TRUNCATED.length)}${JIRA_TRUNCATED}`;
}

function typeOf(name: string | undefined): MirroredType {
  const type = name?.trim().toLowerCase();
  return type === "bug" || type === "spike" ? type : "feature";
}

const priorityOf = (name: string | undefined): number =>
  PRIORITY.get(name?.trim().toLowerCase() ?? "") ?? DEFAULT_TICKET_PRIORITY;

function header(issue: JiraIssue, site: string): string {
  const link = `Jira: [${issue.key}](${site}/browse/${issue.key})`;
  const parent = issue.fields.parent;
  if (parent === null || parent === undefined) return link;
  const summary = parent.fields?.summary?.trim() ?? "";
  return `${link} · Parent: ${parent.key}${summary === "" ? "" : ` ${summary}`}`;
}

/** The ticket that mirrors `issue` from `site` (`https://<name>.atlassian.net`). */
export function mapIssue(issue: JiraIssue, site: string): JiraMirrorItem {
  const summary = issue.fields.summary?.trim() ?? "";
  const description = adfToMarkdown(issue.fields.description);
  const head = header(issue, site);
  return {
    issue_id: issue.id,
    fingerprint: jiraFingerprint(jiraHost(site), issue.id),
    origin_ref: issue.key,
    title: capTitle(summary === "" ? issue.key : summary),
    body_md: capBody(description === "" ? head : `${head}\n\n${description}`),
    type: typeOf(issue.fields.issuetype?.name),
    priority: priorityOf(issue.fields.priority?.name),
    status_category: issue.fields.status.statusCategory.key,
    status_name: issue.fields.status.name,
  };
}
