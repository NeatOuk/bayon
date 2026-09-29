import { describe, expect, test } from "vitest";
import { ApiErrorBody } from "./rest.js";
import {
  CreateTicketRequest,
  PatchTicketRequest,
  PlanPath,
  TicketEventsQuery,
  TicketRef,
  TicketView,
  TicketsQuery,
  TransitionRequest,
  etagOf,
} from "./tickets.js";

// The /api/v1/tickets DTOs (§12.1, M1 contracts 3 and 8).

describe("TicketsQuery", () => {
  test("splits statuses, reads needs_human as a flag and defaults the limit", () => {
    expect(
      TicketsQuery.parse({
        status: "backlog,building",
        needs_human: "1",
        tier: "complex",
        q: " auth ",
        cursor: "12",
      }),
    ).toEqual({
      status: ["backlog", "building"],
      needs_human: true,
      tier: "complex",
      q: "auth",
      cursor: 12,
      limit: 50,
    });
    expect(TicketsQuery.parse({ needs_human: "0", limit: "100" })).toEqual({
      needs_human: false,
      limit: 100,
    });
    expect(TicketsQuery.parse({})).toEqual({ limit: 50 });
  });

  test.each([
    { status: "nope" },
    { status: "," },
    { needs_human: "yes" },
    { limit: "101" },
    { limit: "0" },
    { tier: "huge" },
    { cursor: "-1" },
  ])("rejects %o", (query) => {
    expect(TicketsQuery.safeParse(query).success).toBe(false);
  });
});

describe("TicketEventsQuery", () => {
  test("defaults since and limit", () => {
    expect(TicketEventsQuery.parse({})).toEqual({ since: 0, limit: 100 });
    expect(TicketEventsQuery.parse({ since: "9", limit: "3" })).toEqual({
      since: 9,
      limit: 3,
    });
  });
});

describe("TicketRef", () => {
  test.each(["42", "1", "01J9ZQ3M8Z6K0V5N1X2Y3Z4A5B"])("%s is a ref", (ref) => {
    expect(TicketRef.safeParse(ref).success).toBe(true);
  });
  test.each(["0", "abc", "01j9zq3m8z6k0v5n1x2y3z4a5b", "4 2", ""])(
    "%s is not",
    (ref) => {
      expect(TicketRef.safeParse(ref).success).toBe(false);
    },
  );
});

describe("PlanPath", () => {
  test.each(["docs/spikes/T1.md", "PLAN.md", "a/b-c_d.e"])(
    "%s is a plan path",
    (p) => {
      expect(PlanPath.safeParse(p).success).toBe(true);
    },
  );
  test.each([
    "",
    "/etc/passwd",
    "../x.md",
    "docs/../x.md",
    "./x.md",
    "docs//x.md",
    "docs/",
    "a\\b.md",
    `${"a".repeat(257)}`,
  ])("%s is not", (p) => {
    expect(PlanPath.safeParse(p).success).toBe(false);
  });
});

describe("CreateTicketRequest", () => {
  test("needs a title and a type; the rest is optional", () => {
    expect(
      CreateTicketRequest.parse({ title: " Add a README ", type: "docs" }),
    ).toEqual({ title: "Add a README", type: "docs" });
    expect(
      CreateTicketRequest.parse({
        title: "t",
        type: "feature",
        priority: 1,
        plan_path: "docs/p.md",
        complexity_facts: { concurrency: true },
        needs_human: true,
      }),
    ).toMatchObject({ priority: 1, complexity_facts: { concurrency: true } });
  });

  test.each([
    { type: "docs" },
    { title: "  ", type: "docs" },
    { title: "t", type: "epic" },
    { title: "t", type: "docs", priority: 6 },
    { title: "t", type: "docs", status: "done" },
    { title: "t", type: "docs", plan_path: "/abs.md" },
    { title: "t", type: "docs", complexity_facts: { concurrency: "yes" } },
  ])("rejects %o", (body) => {
    expect(CreateTicketRequest.safeParse(body).success).toBe(false);
  });
});

describe("PatchTicketRequest", () => {
  test("takes any editable field, and null clears the nullable ones", () => {
    expect(
      PatchTicketRequest.parse({ needs_human: true, plan_path: null }),
    ).toEqual({ needs_human: true, plan_path: null });
  });

  test("a pull request URL is http or https", () => {
    const url = "https://github.com/o/r/pull/1";
    expect(PatchTicketRequest.parse({ pr_url: url })).toEqual({ pr_url: url });
  });

  test.each([
    {},
    { status: "done" },
    { version: 3 },
    { num: 7 },
    { cost_usd: 1 },
    { title: "" },
    { pr_url: "javascript:alert(1)" },
    { pr_url: "ftp://x.test/a" },
  ])("rejects %o", (body) => {
    expect(PatchTicketRequest.safeParse(body).success).toBe(false);
  });
});

describe("TransitionRequest", () => {
  test("names the target, with optional notes", () => {
    expect(
      TransitionRequest.parse({ to: "rework", reason: " the button is gone " }),
    ).toEqual({ to: "rework", reason: "the button is gone" });
  });

  test("blocking needs both blocked fields", () => {
    expect(TransitionRequest.safeParse({ to: "blocked" }).success).toBe(false);
    expect(
      TransitionRequest.safeParse({ to: "blocked", blocked_reason: "CI down" })
        .success,
    ).toBe(false);
    expect(
      TransitionRequest.parse({
        to: "blocked",
        blocked_reason: "CI down",
        unblock_condition: "CI up",
      }),
    ).toMatchObject({ to: "blocked" });
  });

  test.each([{ to: "nope" }, { to: "building", extra: 1 }, {}])(
    "rejects %o",
    (body) => {
      expect(TransitionRequest.safeParse(body).success).toBe(false);
    },
  );
});

describe("wire", () => {
  test("an ETag is the quoted version", () => {
    expect(etagOf(7)).toBe('"7"');
  });

  test("a law refusal names its rule, reason and detail", () => {
    expect(
      ApiErrorBody.parse({
        error: {
          class: "law_refused",
          message: "start_spike: no live session holds ticket T1",
          retryable: false,
          rule: "start_spike",
          reason: "no_session",
          detail: "no live session holds ticket T1",
        },
      }).error,
    ).toMatchObject({ rule: "start_spike", reason: "no_session" });
  });

  test("a ticket view parses a ticket", () => {
    const view = {
      id: "01J9ZQ3M8Z6K0V5N1X2Y3Z4A5B",
      key: "FRM-1",
      num: 1,
      title: "t",
      body_md: "",
      acceptance_md: "",
      type: "chore",
      status: "backlog",
      priority: 3,
      needs_human: false,
      open_questions: 0,
      non_trivial: false,
      complexity_score: 0,
      complexity_tier: "cheap",
      complexity_factors: null,
      workspace_id: null,
      epic_id: null,
      parent_ticket_id: null,
      origin: "operator",
      origin_ref: null,
      blocked_reason: null,
      unblock_condition: null,
      owner_session_id: null,
      branch: null,
      plan_path: null,
      pr_url: null,
      split_depth: 0,
      children_total: 0,
      children_done: 0,
      version: 1,
      created_at: 1,
      updated_at: 1,
      closed_at: null,
    };
    expect(TicketView.parse(view)).toEqual(view);
  });
});
