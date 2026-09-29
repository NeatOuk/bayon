// A local stand-in for a Confluence Cloud site, for tests only: no test ever reaches a
// real one. A `node:http` server on 127.0.0.1 answers the two requests the client makes — the CQL
// search and one page by id — from an in-memory set of pages, and the current-user call, as a
// logged-in account; and records every request it saw (its headers included, so a test can check
// where the token went). `fetchVia` is the client's injected fetch: it sends a request for
// `https://<name>.atlassian.net/...` to this server instead, unchanged.
//
// The site, the space keys and the page titles here are placeholders. Bayon knows nothing about any
// particular documentation site, and neither does this fixture.
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Fetch } from "./client.js";

export const FIXTURE_DOCS_SITE = "https://acme.atlassian.net";

export interface FixturePage {
  readonly id: string;
  readonly title: string;
  readonly space: string;
  /** The `atlas_doc_format` value: a document, or the JSON string of one. */
  readonly adf?: unknown;
  /** The `storage` value, used when there is no ADF. */
  readonly storage?: string;
  /** What a search row's excerpt says; the title otherwise. */
  readonly excerpt?: string;
}

export interface SeenDocsRequest {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly authorization: string | undefined;
  readonly accept: string | undefined;
}

/** What one request gets instead of the answer: a status and body, chunks, a hang, or a redirect. */
export type DocsOverride =
  | {
      readonly status: number;
      readonly body: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly status: number; readonly chunks: readonly string[] }
  | { readonly hang: true }
  | { readonly redirect: string };

export interface DocsFixture {
  readonly origin: string;
  readonly requests: SeenDocsRequest[];
  /** The pages by id: what a get finds and what a search matches. */
  readonly pages: Map<string, FixturePage>;
  /** A CQL's result, as ids in order; a CQL not here matches every page whose space is allowed. */
  readonly queries: Map<string, readonly string[]>;
  /** Answers the next searches instead of the search, one each, in order. */
  readonly overrides: DocsOverride[];
  /** Answers the next page reads instead of the page, one each, in order. */
  readonly pageOverrides: DocsOverride[];
  /** Answers the next current-user requests instead of the logged-in account, one each, in order. */
  readonly loginOverrides: DocsOverride[];
  /** The client's fetch: `site`'s requests to this server; any other url is refused, never sent. */
  fetchVia(site?: string): Fetch;
  close(): Promise<void>;
}

export const SEARCH_PATH = "/wiki/rest/api/search";
export const CONTENT_PATH = "/wiki/rest/api/content";
export const DOCS_LOGIN_PATH = "/wiki/rest/api/user/current";

/** What the current-user call answers: more than the client reads, as Confluence's does. */
export const CURRENT_USER = {
  type: "known",
  accountId: "5b10ac8d82e05b22cc7d4ef5",
  accountType: "atlassian",
  displayName: "Fixture Operator",
};

const webui = (p: FixturePage) =>
  `/spaces/${p.space}/pages/${p.id}/${encodeURIComponent(p.title)}`;

const contentJson = (p: FixturePage) => ({
  id: p.id,
  type: "page",
  status: "current",
  title: p.title,
  space: { key: p.space, name: p.space },
  body: {
    ...(p.adf === undefined
      ? {}
      : {
          atlas_doc_format: {
            value: typeof p.adf === "string" ? p.adf : JSON.stringify(p.adf),
            representation: "atlas_doc_format",
          },
        }),
    ...(p.storage === undefined
      ? {}
      : { storage: { value: p.storage, representation: "storage" } }),
  },
  _links: { webui: webui(p), base: `${FIXTURE_DOCS_SITE}/wiki` },
});

/** The space clause of a CQL: `space = "A"` or `space in ("A","B")`, as `docsSearchCql` writes it. */
const SPACE_CLAUSE =
  /\bspace (?:= "[A-Za-z0-9_]+"|in \((?:"[A-Za-z0-9_]+",?)+\))/;

/**
 * The space keys a CQL names: what the fixture holds the search to, as a real site would. Read
 * from the space clause alone — a key may be lower case, so a quoted query term is not one.
 */
const spacesOf = (cql: string): readonly string[] =>
  [
    ...(SPACE_CLAUSE.exec(cql)?.[0] ?? "").matchAll(/"([A-Za-z0-9_]+)"/g),
  ].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));

function search(f: DocsFixture, query: URLSearchParams) {
  const cql = query.get("cql") ?? "";
  const limit = Number(query.get("limit") ?? "20");
  const named = f.queries.get(cql);
  const spaces = spacesOf(cql);
  const ids =
    named ??
    [...f.pages.values()]
      .filter((p) => spaces.length === 0 || spaces.includes(p.space))
      .map((p) => p.id);
  const results = ids.slice(0, limit).flatMap((id) => {
    const page = f.pages.get(id);
    if (page === undefined) return [];
    const content = contentJson(page);
    return [
      {
        content: {
          id: content.id,
          type: "page",
          title: content.title,
          space: content.space,
          _links: content._links,
        },
        title: page.title,
        excerpt: page.excerpt ?? `@@@hl@@@${page.title}@@@endhl@@@ …`,
        url: webui(page),
        entityType: "content",
      },
    ];
  });
  return {
    status: 200,
    body: { results, start: 0, limit, size: results.length },
  };
}

export async function startDocsFixture(): Promise<DocsFixture> {
  const hung: ServerResponse[] = [];
  const fixture: Omit<DocsFixture, "origin" | "fetchVia" | "close"> = {
    requests: [],
    pages: new Map(),
    queries: new Map(),
    overrides: [],
    pageOverrides: [],
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
    const login = url.pathname === DOCS_LOGIN_PATH;
    const isPage = url.pathname.startsWith(`${CONTENT_PATH}/`);
    const queue = login
      ? fixture.loginOverrides
      : isPage
        ? fixture.pageOverrides
        : fixture.overrides;
    const override = queue.shift();
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
        .end(JSON.stringify(CURRENT_USER));
      return;
    }
    if (isPage) {
      const page = fixture.pages.get(
        url.pathname.slice(CONTENT_PATH.length + 1),
      );
      if (page === undefined) {
        res
          .writeHead(404, { "content-type": "application/json" })
          .end(
            JSON.stringify({ statusCode: 404, message: "No content found" }),
          );
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(contentJson(page)));
      return;
    }
    if (url.pathname !== SEARCH_PATH) {
      res.writeHead(404).end("{}");
      return;
    }
    const answer = search(fixture as DocsFixture, url.searchParams);
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
      (site = FIXTURE_DOCS_SITE): Fetch =>
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
