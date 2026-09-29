// A documentation page's body as Markdown. Pure, and loose in the same way `adf.ts` is:
// every input arrives from outside, nothing here throws, and a body it cannot read is "" rather
// than an error — a page with no readable body is a page that says nothing, not a failure.
//
// Confluence hands `atlas_doc_format` back as a JSON **string**, not as an object: the value has to
// be parsed before `adfToMarkdown` sees it, or the whole document would be read as one line of
// plain text (adf.ts's REST v2 path). That one step is the reason this file exists.
import { adfToMarkdown } from "../jira/adf.js";

/** A JSON value, or undefined when `text` is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * An `atlas_doc_format` body as Markdown: the ADF document, or the JSON string of one, which is
 * parsed first. A string that is not JSON is its own text (`adfToMarkdown`'s plain-text path).
 */
export function adfBodyToMarkdown(value: unknown): string {
  if (typeof value !== "string") return adfToMarkdown(value);
  const parsed = parseJson(value);
  return adfToMarkdown(parsed === undefined ? value : parsed);
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** `&amp;`, `&#38;` and `&#x26;`; anything else is left as it was written. */
const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    const named = ENTITIES[body.toLowerCase()];
    if (named !== undefined) return named;
    const code = body.startsWith("#x")
      ? Number.parseInt(body.slice(2), 16)
      : body.startsWith("#")
        ? Number(body.slice(1))
        : Number.NaN;
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole;
  });

/** Tags that end a line of text rather than joining it. */
const BLOCK_TAG =
  /<\/?(?:p|div|br|hr|li|ul|ol|tr|td|th|table|h[1-6]|pre|blockquote)\b[^>]*>/gi;

/**
 * A `storage` body (Confluence's XHTML) as plain text: the fallback for a page with no ADF. Tags
 * are dropped rather than rendered — Markdown from XHTML is a converter of its own, and what a
 * reader needs from a fallback is the words.
 */
export function storageToText(value: unknown): string {
  if (typeof value !== "string") return "";
  return decodeEntities(
    value
      // A script or style body is markup, not words.
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(BLOCK_TAG, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface PageBody {
  /** The `atlas_doc_format` value: a document, or the JSON string of one. */
  readonly adf?: unknown;
  /** The `storage` value: XHTML, used when there is no ADF. */
  readonly storage?: unknown;
}

/** A page's Markdown: its ADF when it has one, else its storage text, else "". */
export function pageMarkdown(body: PageBody): string {
  const adf = adfBodyToMarkdown(body.adf);
  return adf === "" ? storageToText(body.storage) : adf;
}

/** The marker a trimmed page ends with: an agent is told the text was cut, not left guessing. */
export const PAGE_TRIMMED = "\n\n… the rest of this page was not read …";

/** `markdown` cut to `max` characters, with `PAGE_TRIMMED` when it was cut. */
export const trimPage = (markdown: string, max: number): string =>
  markdown.length <= max
    ? markdown
    : `${markdown.slice(0, max).trimEnd()}${PAGE_TRIMMED}`;
