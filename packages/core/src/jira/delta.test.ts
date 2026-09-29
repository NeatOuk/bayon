import { describe, expect, test } from "vitest";
import {
  JIRA_DELTA_MIN_WINDOW_MIN,
  deltaJql,
  deltaWindowMinutes,
} from "./delta.js";

// The quick pass's query: the project's JQL narrowed to the issues updated within the
// window, with any ORDER BY kept at the end, where JQL allows it.

describe("deltaJql", () => {
  test.each([
    ["a plain query", "project = ABC", '(project = ABC) AND updated >= "-2m"'],
    [
      "an OR is kept whole by the parentheses",
      "project = ABC OR assignee = currentUser()",
      '(project = ABC OR assignee = currentUser()) AND updated >= "-2m"',
    ],
    [
      "ORDER BY moves after the added condition",
      "project = ABC ORDER BY rank ASC",
      '(project = ABC) AND updated >= "-2m" ORDER BY rank ASC',
    ],
    [
      "in any case, with any whitespace, and several keys",
      "project = ABC\n  order\tBY priority DESC, created ASC  ",
      '(project = ABC) AND updated >= "-2m" order\tBY priority DESC, created ASC',
    ],
    [
      "a query that is only an ORDER BY",
      "ORDER BY created DESC",
      'updated >= "-2m" ORDER BY created DESC',
    ],
    [
      "order by inside a double-quoted string is text",
      'summary ~ "sort order by date" ORDER BY key',
      '(summary ~ "sort order by date") AND updated >= "-2m" ORDER BY key',
    ],
    [
      "and inside a single-quoted string, past an escaped quote",
      "summary ~ 'it\\'s order by' AND project = ABC",
      "(summary ~ 'it\\'s order by' AND project = ABC) AND updated >= \"-2m\"",
    ],
    [
      "an escaped double quote does not end the string",
      'summary ~ "a \\" order by b" order by key',
      '(summary ~ "a \\" order by b") AND updated >= "-2m" order by key',
    ],
    [
      "inside parentheses it is not the query's clause",
      "issue in linkedIssues(ABC-1) AND (x = 1 order by y) ORDER BY key",
      '(issue in linkedIssues(ABC-1) AND (x = 1 order by y)) AND updated >= "-2m" ORDER BY key',
    ],
    [
      "a word that ends in order is not the clause",
      "cf_order by = 1",
      '(cf_order by = 1) AND updated >= "-2m"',
    ],
    [
      "nor one that starts with it",
      "orderly = 1 AND byline = 2",
      '(orderly = 1 AND byline = 2) AND updated >= "-2m"',
    ],
    [
      "the clause right after a closing quote or parenthesis",
      'summary ~ "x"ORDER BY key',
      '(summary ~ "x") AND updated >= "-2m" ORDER BY key',
    ],
  ])("%s", (_, jql, expected) => {
    expect(deltaJql(jql, 2)).toBe(expected);
  });

  test("the window is the number of minutes given", () => {
    expect(deltaJql("project = ABC", 16)).toBe(
      '(project = ABC) AND updated >= "-16m"',
    );
  });
});

describe("deltaWindowMinutes", () => {
  test.each([
    [0, JIRA_DELTA_MIN_WINDOW_MIN],
    [1, 2],
    [60_000, 2],
    [60_001, 3],
    [180_000, 4],
    [300_000, 6],
    [300_001, 7],
    [900_000, 16],
  ])("%d ms since the last pass looks back %d minutes", (elapsed, minutes) => {
    expect(deltaWindowMinutes(elapsed)).toBe(minutes);
  });

  test("never under two minutes, even for a clock that stepped back", () => {
    expect(JIRA_DELTA_MIN_WINDOW_MIN).toBe(2);
    expect(deltaWindowMinutes(-120_000)).toBe(2);
  });
});
