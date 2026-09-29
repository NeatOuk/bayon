import {
  JIRA_TOKEN_SECRET,
  docsSpaceAllowed,
  err,
  ok,
  type DocsSourceFields,
  type Result,
} from "@bayon/core";
import { storeTokenHint, type JiraTokenStore } from "../jira/token.js";
import {
  DOCS_TIMEOUT_MS,
  getPage,
  searchPages,
  type DocsHit,
  type DocsPage,
  type Fetch,
} from "./client.js";

// What `doc_search` and `doc_get` call: one project's documentation source, the token
// the Jira mirror already uses, and the two rules that decide what an agent may read.
//
// The token is read from the host secret store **at call time**, handed to the client's Authorization
// header, and goes nowhere else — not a log line, an audit payload, an error or a tool result (§14,
// Invariant 11). The same secret as the mirror's: one Atlassian account, one token, two read-only
// surfaces.
//
// The refusals live here rather than in the handler, because each is about what the operator
// granted and none of them is an error:
//
//   * a project whose source is `none` has nothing to read — `no_source`;
//   * a search asked for a space the project did not grant — `out_of_space`, which names that space
//     and the granted list, because the space came from the caller and the search is already held
//     to the project's own list;
//   * a page that is not the project's — `unavailable`.
//
// `unavailable` is **one** answer for two different facts: the page is outside the granted spaces,
// and the page does not exist. They must be indistinguishable. Confluence page ids are shared and
// roughly sequential across a site, so an agent that could tell them apart could walk the id space
// with the operator's own token and map the tenant's pages and space keys one id at a time — and a
// hostile page in a granted space could instruct it to do exactly that and write down what it found.
// So the refusal names no space, not even a granted one, and a 404 from the site is folded into it
// rather than returned as a failure of its own: same reason, same rule, same sentence, same shape.

/** Why a read was refused rather than failed. */
export type DocsRefusal = "no_source" | "out_of_space" | "unavailable";

export interface DocsRefused {
  readonly refused: DocsRefusal;
  readonly detail: string;
}

/** A read's outcome: the value, a refusal the agent can act on, or a typed failure. */
export type DocsResult<T> = Result<T | DocsRefused>;

export const isDocsRefused = (value: unknown): value is DocsRefused =>
  typeof value === "object" && value !== null && "refused" in value;

const refuse = (refused: DocsRefusal, detail: string): DocsRefused => ({
  refused,
  detail,
});

const NO_SOURCE =
  "this project has no documentation source: set one in the project's Settings";

/**
 * What a page outside the project's spaces and a page that is not there both say. It names no
 * space and no page: the caller learns that this reference is not theirs to read, and nothing else.
 */
export const PAGE_UNAVAILABLE = "that page is not available to this project";

export interface DocsReaderDeps {
  /** The host store the Jira mirror reads its token from: the same token, the same lookup. */
  readonly token: JiraTokenStore;
  /** Injected: tests point it at a local fixture server. */
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
  /** Aborts every request in flight: the API stopping. */
  readonly signal?: AbortSignal;
}

export interface DocsSearchAsked {
  readonly query: string;
  readonly space?: string | undefined;
  readonly limit: number;
}

/**
 * One project's documentation, read on a session's behalf. Holds no project of its own: every call
 * is given the source the caller resolved from the session's token.
 */
export class DocsReader {
  readonly #token: JiraTokenStore;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;
  readonly #signal: AbortSignal | undefined;

  constructor(deps: DocsReaderDeps) {
    this.#token = deps.token;
    this.#fetch = deps.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = deps.timeoutMs ?? DOCS_TIMEOUT_MS;
    this.#signal = deps.signal;
  }

  /** The pages of `source` matching `asked.query`, inside the spaces the project granted. */
  async search(
    source: DocsSourceFields,
    asked: DocsSearchAsked,
  ): Promise<DocsResult<readonly DocsHit[]>> {
    const call = await this.#call(source);
    if (!call.ok) return call;
    if (isDocsRefused(call.value)) return ok(call.value);
    const { site, auth } = call.value;
    // A space the project did not grant is refused here, before any request: the CQL the client
    // builds is constrained to the project's own list, and asking past it is not a search, it is
    // a question about what the operator granted.
    if (asked.space !== undefined && !docsSpaceAllowed(source, asked.space)) {
      return ok(outOfSpace(source, asked.space));
    }
    const found = await searchPages(
      site,
      auth,
      {
        query: asked.query,
        allowed: source.spaces,
        ...(asked.space === undefined ? {} : { space: asked.space }),
        limit: asked.limit,
      },
      this.#options(),
    );
    return found.ok ? ok(found.value) : found;
  }

  /**
   * One page of `source` by id or by a link on its own site. A page outside the project's spaces
   * and a page the site does not have come back as the **same** refusal: an id is guessable, so
   * telling the two apart would be a directory of the tenant's pages.
   */
  async get(
    source: DocsSourceFields,
    ref: string,
  ): Promise<DocsResult<DocsPage>> {
    const call = await this.#call(source);
    if (!call.ok) return call;
    if (isDocsRefused(call.value)) return ok(call.value);
    const { site, auth } = call.value;
    // The client resolves the reference itself: a link to another host is refused there, where the
    // request would be made.
    const page = await getPage(site, auth, ref, this.#options());
    if (!page.ok) {
      // The site's "no such page" becomes this project's "not yours to read", so a caller cannot
      // separate a page that is missing from one it was never granted.
      return page.error.class === "not_found"
        ? ok(refuse("unavailable", PAGE_UNAVAILABLE))
        : page;
    }
    return docsSpaceAllowed(source, page.value.space)
      ? ok(page.value)
      : ok(refuse("unavailable", PAGE_UNAVAILABLE));
  }

  #options() {
    return {
      fetch: this.#fetch,
      timeoutMs: this.#timeoutMs,
      ...(this.#signal === undefined ? {} : { signal: this.#signal }),
    };
  }

  /** The site and the auth for `source`, or the refusal that stands in their place. */
  async #call(source: DocsSourceFields): Promise<
    Result<
      | DocsRefused
      | {
          readonly site: string;
          readonly auth: { readonly email: string; readonly token: string };
        }
    >
  > {
    if (
      source.kind === "none" ||
      source.url === null ||
      source.email === null
    ) {
      return ok(refuse("no_source", NO_SOURCE));
    }
    const token = await this.#token.secrets.get(JIRA_TOKEN_SECRET);
    if (!token.ok) {
      // The store's own message names the secret, never its value.
      return err({
        class: "validation",
        message: `${JIRA_TOKEN_SECRET} could not be read from the host secret store (${token.error.message}), so this project's documentation cannot be read: ${storeTokenHint(this.#token)}`,
        retryable: false,
      });
    }
    return ok({
      site: source.url,
      auth: { email: source.email, token: token.value },
    });
  }
}

/**
 * The refusal a **search** gets for a space the project did not grant. It names that space and the
 * granted list, which leaks nothing: the space came from the caller, and the list is what the
 * operator gave this project. `doc_get` never uses it — see `PAGE_UNAVAILABLE`.
 */
function outOfSpace(source: DocsSourceFields, space: string): DocsRefused {
  return refuse(
    "out_of_space",
    `${space} is not one of this project's documentation spaces (${source.spaces.join(", ")})`,
  );
}
