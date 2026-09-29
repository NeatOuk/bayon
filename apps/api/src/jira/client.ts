import { JiraIssue, err, ok, type Result } from "@bayon/core";
import { z } from "zod";
import {
  ATLASSIAN_MAX_BODY_BYTES,
  ATLASSIAN_MESSAGE_MAX,
  cap,
  checkLogin,
  checkSite,
  failure,
  getJson,
  scrubSecret as scrubFor,
  type AtlassianApi,
  type AtlassianAuth,
  type AtlassianOptions,
  type Call,
  type Fetch,
} from "../atlassian/client.js";

// Jira Cloud's REST v3 search, read-only. The guards this rests on are the shared ones
// (../atlassian/client.ts): the site is checked again there before every request, whatever wrote it;
// a redirect is refused rather than followed, so no 3xx can carry the header to another host; the
// body is capped; and no message this returns names the token or the header (each is scrubbed of
// both as it is built). Every response is zod-parsed before anything reads it.
//
// Jira Cloud serves a rejected email and token pair as anonymous, and an anonymous search is a 200
// with no issues: so a search first asks `/myself` who the auth logs in as, and any
// answer Jira marks as served anonymously (X-Seraph-LoginReason) fails the same way.

export type { Fetch };

/** Jira's name for each thing the shared messages say (its strings are unchanged by the split). */
const JIRA_API: AtlassianApi = {
  product: "Jira",
  what: "the search",
  work: "the Jira sync",
  mayBrowse: "browse the query's projects",
  /** Who the auth logs in as: a bad email and token pair is 401 here, not an anonymous 200. */
  loginPath: "/rest/api/3/myself",
};

export type JiraAuth = AtlassianAuth;
export type JiraClientOptions = AtlassianOptions;

export interface SearchOptions extends JiraClientOptions {
  /** Each page's issues, in order, before the next page is read; an error stops the search. */
  readonly onPage: (issues: readonly JiraIssue[]) => Promise<Result<void>>;
  /** At most this many issues are read (JIRA_MAX_ISSUES); past it the search is `capped`. */
  readonly maxIssues?: number;
}

export interface SearchDone {
  readonly fetched: number;
  /** The query matched more than `maxIssues`: the result is incomplete. */
  readonly capped: boolean;
}

export const JIRA_TIMEOUT_MS = 30_000;
export const JIRA_PAGE_SIZE = 100;
export const JIRA_MAX_ISSUES = 1_000;
/** The largest answer read: a page of 100 issues is far smaller; anything past it is refused. */
export const JIRA_MAX_BODY_BYTES = ATLASSIAN_MAX_BODY_BYTES;
/** The longest message kept from Jira's own error body. */
export const JIRA_MESSAGE_MAX = ATLASSIAN_MESSAGE_MAX;
const SEARCH_PATH = "/rest/api/3/search/jql";

const SearchPage = z.object({
  issues: z.array(JiraIssue),
  nextPageToken: z.string().min(1).nullish(),
  isLast: z.boolean().nullish(),
});
type SearchPage = z.infer<typeof SearchPage>;

/** `message` without the token or the Basic pair built from it (the shared scrub). */
export const scrubSecret = (message: string, auth: JiraAuth): string =>
  scrubFor(message, auth);

const RefusedQuery = z.object({ http_status: z.literal(400) });

const callOf = (
  site: string,
  auth: JiraAuth,
  opts: JiraClientOptions,
): Call => ({
  ...opts,
  api: JIRA_API,
  site,
  auth,
});

async function fetchPage(
  call: Call,
  jql: string,
  fields: readonly string[],
  pageToken: string | undefined,
): Promise<Result<SearchPage>> {
  const url = new URL(`${call.site}${SEARCH_PATH}`);
  url.searchParams.set("jql", jql);
  url.searchParams.set("fields", fields.join(","));
  url.searchParams.set("maxResults", String(JIRA_PAGE_SIZE));
  if (pageToken !== undefined) url.searchParams.set("nextPageToken", pageToken);
  const json = await getJson(call, url.toString());
  if (!json.ok) return json;
  const page = SearchPage.safeParse(json.value);
  return page.success
    ? ok(page.data)
    : err(
        failure(
          call,
          "runner_error",
          `Jira at ${call.site.slice("https://".length)} answered a search this cannot read: ${z.prettifyError(page.error)}`,
          false,
        ),
      );
}

interface Search {
  readonly call: Call;
  readonly jql: string;
  readonly fields: readonly string[];
  readonly onPage: SearchOptions["onPage"];
  readonly max: number;
}

async function pagesFrom(
  s: Search,
  pageToken: string | undefined,
  fetched: number,
): Promise<Result<SearchDone>> {
  const page = await fetchPage(s.call, s.jql, s.fields, pageToken);
  if (!page.ok) return page;
  const { issues, nextPageToken, isLast } = page.value;
  const room = s.max - fetched;
  const taken = issues.slice(0, room);
  if (taken.length > 0) {
    const handled = await s.onPage(taken);
    if (!handled.ok) return handled;
  }
  const total = fetched + taken.length;
  // An empty page ends the search whatever it says, so a token that repeats cannot loop.
  const next =
    isLast !== true && issues.length > 0
      ? (nextPageToken ?? undefined)
      : undefined;
  if (issues.length > room || (next !== undefined && total >= s.max)) {
    return ok({ fetched: total, capped: true });
  }
  return next === undefined
    ? ok({ fetched: total, capped: false })
    : pagesFrom(s, next, total);
}

const ISSUE_ID = /^[0-9]{1,20}$/;

/**
 * Every issue `jql` matches on `site`, page by page (`nextPageToken`, 100 a page) up to
 * `maxIssues`, each page handed to `onPage` before the next is read. Returns how many were read and
 * whether the query matched more (`capped`). The login is checked first (`/myself`): Jira answers a
 * rejected email and token pair's search as anonymous, 200 with no issues.
 */
export async function searchJql(
  site: string,
  auth: JiraAuth,
  jql: string,
  fields: readonly string[],
  opts: SearchOptions,
): Promise<Result<SearchDone>> {
  const checked = checkSite(site, JIRA_API, auth);
  if (!checked.ok) return checked;
  const call = callOf(site, auth, opts);
  const login = await checkLogin(call);
  if (!login.ok) return login;
  return pagesFrom(
    {
      call,
      jql,
      fields,
      onPage: opts.onPage,
      max: opts.maxIssues ?? JIRA_MAX_ISSUES,
    },
    undefined,
    0,
  );
}

/** One batch by id; a refused batch (Jira refuses an `id in` naming an issue it cannot show) is
 * split in half until the issues it can show are found, and one it refuses alone is gone. */
async function byIdBatch(
  call: Call,
  ids: readonly string[],
  fields: readonly string[],
): Promise<Result<readonly JiraIssue[]>> {
  const found: JiraIssue[] = [];
  const searched = await pagesFrom(
    {
      call,
      jql: `id in (${ids.join(",")})`,
      fields,
      max: ids.length,
      onPage: async (issues) => {
        found.push(...issues);
        return ok(undefined);
      },
    },
    undefined,
    0,
  );
  if (searched.ok) return ok(found);
  if (!RefusedQuery.safeParse(searched.error.cause).success) return searched;
  if (ids.length === 1) return ok([]);
  const half = Math.ceil(ids.length / 2);
  const [left, right] = [ids.slice(0, half), ids.slice(half)];
  const a = await byIdBatch(call, left, fields);
  if (!a.ok) return a;
  const b = await byIdBatch(call, right, fields);
  return b.ok ? ok([...a.value, ...b.value]) : b;
}

/**
 * The issues of `ids` that `site` still shows, by the same search (`id in (…)`, 100 ids a batch):
 * how a sync learns why a known issue left its query. An id it cannot show is simply absent. No
 * `/myself` of its own: a sync calls it after `searchJql` checked the login, and each answer is
 * still refused if Jira served it anonymously.
 */
export async function getByIds(
  site: string,
  auth: JiraAuth,
  ids: readonly string[],
  fields: readonly string[],
  opts: JiraClientOptions,
): Promise<Result<readonly JiraIssue[]>> {
  const bad = ids.find((id) => !ISSUE_ID.test(id));
  if (bad !== undefined) {
    return err({
      class: "validation",
      message: `${cap(bad)} is not a Jira issue id`,
      retryable: false,
    });
  }
  const checked = checkSite(site, JIRA_API, auth);
  if (!checked.ok) return checked;
  const call = callOf(site, auth, opts);
  const batches = Array.from(
    { length: Math.ceil(ids.length / JIRA_PAGE_SIZE) },
    (_, i) => ids.slice(i * JIRA_PAGE_SIZE, (i + 1) * JIRA_PAGE_SIZE),
  );
  const found: JiraIssue[] = [];
  for (const batch of batches) {
    const issues = await byIdBatch(call, batch, fields);
    if (!issues.ok) return issues;
    found.push(...issues.value);
  }
  return ok(found);
}
