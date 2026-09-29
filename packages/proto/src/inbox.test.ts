import { describe, expect, test } from "vitest";
import {
  AnswerRequest,
  INBOX_ANSWER_MAX_CHARS,
  INBOX_PAGE_DEFAULT_LIMIT,
  InboxQuery,
} from "./inbox.js";

describe("AnswerRequest", () => {
  test("trims the answer and keeps it", () => {
    expect(AnswerRequest.parse({ answer: "  use sqlite \n" })).toEqual({
      answer: "use sqlite",
    });
  });

  test("an empty, blank, missing or over-long answer, or another field, is refused", () => {
    for (const body of [
      {},
      { answer: "" },
      { answer: " \n\t " },
      { answer: 3 },
      { answer: "x".repeat(INBOX_ANSWER_MAX_CHARS + 1) },
      { answer: "yes", by: "me" },
    ]) {
      expect(AnswerRequest.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });
});

describe("InboxQuery", () => {
  test("defaults to both statuses from the top; the cursor passes through opaque", () => {
    expect(InboxQuery.parse({})).toEqual({ limit: INBOX_PAGE_DEFAULT_LIMIT });
    expect(
      InboxQuery.parse({
        status: "answered",
        cursor: "WzEsMiwieCJd",
        limit: "20",
      }),
    ).toEqual({ status: "answered", cursor: "WzEsMiwieCJd", limit: 20 });
  });

  test("an unknown status, an empty or over-long cursor, or an out-of-range limit is refused", () => {
    for (const query of [
      { status: "expired" },
      { cursor: "" },
      { cursor: "x".repeat(257) },
      { limit: "0" },
      { limit: "101" },
    ]) {
      expect(InboxQuery.safeParse(query).success, JSON.stringify(query)).toBe(
        false,
      );
    }
  });
});
