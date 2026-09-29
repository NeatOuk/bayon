import { JiraIssue, mapIssue } from "@bayon/core";
import { describe, expect, test } from "vitest";
import { JiraSource } from "./jira.js";
import { CreateProjectRequest, PatchProjectRequest } from "./projects.js";
import { CreateTicketRequest } from "./tickets.js";

// The Jira source's wire shape: the site held to Atlassian's cloud origin — the token's
// only destination — and a mirrored issue always fitting what a ticket may hold.

const SOURCE = {
  url: "https://acme.atlassian.net",
  email: "op@acme.test",
  jql: "project = ACME",
};

describe("JiraSource", () => {
  test("case, spaces and one trailing slash are normalised; the jql is trimmed", () => {
    expect(
      JiraSource.parse({
        ...SOURCE,
        url: " HTTPS://Acme.Atlassian.net/ ",
        jql: "  project = ACME \n",
      }),
    ).toEqual(SOURCE);
  });

  test.each([
    ["http", "http://acme.atlassian.net"],
    ["a path", "https://acme.atlassian.net/jira"],
    ["two trailing slashes", "https://acme.atlassian.net//"],
    ["a query", "https://acme.atlassian.net?x=1"],
    ["a port", "https://acme.atlassian.net:443"],
    ["userinfo", "https://op@acme.atlassian.net"],
    ["another host", "https://jira.example.test"],
    ["a suffix attack", "https://evil.atlassian.net.attacker.com"],
    ["a prefix attack", "https://attacker.com/acme.atlassian.net"],
    ["a subdomain", "https://a.b.atlassian.net"],
    ["empty", ""],
  ])("refuses %s", (_name, url) => {
    expect(JiraSource.safeParse({ ...SOURCE, url }).success).toBe(false);
  });

  test.each([
    ["a bad email", { email: "not-an-email" }],
    ["an empty jql", { jql: "   " }],
    ["a jql past 2000", { jql: "x".repeat(2_001) }],
    ["a token field", { token: "t" }],
  ])("refuses %s", (_name, over) => {
    expect(JiraSource.safeParse({ ...SOURCE, ...over }).success).toBe(false);
  });
});

test("POST /projects takes an optional source; PATCH takes one, null, or the switch, at least one", () => {
  const base = {
    name: "demo",
    repo_url: "https://example.com/a.git",
    runner_id: "r",
  };
  expect(CreateProjectRequest.parse(base)).not.toHaveProperty("jira");
  expect(CreateProjectRequest.parse({ ...base, jira: SOURCE }).jira).toEqual(
    SOURCE,
  );
  expect(PatchProjectRequest.parse({ jira: null })).toEqual({ jira: null });
  expect(PatchProjectRequest.parse({ staff_approval: true })).toEqual({
    staff_approval: true,
  });
  expect(PatchProjectRequest.safeParse({}).success).toBe(false);
  expect(
    PatchProjectRequest.safeParse({ jira: { ...SOURCE, url: "http://x" } })
      .success,
  ).toBe(false);
});

test("a mirrored issue always fits POST /tickets' title and body", () => {
  const issue = JiraIssue.parse({
    id: "1",
    key: "ABC-1",
    fields: {
      summary: "s".repeat(5_000),
      description: "d".repeat(300_000),
      status: { name: "To Do", statusCategory: { key: "new" } },
    },
  });
  const mapped = mapIssue(issue, SOURCE.url);
  expect(
    CreateTicketRequest.safeParse({
      title: mapped.title,
      type: mapped.type,
      body_md: mapped.body_md,
      priority: mapped.priority,
    }).success,
  ).toBe(true);
});
