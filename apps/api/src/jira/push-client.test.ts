// Jira's writes for Jira following the ticket against an in-memory fake, never a real
// Jira: a transition is found by its target status's name (case-insensitively), an unknown name is
// skipped with the reason and never guessed, an issue already there is a no-op, a comment is posted
// as ADF, and every refusal is a typed error that names neither the token nor its header.
import { beforeEach, expect, test } from "vitest";
import { postJson, type Call } from "../atlassian/client.js";
import {
  callFor,
  commentIssue,
  listStatuses,
  transitionIssue,
} from "./push-client.js";
import {
  PUSH_EMAIL,
  PUSH_SITE,
  PUSH_TOKEN,
  fakeJira,
  type FakeJira,
} from "./push-fixtures.js";

const BASIC = `Basic ${Buffer.from(`${PUSH_EMAIL}:${PUSH_TOKEN}`).toString("base64")}`;

let jira: FakeJira;
let call: Call;
beforeEach(() => {
  jira = fakeJira();
  jira.issues.set("ABC-1", "To Do");
  jira.transitions.set("ABC-1", [
    { id: "11", to: "In Progress" },
    { id: "21", to: "Done" },
  ]);
  call = callFor(
    PUSH_SITE,
    { email: PUSH_EMAIL, token: PUSH_TOKEN },
    { fetch: jira.fetch, timeoutMs: 5_000 },
  );
});

const noSecret = (text: string) => {
  expect(text).not.toContain(PUSH_TOKEN);
  expect(text).not.toContain(BASIC.slice("Basic ".length));
};

test("a transition is found by its target's name, case-insensitively, and posted by id", async () => {
  expect(await transitionIssue(call, "ABC-1", "in progress")).toEqual({
    ok: true,
    value: { state: "sent" },
  });
  expect(jira.issues.get("ABC-1")).toBe("In Progress");
  expect(jira.seen.map((r) => [r.method, r.url, r.body])).toEqual([
    ["GET", `${PUSH_SITE}/rest/api/3/issue/ABC-1?fields=status`, null],
    ["GET", `${PUSH_SITE}/rest/api/3/issue/ABC-1/transitions`, null],
    [
      "POST",
      `${PUSH_SITE}/rest/api/3/issue/ABC-1/transitions`,
      { transition: { id: "11" } },
    ],
  ]);
  expect(jira.seen.every((r) => r.authorization === BASIC)).toBe(true);
});

test("an unknown status name is skipped with the reason, and nothing is posted", async () => {
  expect(await transitionIssue(call, "ABC-1", "In Review")).toEqual({
    ok: true,
    value: {
      state: "skipped",
      reason:
        "ABC-1 has no transition from To Do to In Review (it can move to: In Progress, Done)",
    },
  });
  expect(jira.seen.filter((r) => r.method === "POST")).toEqual([]);
  expect(jira.issues.get("ABC-1")).toBe("To Do");
  jira.transitions.set("ABC-1", []);
  expect(await transitionIssue(call, "ABC-1", "In Review")).toMatchObject({
    value: { reason: "ABC-1 has no transition from To Do to In Review" },
  });
});

test("an issue already in the status is a no-op: no transitions read, nothing posted", async () => {
  jira.issues.set("ABC-1", "DONE");
  expect(await transitionIssue(call, "ABC-1", "Done")).toEqual({
    ok: true,
    value: { state: "skipped", reason: "ABC-1 is already DONE" },
  });
  expect(jira.seen).toHaveLength(1);
});

test("a comment is posted as ADF: one paragraph, the lead, the link", async () => {
  const url = "https://forge.example/o/r/pull/7";
  expect(
    await commentIssue(call, "ABC-1", { lead: "Pull request:", urls: [url] }),
  ).toEqual({ ok: true, value: { state: "sent" } });
  expect(jira.comments.get("ABC-1")).toEqual([
    {
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Pull request: " },
              {
                type: "text",
                text: url,
                marks: [{ type: "link", attrs: { href: url } }],
              },
            ],
          },
        ],
      },
    },
  ]);
});

test("a 401 or 403 is a non-retryable refusal naming the permissions, never the token", async () => {
  for (const status of [401, 403]) {
    jira.next.push({ status, body: `{"errorMessages":["${PUSH_TOKEN}"]}` });
    const r = await transitionIssue(call, "ABC-1", "Done");
    expect(r).toMatchObject({
      ok: false,
      error: { class: "validation", retryable: false },
    });
    if (r.ok) throw new Error("expected a refusal");
    expect(r.error.message).toContain("Transition Issues and Add Comments");
    noSecret(r.error.message);
  }
});

test("a 5xx or 429 is retryable; a 404 is not", async () => {
  jira.next.push({ status: 503 });
  expect(
    await commentIssue(call, "ABC-1", {
      lead: "x",
      urls: ["https://a.example/1"],
    }),
  ).toMatchObject({ ok: false, error: { retryable: true } });
  jiraReset();
  expect(await transitionIssue(call, "NOPE-1", "Done")).toMatchObject({
    ok: false,
    error: { retryable: false },
  });
});

function jiraReset() {
  jira.next.length = 0;
}

test("a thrown fetch naming the token is scrubbed; a redirect is refused", async () => {
  jira.next.push({ throws: new Error(`boom ${PUSH_TOKEN} ${BASIC}`) });
  const thrown = await transitionIssue(call, "ABC-1", "Done");
  if (thrown.ok) throw new Error("expected an error");
  noSecret(thrown.error.message);
  jira.next.push({
    throws: new TypeError("fetch failed", {
      cause: new Error("unexpected redirect"),
    }),
  });
  expect(await transitionIssue(call, "ABC-1", "Done")).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("redirect") },
  });
});

test("an issue key that is not one, or a site that is not Atlassian's, never reaches fetch", async () => {
  expect(await transitionIssue(call, "../../admin", "Done")).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  const elsewhere = { ...call, site: "https://evil.example" };
  expect(
    await commentIssue(elsewhere, "ABC-1", {
      lead: "x",
      urls: ["https://a.example/1"],
    }),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(
    await postJson(call, "https://evil.example/rest/api/3/x", {}),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(
    await postJson(elsewhere, "https://evil.example/rest/api/3/x", {}),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(jira.seen).toEqual([]);
});

test("postJson: a 201's JSON, a 204's null, a body that is not JSON refused", async () => {
  jira.next.push({ status: 201, body: '{"id":"9"}' });
  expect(await postJson(call, `${PUSH_SITE}/rest/api/3/x`, { a: 1 })).toEqual({
    ok: true,
    value: { id: "9" },
  });
  expect(jira.seen[0]?.body).toEqual({ a: 1 });
  jira.next.push({ status: 204 });
  expect(await postJson(call, `${PUSH_SITE}/rest/api/3/x`, {})).toEqual({
    ok: true,
    value: null,
  });
  jira.next.push({ status: 200, body: "<html>" });
  expect(await postJson(call, `${PUSH_SITE}/rest/api/3/x`, {})).toMatchObject({
    ok: false,
    error: { class: "runner_error" },
  });
});

test("an answer this cannot read is a typed error", async () => {
  jira.next.push({ status: 200, body: '{"fields":{}}' });
  expect(await transitionIssue(call, "ABC-1", "Done")).toMatchObject({
    ok: false,
    error: {
      class: "runner_error",
      message: expect.stringContaining("the issue"),
    },
  });
});

test("listStatuses: the login first, then the site's names, deduped and sorted", async () => {
  jira.statuses.push(
    "To Do",
    "Done",
    "In Progress",
    "done",
    " ",
    "x".repeat(101),
  );
  expect(await listStatuses(call)).toEqual({
    ok: true,
    value: ["Done", "In Progress", "To Do"],
  });
  expect(jira.seen.map((r) => new URL(r.url).pathname)).toEqual([
    "/rest/api/3/myself",
    "/rest/api/3/status",
  ]);
  jira.next.push({ status: 401 });
  expect(await listStatuses(call)).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect(
    await listStatuses({ ...call, site: "https://evil.example" }),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("a retried comment already on the issue is not posted again; a first attempt never looks", async () => {
  const p = {
    lead: "Pull request:",
    urls: ["https://forge.example/o/r/pull/7"],
  };
  expect(await commentIssue(call, "ABC-1", p)).toEqual({
    ok: true,
    value: { state: "sent" },
  });
  expect(jira.seen.map((r) => r.method)).toEqual(["POST"]);
  jira.seen.length = 0;

  // The retry finds the one that landed: settled as sent, nothing posted.
  expect(await commentIssue(call, "ABC-1", p, true)).toEqual({
    ok: true,
    value: { state: "sent" },
  });
  expect(jira.seen.map((r) => [r.method, new URL(r.url).search])).toEqual([
    ["GET", "?orderBy=-created&maxResults=50"],
  ]);
  expect(jira.comments.get("ABC-1")).toHaveLength(1);
  jira.seen.length = 0;

  // A retry of a different comment looks, finds nothing like it, and posts.
  const other = { lead: "Merged by octo:", urls: p.urls };
  expect(await commentIssue(call, "ABC-1", other, true)).toEqual({
    ok: true,
    value: { state: "sent" },
  });
  expect(jira.seen.map((r) => r.method)).toEqual(["GET", "POST"]);
  expect(jira.comments.get("ABC-1")).toHaveLength(2);

  // The look itself failing is the attempt failing: nothing posted.
  jira.seen.length = 0;
  jira.next.push({ status: 503 });
  expect(await commentIssue(call, "ABC-1", other, true)).toMatchObject({
    ok: false,
    error: { retryable: true },
  });
  expect(jira.seen.map((r) => r.method)).toEqual(["GET"]);
});
