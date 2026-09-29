// A local stand-in for a Jira Cloud site, for tests only: no test ever reaches a real
// Jira. A `node:http` server on 127.0.0.1 answers the search the client makes, from an in-memory
// set of issues and a JQL → issue-ids table, and `/myself`, the login check, as a
// logged-in account; and records every request it saw (its headers included, so a test can check
// where the token went). `fetchVia` is the client's injected fetch:
// it sends a request for `https://<name>.atlassian.net/...` to this server instead, unchanged.
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Fetch } from "./client.js";

export const FIXTURE_SITE = "https://acme.atlassian.net";

export interface FixtureIssue {
  readonly id: string;
  readonly key: string;
  readonly summary: string;
  readonly status?: string;
  /** `new`, `indeterminate` or `done`. */
  readonly category?: string;
  readonly type?: string;
  readonly priority?: string;
  readonly description?: unknown;
  readonly parent?: { readonly key: string; readonly summary: string };
}

export interface SeenRequest {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly authorization: string | undefined;
  readonly accept: string | undefined;
}

/**
 * What one request gets instead of a search answer: a status and body (with extra headers), the
 * body in chunks with no Content-Length, a hang, or a redirect.
 */
export type Override =
  | {
      readonly status: number;
      readonly body: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly status: number; readonly chunks: readonly string[] }
  | { readonly hang: true }
  | { readonly redirect: string };

export interface JiraFixture {
  readonly origin: string;
  readonly requests: SeenRequest[];
  /** The issues by id: what `id in (…)` finds. */
  readonly issues: Map<string, FixtureIssue>;
  /** A JQL's result, as ids in order; a JQL not here matches nothing. */
  readonly queries: Map<string, readonly string[]>;
  /** Ids an `id in (…)` refuses with a 400, as Jira refuses an issue it cannot show. */
  readonly refusedIds: Set<string>;
  /** Issues per page (Jira's own maxResults is honoured up to this). */
  pageSize: number;
  /** Answers the next searches instead of the search, one each, in order; never `/myself`. */
  readonly overrides: Override[];
  /** Answers the next `/myself` requests instead of the logged-in account, one each, in order. */
  readonly loginOverrides: Override[];
  /** The client's fetch: `site`'s requests to this server; any other url is refused, never sent. */
  fetchVia(site?: string): Fetch;
  close(): Promise<void>;
}

export const issueJson = (i: FixtureIssue) => ({
  id: i.id,
  key: i.key,
  self: `${FIXTURE_SITE}/rest/api/3/issue/${i.id}`,
  fields: {
    summary: i.summary,
    description: i.description ?? null,
    issuetype: { name: i.type ?? "Story" },
    priority: i.priority === undefined ? null : { name: i.priority },
    ...(i.parent === undefined
      ? {}
      : {
          parent: {
            id: "1",
            key: i.parent.key,
            fields: { summary: i.parent.summary },
          },
        }),
    status: {
      name: i.status ?? "To Do",
      statusCategory: { key: i.category ?? "new" },
    },
  },
});

export const SEARCH_PATH = "/rest/api/3/search/jql";
export const LOGIN_PATH = "/rest/api/3/myself";

/** What `/myself` answers a logged-in account: more than the client reads, as Jira's does. */
export const MYSELF = {
  self: "https://acme.atlassian.net/rest/api/3/user?accountId=5b10ac8d82e05b22cc7d4ef5",
  accountId: "5b10ac8d82e05b22cc7d4ef5",
  accountType: "atlassian",
  displayName: "Fixture Operator",
  active: true,
};

const ID_IN = /^id in \(([0-9,]*)\)$/;

function search(f: JiraFixture, query: URLSearchParams) {
  const jql = query.get("jql") ?? "";
  const byIds = ID_IN.exec(jql);
  const ids = byIds
    ? (byIds[1] ?? "").split(",").filter((id) => f.issues.has(id))
    : (f.queries.get(jql) ?? []);
  if (byIds && (byIds[1] ?? "").split(",").some((id) => f.refusedIds.has(id))) {
    return {
      status: 400,
      body: {
        errorMessages: ["An issue with key does not exist for field 'id'."],
        errors: {},
      },
    };
  }
  const start = Number(query.get("nextPageToken") ?? "0");
  const size = Math.min(f.pageSize, Number(query.get("maxResults") ?? "50"));
  const page = ids.slice(start, start + size);
  const end = start + page.length;
  const last = end >= ids.length;
  return {
    status: 200,
    body: {
      issues: page.flatMap((id) => {
        const issue = f.issues.get(id);
        return issue === undefined ? [] : [issueJson(issue)];
      }),
      ...(last ? {} : { nextPageToken: String(end) }),
      isLast: last,
    },
  };
}

export async function startJiraFixture(): Promise<JiraFixture> {
  const hung: ServerResponse[] = [];
  const fixture: Omit<JiraFixture, "origin" | "fetchVia" | "close"> = {
    requests: [],
    issues: new Map(),
    queries: new Map(),
    refusedIds: new Set(),
    pageSize: 100,
    overrides: [],
    loginOverrides: [],
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    fixture.requests.push({
      path: url.pathname,
      query: url.searchParams,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
    });
    const login = url.pathname === LOGIN_PATH;
    const override = (
      login ? fixture.loginOverrides : fixture.overrides
    ).shift();
    if (override !== undefined && "hang" in override) {
      hung.push(res);
      return;
    }
    if (override !== undefined && "redirect" in override) {
      res.writeHead(302, { location: override.redirect }).end();
      return;
    }
    if (override !== undefined && "chunks" in override) {
      res.writeHead(override.status, { "content-type": "application/json" });
      for (const chunk of override.chunks) res.write(chunk);
      res.end();
      return;
    }
    if (override !== undefined) {
      res
        .writeHead(override.status, {
          "content-type": "application/json",
          ...override.headers,
        })
        .end(override.body);
      return;
    }
    if (login) {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(MYSELF));
      return;
    }
    if (url.pathname !== SEARCH_PATH) {
      res.writeHead(404).end("{}");
      return;
    }
    const answer = search(fixture as JiraFixture, url.searchParams);
    res
      .writeHead(answer.status, { "content-type": "application/json" })
      .end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return Object.assign(fixture, {
    origin,
    fetchVia:
      (site = FIXTURE_SITE): Fetch =>
      (url, init) =>
        url.startsWith(`${site}/`)
          ? fetch(`${origin}${url.slice(site.length)}`, init)
          : Promise.reject(new Error(`the fixture serves ${site} only`)),
    close: async () => {
      for (const res of hung) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}
