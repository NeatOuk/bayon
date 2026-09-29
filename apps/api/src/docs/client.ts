import {
  docsSearchCql,
  err,
  jiraHost,
  ok,
  pageMarkdown,
  storageToText,
  trimPage,
  type Result,
} from "@bayon/core";
import { z } from "zod";
import {
  checkLogin,
  checkSite,
  failure,
  getJson,
  refused,
  type AtlassianApi,
  type AtlassianAuth,
  type AtlassianOptions,
  type Call,
  type Fetch,
  type Refuse,
} from "../atlassian/client.js";

// Confluence Cloud's REST v1, read-only. Every security control is the shared one
// (../atlassian/client.ts): the site pin, the refused redirect, the body cap, the scrub and the
// login check. What is here is the two endpoints, their answers read loosely, and the two rules
// this product needs — a page reference that may be a link, and a space key that must be one the
// project granted.
//
// Nothing here names a site, a space or a page: a project says where its documentation lives.

export type { Fetch };

/** Confluence's name for each thing the shared messages say. */
export const CONFLUENCE_API: AtlassianApi = {
  product: "Confluence",
  what: "the request",
  work: "the documentation read",
  mayBrowse: "read the project's spaces",
  /** Who the auth logs in as, on this product: a rejected pair is 401 here, not an empty search. */
  loginPath: "/wiki/rest/api/user/current",
};

export type DocsAuth = AtlassianAuth;
export type DocsClientOptions = AtlassianOptions;

export const DOCS_TIMEOUT_MS = 20_000;
/** A page of search results: far smaller than a page of documentation, and bounded. */
export const DOCS_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** The longest page Markdown one `doc_get` returns; §8.5's backstop then caps the whole result. */
export const DOCS_MARKDOWN_MAX = 60_000;
/** A search row's excerpt: enough to decide whether to read the page. */
export const DOCS_EXCERPT = 240;

const SEARCH_PATH = "/wiki/rest/api/search";
const CONTENT_PATH = "/wiki/rest/api/content";
/** Everything `doc_get` reads of a page, in one request. */
const CONTENT_EXPAND = "space,body.atlas_doc_format,body.storage";

export interface DocsPage {
  readonly id: string;
  readonly title: string;
  /** The space key, or "" when the site did not say: the allowlist then refuses it. */
  readonly space: string;
  readonly url: string;
  readonly markdown: string;
}

export interface DocsHit {
  readonly id: string;
  readonly title: string;
  readonly space: string;
  readonly url: string;
  readonly excerpt: string;
}

/** A page id as Confluence spells one. */
const PAGE_ID = /^[0-9]{1,20}$/;
/** Where a page id sits in a Confluence link, new style and old. */
const IN_PATH = /\/pages\/(\d{1,20})(?:\/|$)/;

/**
 * The page id `ref` names: a bare id, or a link **into this project's own site**. A link anywhere
 * else is refused without a request — a `ref` is model-supplied text, and the one thing that must
 * not follow from it is a request to a host the operator never named.
 */
export function docsPageId(ref: string, site: string): Result<string> {
  const trimmed = ref.trim();
  if (PAGE_ID.test(trimmed)) return ok(trimmed);
  const url = URL.parse(trimmed);
  if (url === null) {
    return err({
      class: "validation",
      message: `${trimmed.slice(0, 120)} is neither a page id nor a link`,
      retryable: false,
    });
  }
  if (url.origin !== site) {
    return err({
      class: "validation",
      message: `that link is not on ${jiraHost(site)}, this project's documentation site`,
      retryable: false,
    });
  }
  const id = IN_PATH.exec(url.pathname)?.[1] ?? url.searchParams.get("pageId");
  return id !== null && id !== undefined && PAGE_ID.test(id)
    ? ok(id)
    : err({
        class: "validation",
        message: "that link names no page id",
        retryable: false,
      });
}

const Links = z
  .object({ webui: z.string().optional().catch(undefined) })
  .nullish()
  .catch(undefined);

const Space = z
  .object({ key: z.string().optional().catch(undefined) })
  .nullish()
  .catch(undefined);

const Body = z
  .object({
    atlas_doc_format: z
      .object({ value: z.unknown() })
      .nullish()
      .catch(undefined),
    storage: z.object({ value: z.unknown() }).nullish().catch(undefined),
  })
  .nullish()
  .catch(undefined);

const Content = z.object({
  id: z.string(),
  title: z.string().optional().catch(undefined),
  space: Space,
  body: Body,
  _links: Links,
});

const SearchAnswer = z.object({
  results: z.array(
    z.object({
      content: z
        .object({
          id: z.string(),
          title: z.string().optional().catch(undefined),
          space: Space,
          _links: Links,
        })
        .nullish()
        .catch(undefined),
      title: z.string().optional().catch(undefined),
      excerpt: z.string().optional().catch(undefined),
      url: z.string().optional().catch(undefined),
    }),
  ),
});

const callOf = (
  site: string,
  auth: DocsAuth,
  opts: DocsClientOptions,
): Call => ({
  maxBodyBytes: DOCS_MAX_BODY_BYTES,
  ...opts,
  api: CONFLUENCE_API,
  site,
  auth,
});

const unreadable = (call: Call, what: string, why: string) =>
  failure(
    call,
    "runner_error",
    `Confluence at ${jiraHost(call.site)} answered ${what} this cannot read: ${why}`,
    false,
  );

/** A site-relative `webui` or `url` path as the link an agent can open. */
const linkOf = (site: string, path: string | undefined): string =>
  path === undefined || path === ""
    ? site
    : path.startsWith("http")
      ? path
      : `${site}/wiki${path.startsWith("/") ? path : `/${path}`}`;

/** Confluence marks the matched words in an excerpt; the markers are noise in a prompt. */
const HIGHLIGHT = /@@@(?:end)?hl@@@/g;

const excerptOf = (raw: string | undefined): string => {
  const text = storageToText((raw ?? "").replace(HIGHLIGHT, ""));
  return text.length <= DOCS_EXCERPT ? text : `${text.slice(0, DOCS_EXCERPT)}…`;
};

/** A 404 is "no such page", not a refusal to answer: the caller says so in its own words. */
const notFound: Refuse = (call, status, body) =>
  status === 404
    ? failure(call, "not_found", "that page is not on this site", false, 404)
    : refused(call, status, body);

export interface DocsSearchInput {
  /** The agent's words; escaped into CQL, never concatenated. */
  readonly query: string;
  /** The spaces the project allows; empty means any the account can read. */
  readonly allowed: readonly string[];
  /** One of `allowed`, checked by the caller before this is built. */
  readonly space?: string | undefined;
  readonly limit: number;
}

/**
 * The pages of `site` matching `query`, inside the spaces the project allows. The login is checked
 * first: Confluence serves a rejected email and token pair as anonymous, and an anonymous search
 * is a 200 with no results.
 */
export async function searchPages(
  site: string,
  auth: DocsAuth,
  input: DocsSearchInput,
  opts: DocsClientOptions,
): Promise<Result<readonly DocsHit[]>> {
  const checked = checkSite(site, CONFLUENCE_API, auth);
  if (!checked.ok) return checked;
  const call = callOf(site, auth, opts);
  const login = await checkLogin(call);
  if (!login.ok) return login;
  const url = new URL(`${site}${SEARCH_PATH}`);
  url.searchParams.set(
    "cql",
    docsSearchCql({
      query: input.query,
      allowed: input.allowed,
      space: input.space,
    }),
  );
  url.searchParams.set("limit", String(input.limit));
  url.searchParams.set("expand", "content.space");
  const json = await getJson(call, url.toString());
  if (!json.ok) return json;
  const answer = SearchAnswer.safeParse(json.value);
  if (!answer.success) {
    return err(unreadable(call, "a search", z.prettifyError(answer.error)));
  }
  return ok(
    answer.data.results.flatMap((row) => {
      const content = row.content;
      if (content === null || content === undefined) return [];
      return [
        {
          id: content.id,
          title: content.title ?? row.title ?? "",
          space: content.space?.key ?? "",
          url: linkOf(site, row.url ?? content._links?.webui),
          excerpt: excerptOf(row.excerpt),
        },
      ];
    }),
  );
}

/**
 * One page of `site` by id or by a link into it, with its space and its body. The reference is
 * resolved **here**, where the request is made, so a link to another host is refused before a
 * request rather than trusted from a caller. The body is `atlas_doc_format`, which Confluence hands
 * back as a JSON string — core parses it before converting; a page without one falls back to its
 * storage text. No login check of its own: `doc_get` reads one page, and an answer served
 * anonymously is still refused by the shared guard.
 */
export async function getPage(
  site: string,
  auth: DocsAuth,
  ref: string,
  opts: DocsClientOptions,
): Promise<Result<DocsPage>> {
  const checked = checkSite(site, CONFLUENCE_API, auth);
  if (!checked.ok) return checked;
  const found = docsPageId(ref, site);
  if (!found.ok) return found;
  const id = found.value;
  const call = callOf(site, auth, opts);
  const url = new URL(`${site}${CONTENT_PATH}/${id}`);
  url.searchParams.set("expand", CONTENT_EXPAND);
  const json = await getJson(call, url.toString(), notFound);
  if (!json.ok) return json;
  const content = Content.safeParse(json.value);
  if (!content.success) {
    return err(unreadable(call, "a page", z.prettifyError(content.error)));
  }
  const page = content.data;
  const markdown = pageMarkdown({
    adf: page.body?.atlas_doc_format?.value,
    storage: page.body?.storage?.value,
  });
  return ok({
    id: page.id,
    title: page.title ?? "",
    space: page.space?.key ?? "",
    url: linkOf(site, page._links?.webui),
    markdown: trimPage(markdown, DOCS_MARKDOWN_MAX),
  });
}
