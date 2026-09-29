import { expect, test } from "vitest";
import {
  PAGE_TRIMMED,
  adfBodyToMarkdown,
  pageMarkdown,
  storageToText,
  trimPage,
} from "./page.js";
import {
  DOCS_SPACE_KEY,
  NO_DOCS_SOURCE,
  docsSpaceAllowed,
  isDocsKind,
  isDocsSpaceKey,
} from "./source.js";

// A page's body as Markdown. No site, space or page name here: the fixtures are shapes.

const DOC = {
  type: "doc",
  version: 1,
  content: [
    { type: "heading", attrs: { level: 2 }, content: [text("Done when")] },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [text("the gate passes")] }],
        },
      ],
    },
    {
      type: "paragraph",
      content: [
        text("see "),
        { ...text("the rule"), marks: [{ type: "strong" }] },
      ],
    },
  ],
};

function text(value: string) {
  return { type: "text", text: value };
}

const MARKDOWN = "## Done when\n\n- the gate passes\n\nsee **the rule**";

test("an ADF body that arrives as a JSON string is parsed before it is converted", () => {
  // Confluence hands atlas_doc_format back as a string. Unparsed it would read as one line.
  expect(adfBodyToMarkdown(JSON.stringify(DOC))).toBe(MARKDOWN);
  expect(adfBodyToMarkdown(DOC)).toBe(MARKDOWN);
});

test("a string that is not JSON is its own text, and an absent body is empty", () => {
  expect(adfBodyToMarkdown("just some words")).toBe("just some words");
  expect(adfBodyToMarkdown("{not json")).toBe("{not json");
  expect(adfBodyToMarkdown(undefined)).toBe("");
  expect(adfBodyToMarkdown(null)).toBe("");
  // JSON that is not a document still goes through the loose parse rather than throwing.
  expect(adfBodyToMarkdown("[1,2]")).toBe("");
});

test("a storage body falls back to its text: tags dropped, entities decoded, blanks collapsed", () => {
  expect(
    storageToText(
      "<h2>Done when</h2><p>the gate &amp; the harness pass</p><ul><li>one</li><li>two</li></ul>",
    ),
  ).toBe("Done when\n\nthe gate & the harness pass\n\none\n\ntwo");
  expect(storageToText("<p>a &#38; b &#x26; c &unknown;</p>")).toBe(
    "a & b & c &unknown;",
  );
  expect(storageToText("<p>a</p><script>alert(1)</script><p>b</p>")).toBe(
    "a\n\nb",
  );
  expect(storageToText("<p>a</p>\n\n\n\n<p>b</p>")).toBe("a\n\nb");
  expect(storageToText(undefined)).toBe("");
  expect(storageToText(42)).toBe("");
});

test("a page's markdown is its ADF, or its storage text when there is none", () => {
  expect(pageMarkdown({ adf: JSON.stringify(DOC) })).toBe(MARKDOWN);
  expect(pageMarkdown({ adf: "", storage: "<p>fallback</p>" })).toBe(
    "fallback",
  );
  expect(pageMarkdown({ storage: "<p>fallback</p>" })).toBe("fallback");
  expect(pageMarkdown({})).toBe("");
});

test("a page is trimmed to the cap and says it was trimmed", () => {
  expect(trimPage("short", 10)).toBe("short");
  expect(trimPage("0123456789", 10)).toBe("0123456789");
  expect(trimPage("0123456789ab", 10)).toBe(`0123456789${PAGE_TRIMMED}`);
  expect(trimPage("0123456   ab", 10)).toBe(`0123456${PAGE_TRIMMED}`);
});

test("the source rules: the kinds, the space-key shape, and what an empty allowlist means", () => {
  expect(isDocsKind("none")).toBe(true);
  expect(isDocsKind("confluence")).toBe(true);
  for (const bad of ["", "wiki", 7, null])
    expect(isDocsKind(bad), `${bad}`).toBe(false);

  expect(DOCS_SPACE_KEY.test("A")).toBe(true);
  expect(isDocsSpaceKey("A_1")).toBe(true);
  // Confluence Cloud keys can be mixed case: a site's real key may be `Docs`.
  for (const good of ["Docs", "docs", "a", "Team_2", "Z".repeat(50)]) {
    expect(isDocsSpaceKey(good), good).toBe(true);
  }
  for (const bad of ["", "A-1", "A B", "~acct", "Dö", 'A"', "A".repeat(51)]) {
    expect(isDocsSpaceKey(bad), bad).toBe(false);
  }

  // Empty means "any space the account can read"; a list means exactly those.
  expect(docsSpaceAllowed(NO_DOCS_SOURCE, "ANY")).toBe(true);
  const source = { ...NO_DOCS_SOURCE, spaces: ["ONE"] };
  expect(docsSpaceAllowed(source, "ONE")).toBe(true);
  expect(docsSpaceAllowed(source, "TWO")).toBe(false);
  expect(docsSpaceAllowed(source, "one")).toBe(false);
});

test("a mixed-case grant admits exactly that key: the comparison is not case-folded", () => {
  const source = { ...NO_DOCS_SOURCE, spaces: ["Docs"] };
  expect(docsSpaceAllowed(source, "Docs")).toBe(true);
  for (const other of ["DOCS", "docs", "dOCS", "Docs ", "Other"]) {
    expect(docsSpaceAllowed(source, other), other).toBe(false);
  }
});
