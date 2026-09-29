import {
  JIRA_STATUS_NAME_MAX,
  adfText,
  commentAdf,
  err,
  isJiraIssueKey,
  jiraHost,
  ok,
  sameCommentText,
  type AdfDoc,
  type JiraCommentPayload,
  type Result,
} from "@bayon/core";
import { JIRA_STATUSES_MAX } from "@bayon/proto";
import { z } from "zod";
import {
  cap,
  checkLogin,
  checkSite,
  failure,
  getJson,
  postJson,
  type AtlassianApi,
  type AtlassianAuth,
  type AtlassianOptions,
  type Call,
} from "../atlassian/client.js";

// Jira's REST v3 writes for Jira following the ticket, and the status list the Settings
// view offers. Every call goes through the shared guards (../atlassian/client.ts): the site checked
// again before each request, no redirect followed, the answer capped, every message scrubbed of the
// token. Every answer is zod-parsed before anything reads it. An issue key reaches a URL path only
// after core's isJiraIssueKey has held it to `ABC-123`.

/** Jira's name for each thing the shared messages say, for a write. */
export const JIRA_PUSH_API: AtlassianApi = {
  product: "Jira",
  what: "the request",
  work: "the Jira update",
  mayBrowse:
    "transition issues and add comments in the issue's project (Jira's Transition Issues and Add Comments permissions)",
  loginPath: "/rest/api/3/myself",
};

const ISSUE = "/rest/api/3/issue";

export const callFor = (
  site: string,
  auth: AtlassianAuth,
  opts: AtlassianOptions,
): Call => ({ ...opts, api: JIRA_PUSH_API, site, auth });

/** What a push came to, when Jira did not refuse it. */
export type PushDone =
  | { readonly state: "sent" }
  | { readonly state: "skipped"; readonly reason: string };

const IssueStatus = z.object({
  fields: z.object({ status: z.object({ name: z.string() }) }),
});
const Transitions = z.object({
  transitions: z.array(
    z.object({
      id: z.string().min(1),
      to: z.object({ name: z.string() }),
    }),
  ),
});
const Statuses = z.array(z.object({ name: z.string() }));
const Comments = z.object({
  comments: z.array(z.object({ body: z.unknown() })),
});

/** How many of an issue's newest comments a retried comment looks through for itself. */
export const RECENT_COMMENTS = 50;

const same = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

function unreadable(call: Call, what: string, e: z.ZodError): Result<never> {
  return err(
    failure(
      call,
      "runner_error",
      `Jira at ${jiraHost(call.site)} answered ${what} with a body this cannot read: ${z.prettifyError(e)}`,
      false,
    ),
  );
}

async function read<T>(
  call: Call,
  path: string,
  schema: z.ZodType<T>,
  what: string,
): Promise<Result<T>> {
  const json = await getJson(call, `${call.site}${path}`);
  if (!json.ok) return json;
  const parsed = schema.safeParse(json.value);
  return parsed.success
    ? ok(parsed.data)
    : unreadable(call, what, parsed.error);
}

function checked(call: Call, key: string): Result<string> {
  const site = checkSite(call.site, call.api, call.auth);
  if (!site.ok) return site;
  return isJiraIssueKey(key)
    ? ok(`${ISSUE}/${encodeURIComponent(key)}`)
    : err(
        failure(
          call,
          "validation",
          `${cap(key)} is not a Jira issue key`,
          false,
        ),
      );
}

/**
 * Moves issue `key` to the status named `status`. Already there: skipped, as a no-op. No transition
 * from where it is leads to a status of that name (case-insensitive): skipped, with the statuses it
 * could reach — never a guess. Otherwise the one that does is posted.
 */
export async function transitionIssue(
  call: Call,
  key: string,
  status: string,
): Promise<Result<PushDone>> {
  const path = checked(call, key);
  if (!path.ok) return path;
  const now = await read(
    call,
    `${path.value}?fields=status`,
    IssueStatus,
    "the issue",
  );
  if (!now.ok) return now;
  const current = now.value.fields.status.name;
  if (same(current, status))
    return ok({
      state: "skipped",
      reason: `${key} is already ${cap(current)}`,
    });
  const offered = await read(
    call,
    `${path.value}/transitions`,
    Transitions,
    "its transitions",
  );
  if (!offered.ok) return offered;
  const match = offered.value.transitions.find((t) => same(t.to.name, status));
  if (match === undefined) {
    const reachable = offered.value.transitions.map((t) => t.to.name);
    return ok({
      state: "skipped",
      reason: cap(
        `${key} has no transition from ${current} to ${status}${reachable.length === 0 ? "" : ` (it can move to: ${reachable.join(", ")})`}`,
      ),
    });
  }
  const posted = await postJson(call, `${call.site}${path.value}/transitions`, {
    transition: { id: match.id },
  });
  return posted.ok ? ok({ state: "sent" }) : posted;
}

/** The comment's body as Jira takes it: ADF. */
export const commentBody = (p: JiraCommentPayload): { body: AdfDoc } => ({
  body: commentAdf(p),
});

/**
 * Adds the comment to issue `key`. A retry (`retry`: an earlier attempt was made) first reads the
 * issue's newest comments and, when one already says exactly this, settles as sent without posting:
 * the earlier POST landed and only its answer was lost (a crash, a timeout). A first attempt skips
 * the read. What remains is a comment edited in Jira before the retry, or buried under more than
 * RECENT_COMMENTS newer ones: that one is posted again.
 */
export async function commentIssue(
  call: Call,
  key: string,
  p: JiraCommentPayload,
  retry = false,
): Promise<Result<PushDone>> {
  const path = checked(call, key);
  if (!path.ok) return path;
  const body = commentBody(p);
  if (retry) {
    const recent = await read(
      call,
      `${path.value}/comment?orderBy=-created&maxResults=${RECENT_COMMENTS}`,
      Comments,
      "its comments",
    );
    if (!recent.ok) return recent;
    const text = adfText(body.body);
    if (
      recent.value.comments.some((c) => sameCommentText(adfText(c.body), text))
    )
      return ok({ state: "sent" });
  }
  const posted = await postJson(
    call,
    `${call.site}${path.value}/comment`,
    body,
  );
  return posted.ok ? ok({ state: "sent" }) : posted;
}

/**
 * Every status name the account can see on the site (`GET /rest/api/3/status`), deduped
 * case-insensitively and sorted: what the Settings view offers. Asked on the site as a whole
 * rather than per project, since the project's key would have to be guessed from its query. The
 * login is checked first: Jira answers a rejected token's read as anonymous.
 */
export async function listStatuses(call: Call): Promise<Result<string[]>> {
  const site = checkSite(call.site, call.api, call.auth);
  if (!site.ok) return site;
  const login = await checkLogin(call);
  if (!login.ok) return login;
  const listed = await read(
    call,
    "/rest/api/3/status",
    Statuses,
    "the statuses",
  );
  if (!listed.ok) return listed;
  const byKey = new Map<string, string>();
  for (const { name } of listed.value) {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > JIRA_STATUS_NAME_MAX) continue;
    if (!byKey.has(trimmed.toLowerCase()))
      byKey.set(trimmed.toLowerCase(), trimmed);
  }
  return ok(
    [...byKey.values()]
      .toSorted((a, b) => a.localeCompare(b))
      .slice(0, JIRA_STATUSES_MAX),
  );
}
