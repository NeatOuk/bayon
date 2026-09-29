// A project's documentation source: what kind it is, where it lives, and which of its
// spaces an agent may read. Pure — the rules only, no I/O and no product API.
//
// The site is held to the same origin the Jira source is (`jira/site.ts`): Bayon sends the
// operator's Atlassian token to it, and the value arrives over REST from any page on the LAN
// holding the operator's bearer. One rule, one place, so a docs source can no more point the token
// at an attacker's host than a Jira source can.
import { err, ok, type Result } from "../errors.js";

/** `workspaces.docs_kind`: a project with no documentation source, or a Confluence Cloud one. */
export const DOCS_KINDS = ["none", "confluence"] as const;
export type DocsKind = (typeof DOCS_KINDS)[number];

export const isDocsKind = (value: unknown): value is DocsKind =>
  typeof value === "string" &&
  (DOCS_KINDS as readonly string[]).includes(value);

/**
 * A Confluence space key as the operator grants it: letters of either case, digits and underscores.
 * Confluence Cloud keys can be mixed case (`Docs`), so the case is the site's, kept as typed.
 * Personal spaces (`~accountid`) are deliberately outside it — a project's docs are a team's.
 */
export const DOCS_SPACE_KEY = /^[A-Za-z0-9_]{1,50}$/;

export const isDocsSpaceKey = (value: string): boolean =>
  DOCS_SPACE_KEY.test(value);

/** The most spaces one project may name: a list, not a directory. */
export const DOCS_SPACES_MAX = 20;

/** A project's documentation source as stored and served. */
export interface DocsSourceFields {
  readonly kind: DocsKind;
  /** The site; null only while `kind` is `none`. */
  readonly url: string | null;
  /** The Atlassian account the token belongs to; null only while `kind` is `none`. */
  readonly email: string | null;
  /** The space keys an agent may read; empty means any space the account can read. */
  readonly spaces: readonly string[];
}

/** What a project without a documentation source reads as. */
export const NO_DOCS_SOURCE: DocsSourceFields = {
  kind: "none",
  url: null,
  email: null,
  spaces: [],
};

/**
 * Whether `space` is one an agent of this source may read: any, when the source names none;
 * otherwise exactly one it names. Case-sensitive, never folded: a grant of `Docs` is not `DOCS`.
 */
export const docsSpaceAllowed = (
  source: DocsSourceFields,
  space: string,
): boolean => source.spaces.length === 0 || source.spaces.includes(space);

/** Where a "same as Jira" documentation source takes its site and account from. */
export interface DocsDefaults {
  readonly url: string;
  readonly email: string;
}

/**
 * The documentation source to store: `none` clears the site and the account, and a source with no
 * site or no account of its own takes them from `jira`. Neither, and with no Jira source, is a
 * validation refusal naming the field rather than a half-written row — and rather than a database
 * constraint message, which is what `POST /projects` used to hand the caller.
 *
 * Pure, and the one place the rule lives: the create path and the patch path both call it, so
 * "same as Jira" cannot mean two things.
 */
export function resolveDocsSource(
  docs: DocsSourceFields,
  jira: DocsDefaults | null,
): Result<DocsSourceFields> {
  if (docs.kind === "none") return ok(NO_DOCS_SOURCE);
  const url = docs.url ?? jira?.url ?? null;
  const email = docs.email ?? jira?.email ?? null;
  if (url === null || email === null) {
    return err({
      class: "validation",
      message: `a ${docs.kind} documentation source needs a site and an account: this project has no Jira source to take them from`,
      retryable: false,
    });
  }
  return ok({ kind: docs.kind, url, email, spaces: [...docs.spaces] });
}
