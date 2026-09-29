import {
  DocsSiteUrl,
  DocsSource,
  DocsSpaceKey,
  type DocsKind,
  type DocsSourceView,
  type JiraSourceView,
} from "@bayon/proto";
import { siteFromInput } from "@/jira/jira-links";

// The documentation source form's state, shared by the project's Settings view and the
// New project form. Every field is checked with the **proto schema the server uses** (which is
// core's rule underneath), so what the form accepts is what the server accepts and a refusal never
// arrives as a surprise 400.
//
// "Same as Jira" is not a GUI trick: it sends the source with no site and no account, and the
// server fills both from the project's Jira source in the same transaction. So a mirror moved and a
// documentation source left alone stay together.

/** What a project's Jira source offers the documentation source: its site and its account. */
export interface JiraDefaults {
  readonly url: string;
  readonly email: string;
}

export const jiraDefaultsOf = (
  jira: JiraSourceView | null,
): JiraDefaults | null =>
  jira === null ? null : { url: jira.url, email: jira.email };

export interface DocsDraft {
  readonly kind: DocsKind;
  /** Take the site and the account from the project's Jira source. */
  readonly sameAsJira: boolean;
  /** As typed; `siteFromInput` makes it the URL sent. */
  readonly site: string;
  readonly email: string;
  /** One space key per line; blank is any space the account can read. */
  readonly spaces: string;
}

export const BLANK_DOCS: DocsDraft = {
  kind: "none",
  sameAsJira: true,
  site: "",
  email: "",
  spaces: "",
};

/** Lines, trimmed, blanks dropped: how the space list is read. */
export const linesOf = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/**
 * A stored source, to edit. It counts as "same as Jira" when its site and account are the project's
 * Jira ones — which is what the server wrote when the operator left them blank.
 */
export function docsDraftOf(
  docs: DocsSourceView,
  jira: JiraDefaults | null,
): DocsDraft {
  const same =
    jira !== null &&
    (docs.url === null || docs.url === jira.url) &&
    (docs.email === null || docs.email === jira.email);
  return {
    kind: docs.kind,
    sameAsJira: same,
    site: docs.url ?? "",
    email: docs.email ?? "",
    spaces: docs.spaces.join("\n"),
  };
}

export interface DocsProblems {
  readonly site?: string;
  readonly email?: string;
  readonly spaces?: string;
}

export interface DocsCheck {
  /** What to send, or null while a field is missing or refused. */
  readonly source: DocsSource | null;
  readonly problems: DocsProblems;
}

export const SITE_PROBLEM =
  "An Atlassian Cloud site: <name>.atlassian.net, over https";
export const EMAIL_PROBLEM = "An email address: the account the token is for";
export const SPACE_PROBLEM =
  "A space key: letters, digits and underscores, like DOCS or Docs";
export const NO_JIRA_PROBLEM =
  "This project has no Jira source, so there is nothing to copy: give the site and the account.";

/** The first of `values` the schema refuses; none passes as undefined. */
function firstBadSpace(values: readonly string[]): string | undefined {
  const bad = values.find((value) => !DocsSpaceKey.safeParse(value).success);
  return bad === undefined ? undefined : `${bad}: ${SPACE_PROBLEM}`;
}

/** The draft checked field by field, and the source it sends when every field passes. */
export function checkDocs(
  draft: DocsDraft,
  jira: JiraDefaults | null,
): DocsCheck {
  const spaces = linesOf(draft.spaces);
  const badSpace = firstBadSpace(spaces);
  if (draft.kind === "none") {
    return {
      source: { kind: "none", url: null, email: null, spaces: [] },
      problems: {},
    };
  }
  // Same as Jira: the site and the account are left out, and the server fills them in.
  if (draft.sameAsJira) {
    const problems: DocsProblems = {
      ...(jira === null ? { site: NO_JIRA_PROBLEM } : {}),
      ...(badSpace === undefined ? {} : { spaces: badSpace }),
    };
    return Object.keys(problems).length > 0
      ? { source: null, problems }
      : {
          source: { kind: draft.kind, url: null, email: null, spaces },
          problems: {},
        };
  }
  const site = DocsSiteUrl.safeParse(siteFromInput(draft.site));
  const email = DocsSource.shape.email.safeParse(draft.email.trim());
  const problems: DocsProblems = {
    ...(draft.site.trim() !== "" && !site.success
      ? { site: SITE_PROBLEM }
      : {}),
    ...(draft.email.trim() !== "" && !email.success
      ? { email: EMAIL_PROBLEM }
      : {}),
    ...(badSpace === undefined ? {} : { spaces: badSpace }),
  };
  if (Object.keys(problems).length > 0) return { source: null, problems };
  return site.success && email.success && email.data !== null
    ? {
        source: { kind: draft.kind, url: site.data, email: email.data, spaces },
        problems: {},
      }
    : { source: null, problems: {} };
}
