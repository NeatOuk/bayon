import { JiraSiteUrl, JiraSource, type JiraSourceView } from "@bayon/proto";
import {
  PROJECT_KEY,
  defaultJql,
  projectKeyOf,
  siteFromInput,
} from "@/jira/jira-links";

// The Jira source form's state (New project and the Tickets view's strip share it). Site, email and
// query are checked with proto's own schemas, so what the form accepts is what the server accepts.

export interface JiraDraft {
  /** As typed; `siteFromInput` makes it the URL sent. */
  readonly site: string;
  readonly email: string;
  /** The Jira project key; it fills `jql` until the query is edited. */
  readonly key: string;
  readonly jql: string;
  /** The operator wrote the query: the key no longer fills it. */
  readonly jqlEdited: boolean;
}

export const BLANK_JIRA: JiraDraft = {
  site: "",
  email: "",
  key: "",
  jql: "",
  jqlEdited: false,
};

/** A stored source, to edit: its key read back from its query, which counts as edited unless it is the key's default. */
export function draftOf(source: JiraSourceView): JiraDraft {
  const key = projectKeyOf(source.jql) ?? "";
  return {
    site: source.url,
    email: source.email,
    key,
    jql: source.jql,
    jqlEdited: key === "" || source.jql !== defaultJql(key),
  };
}

/** A new key, typed in any case; it refills the query unless the operator wrote one. */
export function withKey(draft: JiraDraft, typed: string): JiraDraft {
  const key = typed.trim().toUpperCase();
  if (draft.jqlEdited) return { ...draft, key };
  return { ...draft, key, jql: PROJECT_KEY.test(key) ? defaultJql(key) : "" };
}

/** The operator's own query: from now on the key leaves it alone. */
export const withJql = (draft: JiraDraft, jql: string): JiraDraft => ({
  ...draft,
  jql,
  jqlEdited: true,
});

export interface JiraProblems {
  readonly site?: string;
  readonly email?: string;
  readonly key?: string;
  readonly jql?: string;
}

export interface JiraCheck {
  /** What to send, or null while any field is missing or refused. */
  readonly source: JiraSource | null;
  /** The site as it will be sent, once it is a valid one. */
  readonly site: string | null;
  /** A problem per field typed but refused; an empty field is missing, not refused. */
  readonly problems: JiraProblems;
}

export const SITE_PROBLEM =
  "A Jira Cloud site: <name>.atlassian.net, over https";
export const EMAIL_PROBLEM = "An email address: the account the token is for";
export const KEY_PROBLEM =
  "Uppercase letters and digits, a letter first, like KITE";
export const JQL_PROBLEM = "A query of 1 to 2000 characters";
export const JQL_MISSING =
  "Enter the project key, or write the query under Advanced";

/** The draft checked field by field, and the source it sends when every field passes. */
export function checkJira(draft: JiraDraft): JiraCheck {
  const site = JiraSiteUrl.safeParse(siteFromInput(draft.site));
  const email = JiraSource.shape.email.safeParse(draft.email.trim());
  const jql = JiraSource.shape.jql.safeParse(draft.jql);
  const keyOk = PROJECT_KEY.test(draft.key);
  const problems: JiraProblems = {
    ...(draft.site.trim() !== "" && !site.success
      ? { site: SITE_PROBLEM }
      : {}),
    ...(draft.email.trim() !== "" && !email.success
      ? { email: EMAIL_PROBLEM }
      : {}),
    ...(draft.key !== "" && !keyOk ? { key: KEY_PROBLEM } : {}),
    ...(draft.jqlEdited && !jql.success ? { jql: JQL_PROBLEM } : {}),
  };
  const source =
    site.success && email.success && jql.success
      ? { url: site.data, email: email.data, jql: jql.data }
      : null;
  return { source, site: site.success ? site.data : null, problems };
}
