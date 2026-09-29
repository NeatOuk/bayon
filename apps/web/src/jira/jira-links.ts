import { isJiraSite, jiraHost, normalizeJiraSite } from "@bayon/core";

// The Jira mirror's text rules in the browser: the site as the operator types it, a project key and
// the query it fills, and every link the GUI draws into Jira. A link is only ever to a site that
// passes core's `isJiraSite` (https://<name>.atlassian.net): the server holds sources to that rule,
// and an issue key or a ticket body is data an issue's author wrote, never trusted as a URL.

/** A Jira project key, as the form takes it: uppercase letters and digits, a letter first. */
export const PROJECT_KEY = /^[A-Z][A-Z0-9]*$/;

/** An issue key as Jira mints them (`KITE-123`): the only `origin_ref` that becomes a link. */
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;

/** A scheme the operator typed (`https:`, `http:`, `ftp:`); a bare host has none. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;

/**
 * The site as typed → `https://<name>.atlassian.net`: trimmed and lowercased, `https://` added when
 * no scheme was typed, and a pasted https link cut to its origin (a board or an issue link names the
 * same site). Anything else — `http://`, userinfo, a port, another host — comes back as typed, less
 * one trailing slash, for `JiraSiteUrl` to refuse.
 */
export function siteFromInput(raw: string): string {
  const typed = raw.trim().toLowerCase();
  if (typed === "") return "";
  const withScheme = HAS_SCHEME.test(typed) ? typed : `https://${typed}`;
  if (URL.canParse(withScheme)) {
    const url = new URL(withScheme);
    if (url.protocol === "https:" && url.username === "" && url.password === "")
      return url.origin;
  }
  return normalizeJiraSite(withScheme);
}

/** The query a project key fills in: its To Do issues, epics left out, in Jira's rank order. */
export const defaultJql = (key: string): string =>
  `project = ${key} AND statusCategory = "To Do" AND issuetype != Epic ORDER BY rank`;

/** `project = KITE …` → `KITE`: the key a stored query names, if it names one plainly. */
export function projectKeyOf(jql: string): string | null {
  const key = /\bproject\s*=\s*"?([A-Za-z][A-Za-z0-9]*)"?/i.exec(jql)?.[1];
  const upper = key?.toUpperCase();
  return upper !== undefined && PROJECT_KEY.test(upper) ? upper : null;
}

/** `https://acme.atlassian.net` → `acme.atlassian.net`; a site that is not Atlassian's → null. */
export const siteHostOf = (site: string): string | null =>
  isJiraSite(site) ? jiraHost(site) : null;

/** `<site>/browse/<KEY>`, or null unless the site is Atlassian's and the key is an issue key. */
export function jiraIssueHref(
  site: string | null | undefined,
  key: string | null | undefined,
): string | null {
  if (site === null || site === undefined || !isJiraSite(site)) return null;
  if (key === null || key === undefined || !ISSUE_KEY.test(key)) return null;
  return `${site}/browse/${key}`;
}

/** The Jira project a source's query names (`<site>/browse/<KEY>` opens it), else the site itself. */
export function jiraProjectHref(site: string, jql: string): string | null {
  if (!isJiraSite(site)) return null;
  const key = projectKeyOf(jql);
  return key === null ? site : `${site}/browse/${key}`;
}

/** A markdown link target to `…/browse/<KEY>`: the site before it, the key after. */
const BODY_LINK = /\]\((https:\/\/[^\s/)]+)\/browse\/([^\s/)]+)\)/g;

/**
 * The site of the first `(https://<site>/browse/<KEY>)` link in a mirrored ticket's body whose KEY
 * is the ticket's own — the header the mirror writes first — and only when that site is Atlassian's.
 */
export function siteFromBody(body: string, key: string): string | null {
  for (const [, site = "", linked] of body.matchAll(BODY_LINK)) {
    if (linked !== key) continue;
    return isJiraSite(site) ? site : null;
  }
  return null;
}
