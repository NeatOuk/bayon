// A project's Jira site and the secret that reaches it.
//
// The site pattern is the mirror's security control. The API sends the operator's Jira token to
// the site a project names, and that name arrives over REST, which a page on the LAN holding the
// operator's bearer can reach. Holding every site to Atlassian's own cloud origin
// (`https://<name>.atlassian.net`, no path, port or userinfo) means the token can only ever go to
// Atlassian's servers, never to a host such a page controls. The proto schema checks it on the way
// in; the client checks it again before every request.

/** Lowercase, origin only: no path, port, query, userinfo or trailing slash. */
export const JIRA_SITE = /^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net$/;

/** The longest site accepted: a DNS label is at most 63 characters. */
export const JIRA_SITE_MAX = 100;

/** The host secret store's name for the operator's Jira API token (§14). */
export const JIRA_TOKEN_SECRET = "JIRA_API_TOKEN";

/** Case and one trailing slash are the operator's typing, not a different site. */
export const normalizeJiraSite = (raw: string): string =>
  raw.trim().toLowerCase().replace(/\/$/, "");

export const isJiraSite = (site: string): boolean =>
  site.length <= JIRA_SITE_MAX && JIRA_SITE.test(site);

/** `https://acme.atlassian.net` → `acme.atlassian.net`: a fingerprint's and an actor's host. */
export const jiraHost = (site: string): string => site.slice("https://".length);

/** A project's Jira source as stored and served. */
export interface JiraSourceFields {
  readonly url: string;
  readonly email: string;
  readonly jql: string;
}
