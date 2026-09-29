import { JIRA_TOKEN_SECRET } from "@bayon/core";
import { describe, expect, test } from "vitest";
import {
  BLANK_JIRA,
  EMAIL_PROBLEM,
  KEY_PROBLEM,
  SITE_PROBLEM,
  checkJira,
  draftOf,
  withJql,
  withKey,
} from "@/jira/jira-form";
import {
  defaultJql,
  jiraIssueHref,
  jiraProjectHref,
  projectKeyOf,
  siteFromBody,
  siteFromInput,
} from "@/jira/jira-links";
import {
  jiraKeychainCommand,
  jiraKeychainLengthCommand,
} from "@/jira/jira-token-step";
import { keychainLabel } from "@/notify/channel-secret-step";

// The Jira mirror's text rules in the browser: the site as typed, the key and its query,
// and every href the GUI draws into Jira — only ever to https://<name>.atlassian.net.

const SITE = "https://acme.atlassian.net";

describe("the site as typed", () => {
  test.each([
    ["acme.atlassian.net", SITE],
    ["  ACME.Atlassian.NET  ", SITE],
    ["https://acme.atlassian.net", SITE],
    ["https://acme.atlassian.net/", SITE],
    ["https://acme.atlassian.net/jira/software/projects/KITE/boards/1", SITE],
    ["acme.atlassian.net/browse/KITE-1", SITE],
  ])("%j becomes the site", (typed, site) => {
    expect(siteFromInput(typed)).toBe(site);
    expect(checkJira({ ...BLANK_JIRA, site: typed }).site).toBe(site);
  });

  test.each([
    "http://acme.atlassian.net",
    "https://acme.atlassian.net:8443",
    "https://me@acme.atlassian.net",
    "https://acme.atlassian.net.attacker.com",
    "https://attacker.com/acme.atlassian.net",
    "https://atlassian.net",
    "ftp://acme.atlassian.net",
    "acme",
  ])("%j is refused with the server's rule", (typed) => {
    const checked = checkJira({ ...BLANK_JIRA, site: typed });
    expect(checked.site).toBeNull();
    expect(checked.problems.site).toBe(SITE_PROBLEM);
  });

  test("an empty site is missing, not refused", () => {
    expect(siteFromInput("  ")).toBe("");
    expect(checkJira(BLANK_JIRA).problems).toEqual({});
  });
});

describe("the key and its query", () => {
  test("the key fills the default query, in upper case", () => {
    const draft = withKey(BLANK_JIRA, "kite");
    expect(draft.key).toBe("KITE");
    expect(draft.jql).toBe(
      'project = KITE AND statusCategory = "To Do" AND issuetype != Epic ORDER BY rank',
    );
  });

  test("a bad key empties the query and says why", () => {
    const draft = withKey(BLANK_JIRA, "1KITE");
    expect(draft.jql).toBe("");
    expect(checkJira(draft).problems.key).toBe(KEY_PROBLEM);
  });

  test("once the query is edited the key no longer fills it", () => {
    const edited = withJql(withKey(BLANK_JIRA, "KITE"), "project = KITE");
    expect(withKey(edited, "ABC").jql).toBe("project = KITE");
  });

  test("a stored source reads back its key, and counts as edited unless it is the default", () => {
    const stock = {
      url: SITE,
      email: "a@b.co",
      jql: defaultJql("KITE"),
    };
    expect(draftOf(stock)).toMatchObject({ key: "KITE", jqlEdited: false });
    expect(draftOf({ ...stock, jql: 'project = "KITE" AND x' })).toMatchObject({
      key: "KITE",
      jqlEdited: true,
    });
    expect(
      draftOf({ ...stock, jql: "assignee = currentUser()" }),
    ).toMatchObject({ key: "", jqlEdited: true });
    expect(projectKeyOf("project=abc ORDER BY rank")).toBe("ABC");
  });

  test("a complete draft sends the source; a bad email is refused", () => {
    const draft = {
      ...withKey(BLANK_JIRA, "KITE"),
      site: "acme.atlassian.net",
      email: " me@acme.co ",
    };
    expect(checkJira(draft).source).toEqual({
      url: SITE,
      email: "me@acme.co",
      jql: defaultJql("KITE"),
    });
    const bad = checkJira({ ...draft, email: "me at acme" });
    expect(bad.source).toBeNull();
    expect(bad.problems.email).toBe(EMAIL_PROBLEM);
  });
});

describe("links into Jira", () => {
  test("an issue link needs an Atlassian site and an issue key", () => {
    expect(jiraIssueHref(SITE, "KITE-123")).toBe(`${SITE}/browse/KITE-123`);
    expect(jiraIssueHref("https://evil.example.com", "KITE-1")).toBeNull();
    expect(jiraIssueHref(`${SITE}.evil.com`, "KITE-1")).toBeNull();
    expect(jiraIssueHref(null, "KITE-1")).toBeNull();
    for (const hostile of [
      "javascript:alert(1)",
      "KITE-1/../../secure/admin",
      "KITE-1?x=1",
      "//evil.example.com",
      "kite-1",
      "KITE-0",
      "",
    ])
      expect(jiraIssueHref(SITE, hostile)).toBeNull();
  });

  test("the project link is its key's browse page, else the site", () => {
    expect(jiraProjectHref(SITE, defaultJql("KITE"))).toBe(
      `${SITE}/browse/KITE`,
    );
    expect(jiraProjectHref(SITE, "assignee = currentUser()")).toBe(SITE);
    expect(jiraProjectHref("https://evil.example.com", "project = KITE")).toBe(
      null,
    );
  });

  test("a body's site is its first link to the ticket's own key, only when Atlassian's", () => {
    const header = `Jira: [KITE-7](${SITE}/browse/KITE-7)`;
    expect(siteFromBody(`${header}\n\nmore`, "KITE-7")).toBe(SITE);
    expect(
      siteFromBody(
        `see [KITE-1](https://other.atlassian.net/browse/KITE-1)\n${header}`,
        "KITE-7",
      ),
    ).toBe(SITE);
    expect(
      siteFromBody(
        "Jira: [KITE-7](https://evil.example.com/browse/KITE-7)",
        "KITE-7",
      ),
    ).toBeNull();
    expect(
      siteFromBody(
        "Jira: [KITE-7](https://acme.atlassian.net.evil.com/browse/KITE-7)",
        "KITE-7",
      ),
    ).toBeNull();
    expect(siteFromBody("no links", "KITE-7")).toBeNull();
  });
});

test("the Keychain commands name the install's service (from the API) and the secret, and read the clipboard", () => {
  for (const service of ["foreman", "foreman-0123456789ab"]) {
    expect(jiraKeychainCommand(service)).toBe(
      `security add-generic-password -U -s ${service} -a ${JIRA_TOKEN_SECRET} -w "$(pbpaste)"`,
    );
    expect(jiraKeychainLengthCommand(service)).toBe(
      `security find-generic-password -s ${service} -a ${JIRA_TOKEN_SECRET} -w | wc -c`,
    );
  }
});

test("the store label says which install's service: this install, or a home that is not ~/.foreman", () => {
  expect(keychainLabel({ service: "foreman", owner: true })).toBe(
    "Keychain · foreman (this install)",
  );
  expect(keychainLabel({ service: "foreman-0123456789ab", owner: false })).toBe(
    "Keychain · foreman-0123456789ab (this home's own, not ~/.foreman's)",
  );
});
