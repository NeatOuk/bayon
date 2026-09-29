// CQL, built rather than concatenated. An agent's `query` is text it chose, and it ends
// up inside a query language with its own operators — the same shape of hole as SQL injection, and
// the same fix: the text is escaped once, at the one place that builds the query, and every
// structural part of the query is ours.
//
// Pure. No site, space or page name appears here.

/**
 * The characters CQL gives a meaning to inside a quoted term: the quote and the backslash that
 * carry the string itself, and Lucene's operators, which a `~` match reads. Each is escaped with a
 * backslash — one pass, so a backslash is escaped once and not again as part of what follows it.
 */
const CQL_SPECIAL = /[\\"+\-&|!(){}[\]^~*?:]/g;

/** `text` with every character CQL reads as syntax escaped: the term, without its quotes. */
export const cqlEscape = (text: string): string =>
  text.replace(CQL_SPECIAL, (c) => `\\${c}`);

/** `text` as a CQL string literal: escaped, and quoted. */
export const cqlText = (text: string): string => `"${cqlEscape(text)}"`;

/** `space in ("A","B")`, or `space = "A"` for one; the empty list has no constraint. */
function spaceClause(spaces: readonly string[]): string | null {
  const [only, ...rest] = spaces;
  if (only === undefined) return null;
  return rest.length === 0
    ? `space = ${cqlText(only)}`
    : `space in (${spaces.map(cqlText).join(",")})`;
}

export interface DocsSearchCql {
  /** The agent's words; escaped, never concatenated. */
  readonly query: string;
  /** The spaces the project allows; empty means every space the account can read. */
  readonly allowed: readonly string[];
  /** One space the caller asked for; it must already be one of `allowed`. */
  readonly space?: string | undefined;
}

/**
 * The CQL one search sends: pages only, matching `query` as text, inside the spaces the project
 * allows — narrowed to `space` when the caller named one. The space clause is built from the
 * project's own list, so a search cannot reach outside it however the query is written.
 */
export function docsSearchCql(o: DocsSearchCql): string {
  const spaces = o.space === undefined ? o.allowed : [o.space];
  const inSpaces = spaceClause(spaces);
  const clauses = [
    "type = page",
    `text ~ ${cqlText(o.query)}`,
    ...(inSpaces === null ? [] : [inSpaces]),
  ];
  return `${clauses.join(" AND ")} order by lastmodified desc`;
}
