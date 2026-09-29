import { expect, test } from "vitest";
import { cqlEscape, cqlText, docsSearchCql } from "./cql.js";

// CQL is built, never concatenated: an agent's words are a term inside a query language
// with its own operators, and every structural part of the query is ours.

test("every character CQL reads as syntax is escaped once, and the rest is left alone", () => {
  expect(cqlEscape('a "quoted" word')).toBe('a \\"quoted\\" word');
  expect(cqlEscape("a\\b")).toBe("a\\\\b");
  expect(cqlEscape("~ contains")).toBe("\\~ contains");
  // A backslash before a quote is escaped once as a backslash and once as a quote: not twice over.
  expect(cqlEscape('\\"')).toBe('\\\\\\"');
  for (const c of "+-&|!(){}[]^~*?:") {
    expect(cqlEscape(c), c).toBe(`\\${c}`);
  }
  expect(cqlEscape("acceptance criteria")).toBe("acceptance criteria");
  expect(cqlText("a ~ b")).toBe('"a \\~ b"');
});

test("a query that tries to close its own term and add a clause stays one escaped term", () => {
  const cql = docsSearchCql({
    query: '" OR type = user AND text ~ "',
    allowed: [],
  });
  expect(cql).toBe(
    'type = page AND text ~ "\\" OR type = user AND text \\~ \\"" order by lastmodified desc',
  );
  // One `text ~` clause, and the injected operators are inside its quotes.
  expect(cql.match(/text ~ /g)).toHaveLength(1);
});

test("the space clause comes from the project's own list, whatever the query says", () => {
  expect(docsSearchCql({ query: "q", allowed: [] })).toBe(
    'type = page AND text ~ "q" order by lastmodified desc',
  );
  expect(docsSearchCql({ query: "q", allowed: ["ONE"] })).toBe(
    'type = page AND text ~ "q" AND space = "ONE" order by lastmodified desc',
  );
  expect(docsSearchCql({ query: "q", allowed: ["ONE", "TWO"] })).toBe(
    'type = page AND text ~ "q" AND space in ("ONE","TWO") order by lastmodified desc',
  );
});

test("a space the caller named narrows the search; it never widens it", () => {
  expect(
    docsSearchCql({ query: "q", allowed: ["ONE", "TWO"], space: "TWO" }),
  ).toContain('space = "TWO"');
  // The caller's space is checked against the allowlist before this is built (docs/reader.ts).
  expect(docsSearchCql({ query: "q", allowed: [], space: "ONE" })).toContain(
    'space = "ONE"',
  );
});

test("a mixed-case space key is quoted as it is, and a hostile one stays one escaped term", () => {
  expect(docsSearchCql({ query: "q", allowed: ["Docs"] })).toBe(
    'type = page AND text ~ "q" AND space = "Docs" order by lastmodified desc',
  );
  expect(docsSearchCql({ query: "q", allowed: ["Docs", "ops_2"] })).toBe(
    'type = page AND text ~ "q" AND space in ("Docs","ops_2") order by lastmodified desc',
  );
  // The schema refuses such a key before it is stored; the builder is safe without that.
  const cql = docsSearchCql({ query: "q", allowed: ['x") OR space != ("y'] });
  expect(cql).toBe(
    'type = page AND text ~ "q" AND space = "x\\"\\) OR space \\!= \\(\\"y" order by lastmodified desc',
  );
  expect(cql.match(/ AND /g)).toHaveLength(2);
});
