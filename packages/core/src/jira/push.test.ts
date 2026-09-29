import { describe, expect, test } from "vitest";
import {
  JiraStatusMap,
  NewJiraPush,
  adfText,
  commentAdf,
  isEmptyStatusMap,
  isJiraIssueKey,
  isPushableUrl,
  mergedInfoOf,
  pushesOf,
  sameCommentText,
  statusMapOf,
  type JiraPushEvent,
  type JiraPushLink,
  type JiraPushTicket,
} from "./push.js";

// The pure half of Jira following the ticket: which rows file which pushes.

const SITE = "https://example.atlassian.net";
const MAP = { started: "In Progress", in_review: "In Review", done: "Done" };

const ticket = (o: Partial<JiraPushTicket> = {}): JiraPushTicket => ({
  id: "T1",
  status: "building",
  workspace_id: "P",
  origin_ref: "ABC-1",
  origin_fingerprint: "jira:example.atlassian.net:10001",
  jira_url: SITE,
  status_map: MAP,
  comment_prs: true,
  ...o,
});

const event = (o: Partial<JiraPushEvent> = {}): JiraPushEvent => ({
  id: 1,
  ticket_id: "T1",
  actor_id: "operator",
  from_status: "prioritized",
  to_status: "staffed",
  payload_json: null,
  ...o,
});

const link = (o: Partial<JiraPushLink> = {}): JiraPushLink => ({
  seq: 1,
  ticket_id: "T1",
  url: "https://forge.example/o/r/pull/7",
  ...o,
});

const run = (
  events: JiraPushEvent[],
  links: JiraPushLink[] = [],
  t: JiraPushTicket = ticket(),
) => pushesOf({ events, links, tickets: new Map([[t.id, t]]) });

describe("pushesOf", () => {
  test("a move to staffed files the started transition, with its dedupe key", () => {
    expect(run([event()])).toEqual([
      {
        kind: "transition",
        ticket_id: "T1",
        workspace_id: "P",
        issue_key: "ABC-1",
        moment: "started",
        dedupe_key: "t:T1:started",
        payload: { status: "In Progress" },
      },
    ]);
  });

  test("every early work status starts it; review and QA do not", () => {
    for (const to of ["spiking", "plan_review", "planned", "building"])
      expect(run([event({ to_status: to })]).map((p) => p.moment)).toEqual([
        "started",
      ]);
    for (const to of ["code_review", "qa_human", "parked", "prioritized"])
      expect(run([event({ to_status: to })])).toEqual([]);
  });

  test("an event with no status move files nothing", () => {
    expect(run([event({ to_status: null })])).toEqual([]);
    expect(run([event({ from_status: "staffed" })])).toEqual([]);
  });

  test("the mirror's own writes are ignored", () => {
    expect(run([event({ actor_id: "jira:example.atlassian.net" })])).toEqual(
      [],
    );
  });

  test("a ticket the rows do not name (not mirrored) files nothing", () => {
    expect(
      pushesOf({ events: [event()], links: [link()], tickets: new Map() }),
    ).toEqual([]);
  });

  test("a ticket of another site, or with no issue key, files nothing", () => {
    expect(
      run(
        [event()],
        [link()],
        ticket({ jira_url: "https://other.atlassian.net" }),
      ),
    ).toEqual([]);
    expect(run([event()], [], ticket({ origin_ref: null }))).toEqual([]);
    expect(run([event()], [], ticket({ origin_ref: "not a key" }))).toEqual([]);
    expect(run([event()], [], ticket({ origin_fingerprint: null }))).toEqual(
      [],
    );
  });

  test("a moment the map leaves out moves nothing", () => {
    expect(run([event()], [], ticket({ status_map: {} }))).toEqual([]);
  });

  test("done files the done transition; a comment only when the merge is known", () => {
    expect(
      run([event({ to_status: "done", from_status: "qa_human" })]),
    ).toEqual([
      expect.objectContaining({ moment: "done", dedupe_key: "t:T1:done" }),
    ]);
    const merged = run([
      event({
        to_status: "done",
        from_status: "qa_human",
        payload_json: JSON.stringify({
          merged_by: "octo",
          pr_url: "https://forge.example/o/r/pull/7",
          prs: [{ url: "https://forge.example/o/s/pull/2" }],
        }),
      }),
    ]);
    expect(merged[1]).toEqual({
      kind: "comment",
      ticket_id: "T1",
      workspace_id: "P",
      issue_key: "ABC-1",
      moment: "done",
      dedupe_key: "c:T1:merged",
      payload: {
        lead: "Merged by octo:",
        urls: [
          "https://forge.example/o/r/pull/7",
          "https://forge.example/o/s/pull/2",
        ],
      },
    });
  });

  test("a pull request files in_review and its comment; comments off files only the move", () => {
    expect(run([], [link()])).toEqual([
      expect.objectContaining({
        kind: "transition",
        moment: "in_review",
        payload: { status: "In Review" },
      }),
      expect.objectContaining({
        kind: "comment",
        moment: "in_review",
        dedupe_key: "c:T1:pr:https://forge.example/o/r/pull/7",
        payload: {
          lead: "Pull request:",
          urls: ["https://forge.example/o/r/pull/7"],
        },
      }),
    ]);
    expect(run([], [link()], ticket({ comment_prs: false }))).toEqual([
      expect.objectContaining({ kind: "transition" }),
    ]);
  });

  test("a pull request of a done ticket comments but does not move it back", () => {
    expect(run([], [link()], ticket({ status: "done" }))).toEqual([
      expect.objectContaining({ kind: "comment" }),
    ]);
  });

  test("a url that is not http(s) is never commented", () => {
    expect(run([], [link({ url: "javascript:alert(1)" })])).toEqual([]);
  });

  test("every push it files is one the outbox writer accepts", () => {
    for (const p of run([event()], [link()]))
      expect(NewJiraPush.safeParse(p).success).toBe(true);
  });
});

describe("mergedInfoOf", () => {
  test("reads merge_close's own payload, exactly as an earlier change writes it", () => {
    expect(
      mergedInfoOf(
        JSON.stringify({
          rule: "merge_close",
          merged_by: "octo",
          pr_urls: [
            "https://forge.example/o/r/pull/7",
            "https://forge.example/o/s/pull/2",
          ],
        }),
      ),
    ).toEqual({
      by: "octo",
      urls: [
        "https://forge.example/o/r/pull/7",
        "https://forge.example/o/s/pull/2",
      ],
    });
    expect(
      mergedInfoOf(
        JSON.stringify({
          rule: "merge_close",
          merged_by: "unknown",
          pr_urls: ["https://forge.example/o/r/pull/7"],
        }),
      ),
    ).toEqual({ by: null, urls: ["https://forge.example/o/r/pull/7"] });
    // Another rule's move is not a merge, whatever it carries.
    expect(
      mergedInfoOf(
        JSON.stringify({
          rule: "pass_harness",
          merged_by: "octo",
          pr_urls: ["https://forge.example/o/r/pull/7"],
        }),
      ),
    ).toBeNull();
  });

  test("a done by merge_close files the done move and one merged comment; no login says so", () => {
    const done = (merged_by: string) =>
      run([
        event({
          from_status: "qa_harness",
          to_status: "done",
          payload_json: JSON.stringify({
            rule: "merge_close",
            merged_by,
            pr_urls: ["https://forge.example/o/r/pull/7"],
          }),
        }),
      ]);
    expect(done("octo").map((p) => [p.kind, p.moment, p.payload])).toEqual([
      ["transition", "done", { status: "Done" }],
      [
        "comment",
        "done",
        {
          lead: "Merged by octo:",
          urls: ["https://forge.example/o/r/pull/7"],
        },
      ],
    ]);
    expect(done("unknown")[1]?.payload).toEqual({
      lead: "Merged:",
      urls: ["https://forge.example/o/r/pull/7"],
    });
  });

  test("tolerates no payload, bad JSON, no merger and no url", () => {
    expect(mergedInfoOf(null)).toBeNull();
    expect(mergedInfoOf("{")).toBeNull();
    expect(mergedInfoOf('{"pr_url":"https://x.example/1"}')).toBeNull();
    expect(mergedInfoOf('{"merged_by":"a"}')).toBeNull();
    expect(mergedInfoOf('{"merged_by":"a","pr_urls":["ftp://x"]}')).toBeNull();
  });

  test("dedupes urls from every field, and ignores a malformed one", () => {
    expect(
      mergedInfoOf(
        JSON.stringify({
          merged_by: "a",
          pr_url: "https://x.example/1",
          pr_urls: ["https://x.example/1", "https://x.example/2"],
          prs: "nonsense",
        }),
      ),
    ).toEqual({
      by: "a",
      urls: ["https://x.example/1", "https://x.example/2"],
    });
  });
});

describe("the status map", () => {
  test("names are trimmed and bounded; unknown keys are refused", () => {
    expect(JiraStatusMap.parse({ started: "  In Progress " })).toEqual({
      started: "In Progress",
    });
    expect(JiraStatusMap.safeParse({ started: "" }).success).toBe(false);
    expect(JiraStatusMap.safeParse({ started: "x".repeat(101) }).success).toBe(
      false,
    );
    expect(JiraStatusMap.safeParse({ later: "Done" }).success).toBe(false);
  });

  test("a stored map is read loosely", () => {
    expect(statusMapOf(null)).toEqual({});
    expect(statusMapOf("{")).toEqual({});
    expect(statusMapOf('{"started":7}')).toEqual({});
    expect(statusMapOf('{"done":"Done"}')).toEqual({ done: "Done" });
  });

  test("isEmptyStatusMap", () => {
    expect(isEmptyStatusMap({})).toBe(true);
    expect(isEmptyStatusMap({ done: "Done" })).toBe(false);
  });
});

describe("keys and urls", () => {
  test("issue keys", () => {
    expect(isJiraIssueKey("ABC-12")).toBe(true);
    expect(isJiraIssueKey("abc-12")).toBe(false);
    expect(isJiraIssueKey("ABC-0")).toBe(false);
    expect(isJiraIssueKey("ABC-1/../x")).toBe(false);
  });

  test("only http(s), no userinfo, bounded", () => {
    expect(isPushableUrl("https://forge.example/p/1")).toBe(true);
    expect(isPushableUrl("http://forge.example/p/1")).toBe(true);
    expect(isPushableUrl("https://u:p@forge.example/p/1")).toBe(false);
    expect(isPushableUrl("https://u@forge.example/p/1")).toBe(false);
    expect(isPushableUrl("file:///etc/passwd")).toBe(false);
    expect(isPushableUrl("not a url")).toBe(false);
    expect(isPushableUrl(`https://x.example/${"a".repeat(500)}`)).toBe(false);
  });
});

describe("commentAdf", () => {
  test("one paragraph: the lead, then each url as a linked text node", () => {
    expect(
      commentAdf({
        lead: "Merged by octo:",
        urls: ["https://x.example/1", "https://x.example/2"],
      }),
    ).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Merged by octo: " },
            {
              type: "text",
              text: "https://x.example/1",
              marks: [{ type: "link", attrs: { href: "https://x.example/1" } }],
            },
            { type: "text", text: ", " },
            {
              type: "text",
              text: "https://x.example/2",
              marks: [{ type: "link", attrs: { href: "https://x.example/2" } }],
            },
          ],
        },
      ],
    });
  });
});

describe("adfText", () => {
  test("a comment's own ADF reads back as its text; anything else as nothing", () => {
    const p = {
      lead: "Merged by octo:",
      urls: ["https://x.example/1", "https://x.example/2"],
    };
    expect(adfText(commentAdf(p))).toBe(
      "Merged by octo: https://x.example/1, https://x.example/2",
    );
    expect(adfText(null)).toBe("");
    expect(adfText({ type: "text", text: 7 })).toBe("");
    expect(adfText({ type: "doc", content: "nope" })).toBe("");
  });

  test("sameCommentText ignores surrounding and repeated whitespace only", () => {
    expect(sameCommentText(" a  b\n", "a b")).toBe(true);
    expect(sameCommentText("a b", "a c")).toBe(false);
  });
});
