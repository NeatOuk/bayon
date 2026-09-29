import { describe, expect, test } from "vitest";
import { ADF_MAX_DEPTH, adfToMarkdown } from "./adf.js";

// ADF into Markdown: one row per node and mark, nested lists, the loose parse, and the
// fallback that keeps an unknown node's text.

type Node = Record<string, unknown>;
const doc = (...content: Node[]): Node => ({
  type: "doc",
  version: 1,
  content,
});
const p = (...content: Node[]): Node => ({ type: "paragraph", content });
const t = (text: string, ...marks: (string | Node)[]): Node => ({
  type: "text",
  text,
  marks: marks.map((m) => (typeof m === "string" ? { type: m } : m)),
});
const link = (href: unknown): Node => ({ type: "link", attrs: { href } });
const li = (...content: Node[]): Node => ({ type: "listItem", content });
const bullets = (...items: Node[]): Node => ({
  type: "bulletList",
  content: items,
});
const cellOf = (type: string, ...content: Node[]): Node => ({
  type,
  content,
});
const row = (...cells: Node[]): Node => ({ type: "tableRow", content: cells });

describe("adfToMarkdown", () => {
  test.each<[string, unknown, string]>([
    ["null is empty", null, ""],
    ["absent is empty", undefined, ""],
    ["a plain string is itself, trimmed", "  plain text \n", "plain text"],
    ["an empty document", doc(), ""],
    ["a paragraph", doc(p(t("Hello "), t("world"))), "Hello world"],
    ["paragraphs, blank-line apart", doc(p(t("a")), p(t("b"))), "a\n\nb"],
    ["an empty paragraph is dropped", doc(p(t("a")), p(), p(t("b"))), "a\n\nb"],
    [
      "a heading at its level",
      doc({ type: "heading", attrs: { level: 3 }, content: [t("Title")] }),
      "### Title",
    ],
    [
      "a heading's level is held to 1..6",
      doc(
        { type: "heading", attrs: { level: 9 }, content: [t("deep")] },
        { type: "heading", attrs: { level: 0 }, content: [t("top")] },
      ),
      "###### deep\n\n# top",
    ],
    [
      "a heading with no usable level is 1",
      doc({ type: "heading", attrs: { level: "x" }, content: [t("h")] }),
      "# h",
    ],
    ["strong", doc(p(t("bold", "strong"))), "**bold**"],
    ["em", doc(p(t("it", "em"))), "*it*"],
    ["strike", doc(p(t("gone", "strike"))), "~~gone~~"],
    ["code", doc(p(t("x = 1", "code"))), "`x = 1`"],
    ["code holding a backtick", doc(p(t("a`b", "code"))), "`` a`b ``"],
    [
      "every mark at once, the link outermost",
      doc(
        p(t("all", "code", "strike", "em", "strong", link("https://a.test"))),
      ),
      "[***~~`all`~~***](https://a.test)",
    ],
    [
      "marks stay inside the text's own spaces",
      doc(p(t("say "), t(" loud ", "strong"), t("now"))),
      "say  **loud** now",
    ],
    [
      "a marked blank is left as it is",
      doc(p(t("a"), t(" ", "strong"), t("b"))),
      "a b",
    ],
    ["an empty text node", doc(p(t(""), t("x"))), "x"],
    ["a text node without text", doc(p({ type: "text" }, t("y"))), "y"],
    [
      "a link",
      doc(p(t("docs", link("https://example.test/a b(c)")))),
      "[docs](https://example.test/a%20b%28c%29)",
    ],
    [
      "a mailto link",
      doc(p(t("me", link("mailto:a@b.test")))),
      "[me](mailto:a@b.test)",
    ],
    [
      "a javascript: link is plain text",
      doc(p(t("click", link("javascript:alert(1)")))),
      "click",
    ],
    [
      "a link without an href is plain text",
      doc(p(t("x", link(undefined)))),
      "x",
    ],
    ["an unknown mark keeps the text", doc(p(t("u", "underline"))), "u"],
    [
      "a hard break",
      doc(p(t("one"), { type: "hardBreak" }, t("two"))),
      "one  \ntwo",
    ],
    ["a bullet list", doc(bullets(li(p(t("a"))), li(p(t("b"))))), "- a\n- b"],
    [
      "nested lists indent under their item",
      doc(
        bullets(
          li(p(t("a")), {
            type: "orderedList",
            content: [
              li(p(t("one"))),
              li(p(t("two")), bullets(li(p(t("deep"))))),
            ],
          }),
          li(p(t("b"))),
        ),
      ),
      "- a\n  1. one\n  2. two\n     - deep\n- b",
    ],
    [
      "an ordered list from its order",
      doc({
        type: "orderedList",
        attrs: { order: 4 },
        content: [li(p(t("four"))), li(p(t("five")))],
      }),
      "4. four\n5. five",
    ],
    [
      "an ordered list with no usable order starts at 1",
      doc({
        type: "orderedList",
        attrs: { order: -2 },
        content: [li(p(t("x")))],
      }),
      "1. x",
    ],
    [
      "an item's own blank line stays blank, unindented",
      doc(bullets(li({ type: "codeBlock", content: [t("a\n\nb")] }))),
      "- ```\n  a\n\n  b\n  ```",
    ],
    [
      "a code block with its language",
      doc({
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [t("const a = 1;")],
      }),
      "```ts\nconst a = 1;\n```",
    ],
    [
      "a code block without one",
      doc({ type: "codeBlock", content: [t("plain")] }),
      "```\nplain\n```",
    ],
    [
      "a code block's fence outgrows the backticks inside it",
      doc({ type: "codeBlock", content: [t("````md\nx\n````")] }),
      "`````\n````md\nx\n````\n`````",
    ],
    [
      "a blockquote",
      doc({ type: "blockquote", content: [p(t("a")), p(t("b"))] }),
      "> a\n>\n> b",
    ],
    ["a rule", doc(p(t("a")), { type: "rule" }, p(t("b"))), "a\n\n---\n\nb"],
    [
      "a mention by its text",
      doc(p({ type: "mention", attrs: { id: "abc", text: "@Ada" } })),
      "@Ada",
    ],
    [
      "a mention whose text has no @",
      doc(p({ type: "mention", attrs: { text: "Ada" } })),
      "@Ada",
    ],
    [
      "a mention by its id alone",
      doc(p({ type: "mention", attrs: { id: "557058:abc" } })),
      "@557058:abc",
    ],
    ["a mention with nothing", doc(p(t("hi "), { type: "mention" })), "hi @"],
    [
      "an emoji by its text",
      doc(p({ type: "emoji", attrs: { shortName: ":smile:", text: "😄" } })),
      "😄",
    ],
    [
      "an emoji by its short name",
      doc(p({ type: "emoji", attrs: { shortName: ":party:", text: "" } })),
      ":party:",
    ],
    ["an emoji with neither", doc(p(t("a"), { type: "emoji" })), "a"],
    [
      "an inline card",
      doc(
        p(t("see "), {
          type: "inlineCard",
          attrs: { url: "https://x.test/1" },
        }),
      ),
      "see <https://x.test/1>",
    ],
    [
      "a block card",
      doc({ type: "blockCard", attrs: { url: "https://x.test/<2>" } }),
      "<https://x.test/%3C2%3E>",
    ],
    [
      "a card without a url keeps its text",
      doc({ type: "blockCard", attrs: { data: {} }, content: [t("card")] }),
      "card",
    ],
    [
      "a table as pipe rows, a header rule after the first",
      doc({
        type: "table",
        content: [
          row(
            cellOf("tableHeader", p(t("Name"))),
            cellOf("tableHeader", p(t("Why"))),
          ),
          row(
            cellOf("tableCell", p(t("a|b"))),
            cellOf("tableCell", p(t("one")), p(t("two"))),
          ),
          row(cellOf("tableCell", p(t("short")))),
        ],
      }),
      "| Name | Why |\n| --- | --- |\n| a\\|b | one<br>two |\n| short |  |",
    ],
    ["an empty table", doc({ type: "table", content: [] }), ""],
    [
      "a panel as its text",
      doc({
        type: "panel",
        attrs: { panelType: "info" },
        content: [p(t("note"))],
      }),
      "note",
    ],
    [
      "an expand as its title and text",
      doc({
        type: "expand",
        attrs: { title: "More" },
        content: [p(t("hidden"))],
      }),
      "**More**\n\nhidden",
    ],
    [
      "an expand with only a title",
      doc({ type: "nestedExpand", attrs: { title: "Empty" }, content: [] }),
      "**Empty**",
    ],
    [
      "an expand without a title",
      doc({ type: "expand", content: [p(t("body"))] }),
      "body",
    ],
    [
      "a status as its text",
      doc(p(t("state: "), { type: "status", attrs: { text: "IN REVIEW" } })),
      "state: IN REVIEW",
    ],
    ["a status without text", doc(p(t("s"), { type: "status" })), "s"],
    [
      "a date as its day",
      doc(p({ type: "date", attrs: { timestamp: "1700000000000" } })),
      "2023-11-14",
    ],
    [
      "a date without a timestamp is dropped",
      doc(p(t("n"), { type: "date" })),
      "n",
    ],
    [
      "a date out of range is dropped",
      doc(p(t("d"), { type: "date", attrs: { timestamp: "9e99" } })),
      "d",
    ],
    [
      "an unknown node falls back to its descendants' text",
      doc({
        type: "decisionList",
        content: [
          { type: "decisionItem", content: [t("ship "), t("it", "strong")] },
        ],
      }),
      "ship it",
    ],
    [
      "a node that is not an object is empty, its siblings kept",
      doc(p(t("a")), "junk" as unknown as Node, p(t("b"))),
      "a\n\nb",
    ],
    [
      "malformed fields fall back to neutral values",
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: "nope",
            marks: "nope",
            content: [{ type: 7, text: 5, content: "x" }, t("kept")],
          },
          { type: "codeBlock", content: "not a list" },
        ],
      },
      "kept\n\n```\n\n```",
    ],
    ["a document that is not an object", 42, ""],
  ])("%s", (_name, input, expected) => {
    expect(adfToMarkdown(input)).toBe(expected);
  });
});

describe("depth", () => {
  /** `depth` levels of `wrap` around a paragraph holding `inner`. */
  function nested(
    depth: number,
    wrap: (child: Node) => Node,
    inner: string,
  ): Node {
    let node: Node = p(t(inner));
    for (let i = 0; i < depth; i += 1) node = wrap(node);
    return doc(node);
  }

  test.each<[string, (child: Node) => Node]>([
    ["blockquote", (c) => ({ type: "blockquote", content: [c] })],
    ["bulletList", (c) => bullets(li(c))],
    ["panel", (c) => ({ type: "panel", content: [c] })],
    ["expand", (c) => ({ type: "expand", content: [c] })],
    ["an unknown node", (c) => ({ type: "layoutSection", content: [c] })],
  ])(
    "5000 levels of %s render without throwing and keep the innermost text",
    (_name, wrap) => {
      const out = adfToMarkdown(nested(5_000, wrap, "the bottom"));
      expect(out).toContain("the bottom");
    },
  );

  test("the text past the cap is kept in order, its formatting folded away", () => {
    const deep = nested(
      ADF_MAX_DEPTH + 10,
      (c) => ({ type: "panel", content: [c] }),
      "x",
    );
    const wide = {
      type: "panel",
      content: [
        p(t("a ")),
        "not a node" as unknown as Node,
        { type: "rule" },
        { type: "blockquote", content: [p(t("b", "strong"))] },
        p(t(" c")),
      ],
    };
    let node: Node = wide;
    for (let i = 0; i < ADF_MAX_DEPTH; i += 1)
      node = { type: "panel", content: [node] };
    expect(adfToMarkdown(deep)).toBe("x");
    expect(adfToMarkdown(doc(node))).toBe("a b c");
  });

  test("a document just inside the cap renders as it always did", () => {
    let node: Node = p(t("q"));
    for (let i = 0; i < ADF_MAX_DEPTH - 3; i += 1)
      node = { type: "blockquote", content: [node] };
    expect(adfToMarkdown(doc(node))).toBe(`${"> ".repeat(ADF_MAX_DEPTH - 3)}q`);
  });

  test("a cycle is walked once, never forever", () => {
    const loop: Node = { type: "layoutSection", content: [] };
    (loop.content as Node[]).push(loop, t("once"));
    let node: Node = loop;
    for (let i = 0; i < ADF_MAX_DEPTH; i += 1)
      node = { type: "panel", content: [node] };
    expect(adfToMarkdown(doc(node))).toBe("once");
  });
});
