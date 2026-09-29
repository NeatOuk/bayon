import { describe, expect, test } from "vitest";
import {
  DEFAULT_TICKET_PRIORITY,
  JIRA_BODY_MAX,
  JIRA_TITLE_MAX,
  JIRA_TRUNCATED,
  JiraIssue,
  jiraActorId,
  jiraFingerprint,
  mapIssue,
} from "./issue-map.js";
import {
  isJiraSite,
  jiraHost,
  normalizeJiraSite,
  JIRA_TOKEN_SECRET,
} from "./site.js";

// One Jira issue into its mirror ticket: each column from its field, table-driven, and
// the caps that keep a title and a body inside what a ticket may hold.

const SITE = "https://acme.atlassian.net";

type Fields = Record<string, unknown>;
const issue = (fields: Fields = {}, o: Fields = {}): JiraIssue =>
  JiraIssue.parse({
    id: "10042",
    key: "ABC-12",
    ...o,
    fields: {
      summary: "Fix the login",
      status: { name: "To Do", statusCategory: { key: "new" } },
      ...fields,
    },
  });

const description = (text: string) => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("mapIssue", () => {
  test("every column of a plain issue", () => {
    expect(
      mapIssue(
        issue({
          description: description("Steps to reproduce."),
          issuetype: { name: "Bug" },
          priority: { name: "High" },
        }),
        SITE,
      ),
    ).toEqual({
      issue_id: "10042",
      fingerprint: "jira:acme.atlassian.net:10042",
      origin_ref: "ABC-12",
      title: "Fix the login",
      body_md:
        "Jira: [ABC-12](https://acme.atlassian.net/browse/ABC-12)\n\nSteps to reproduce.",
      type: "bug",
      priority: 2,
      status_category: "new",
      status_name: "To Do",
    });
  });

  test.each<[string, Fields, string]>([
    ["Bug", { issuetype: { name: "Bug" } }, "bug"],
    ["bug, any case", { issuetype: { name: " BUG " } }, "bug"],
    ["Spike", { issuetype: { name: "Spike" } }, "spike"],
    ["Story", { issuetype: { name: "Story" } }, "feature"],
    ["Task", { issuetype: { name: "Task" } }, "feature"],
    ["Epic", { issuetype: { name: "Epic" } }, "feature"],
    ["no type", { issuetype: null }, "feature"],
  ])("type: %s", (_name, fields, type) => {
    expect(mapIssue(issue(fields), SITE).type).toBe(type);
  });

  test.each<[string, Fields, number]>([
    ["Highest", { priority: { name: "Highest" } }, 1],
    ["High", { priority: { name: "High" } }, 2],
    ["Medium", { priority: { name: "Medium" } }, 3],
    ["Low", { priority: { name: "Low" } }, 4],
    ["Lowest", { priority: { name: "Lowest" } }, 5],
    ["lowest, any case", { priority: { name: "LOWEST" } }, 5],
    ["a custom name", { priority: { name: "P0 - Blocker" } }, 3],
    ["null", { priority: null }, 3],
    ["absent", {}, 3],
  ])("priority: %s", (_name, fields, priority) => {
    expect(mapIssue(issue(fields), SITE).priority).toBe(priority);
    expect(DEFAULT_TICKET_PRIORITY).toBe(3);
  });

  test.each<[string, Fields, string]>([
    ["trimmed", { summary: "  Tidy up  " }, "Tidy up"],
    ["empty is the key", { summary: "   " }, "ABC-12"],
    ["null is the key", { summary: null }, "ABC-12"],
    ["at the limit, kept", { summary: "t".repeat(200) }, "t".repeat(200)],
    [
      "past the limit, cut with an ellipsis",
      { summary: "t".repeat(250) },
      `${"t".repeat(199)}…`,
    ],
    [
      "never splitting a surrogate pair",
      { summary: `${"t".repeat(198)}😀tail` },
      `${"t".repeat(198)}…`,
    ],
  ])("title: %s", (_name, fields, title) => {
    const mapped = mapIssue(issue(fields), SITE).title;
    expect(mapped).toBe(title);
    expect(mapped.length).toBeLessThanOrEqual(JIRA_TITLE_MAX);
  });

  test.each<[string, Fields, string]>([
    [
      "no description: the header alone",
      {},
      "Jira: [ABC-12](https://acme.atlassian.net/browse/ABC-12)",
    ],
    [
      "the parent epic with its summary",
      {
        parent: { key: "ABC-1", fields: { summary: " Checkout " } },
        description: description("Body."),
      },
      "Jira: [ABC-12](https://acme.atlassian.net/browse/ABC-12) · Parent: ABC-1 Checkout\n\nBody.",
    ],
    [
      "a parent without a summary",
      { parent: { key: "ABC-1", fields: { summary: null } } },
      "Jira: [ABC-12](https://acme.atlassian.net/browse/ABC-12) · Parent: ABC-1",
    ],
    [
      "a parent without fields",
      { parent: { key: "ABC-1" } },
      "Jira: [ABC-12](https://acme.atlassian.net/browse/ABC-12) · Parent: ABC-1",
    ],
    [
      "a null parent",
      { parent: null },
      "Jira: [ABC-12](https://acme.atlassian.net/browse/ABC-12)",
    ],
  ])("body: %s", (_name, fields, body) => {
    expect(mapIssue(issue(fields), SITE).body_md).toBe(body);
  });

  test("a long description is cut to the cap and says so", () => {
    const body = mapIssue(
      issue({ description: description("x".repeat(50_000)) }),
      SITE,
    ).body_md;
    expect(body).toHaveLength(JIRA_BODY_MAX);
    expect(body.endsWith(JIRA_TRUNCATED)).toBe(true);
    expect(JIRA_BODY_MAX).toBeLessThan(200_000);
  });

  test("the cut never splits a surrogate pair", () => {
    const head = "Jira: [ABC-12](https://acme.atlassian.net/browse/ABC-12)\n\n";
    const keep = JIRA_BODY_MAX - JIRA_TRUNCATED.length - head.length;
    const body = mapIssue(
      issue({
        description: description(
          `${"x".repeat(keep - 1)}😀${"more".repeat(50)}`,
        ),
      }),
      SITE,
    ).body_md;
    expect(body).toBe(`${head}${"x".repeat(keep - 1)}${JIRA_TRUNCATED}`);
  });

  test("the status category and name pass through", () => {
    const mapped = mapIssue(
      issue({
        status: {
          name: "In Progress",
          statusCategory: { key: "indeterminate" },
        },
      }),
      SITE,
    );
    expect([mapped.status_category, mapped.status_name]).toEqual([
      "indeterminate",
      "In Progress",
    ]);
  });

  test("the fingerprint is the numeric id, which survives a move to another project", () => {
    const moved = mapIssue(issue({}, { key: "XYZ-3" }), SITE);
    expect(moved.fingerprint).toBe(
      jiraFingerprint("acme.atlassian.net", "10042"),
    );
    expect(moved.origin_ref).toBe("XYZ-3");
    expect(jiraActorId("acme.atlassian.net")).toBe("jira:acme.atlassian.net");
  });
});

describe("JiraIssue", () => {
  test.each<[string, Fields]>([
    ["a non-numeric id", { id: "10042x" }],
    ["a key that is no key", { key: "ABC-12](https://evil.test)" }],
    ["a key without a number", { key: "ABC-" }],
  ])("refuses %s", (_name, o) => {
    expect(
      JiraIssue.safeParse({
        id: "1",
        key: "A-1",
        ...o,
        fields: { status: { name: "x", statusCategory: { key: "new" } } },
      }).success,
    ).toBe(false);
  });

  test("needs a status: the mirror decides by it", () => {
    expect(
      JiraIssue.safeParse({ id: "1", key: "A-1", fields: { summary: "s" } })
        .success,
    ).toBe(false);
  });
});

describe("the site", () => {
  test.each<[string, string, boolean]>([
    ["a cloud site", "https://acme.atlassian.net", true],
    ["digits and dashes", "https://acme-2.atlassian.net", true],
    ["http", "http://acme.atlassian.net", false],
    ["a path", "https://acme.atlassian.net/jira", false],
    ["a trailing slash", "https://acme.atlassian.net/", false],
    ["uppercase", "https://Acme.atlassian.net", false],
    ["another host", "https://evil.test", false],
    ["a suffix attack", "https://evil.atlassian.net.attacker.com", false],
    ["userinfo", "https://me@acme.atlassian.net", false],
    ["a port", "https://acme.atlassian.net:8443", false],
    ["a subdomain", "https://a.b.atlassian.net", false],
    ["a leading dash", "https://-acme.atlassian.net", false],
    ["too long", `https://${"a".repeat(90)}.atlassian.net`, false],
  ])("%s", (_name, site, accepted) => {
    expect(isJiraSite(site)).toBe(accepted);
  });

  test("normalising: case and one trailing slash, trimmed", () => {
    expect(normalizeJiraSite("  HTTPS://Acme.Atlassian.NET/ ")).toBe(SITE);
    expect(normalizeJiraSite("https://acme.atlassian.net//")).toBe(
      "https://acme.atlassian.net/",
    );
    expect(jiraHost(SITE)).toBe("acme.atlassian.net");
    expect(JIRA_TOKEN_SECRET).toBe("JIRA_API_TOKEN");
  });
});
