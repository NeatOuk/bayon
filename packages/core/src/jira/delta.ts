// The Jira mirror's quick pass: between two full syncs, only the issues the project's
// query matches that changed within a window are read. Pure: the query and the window's length.
//
// JQL allows ORDER BY only at the end of a query, so the project's own clause is cut off and put
// back after the added condition. `order` and `by` are JQL reserved words, so unquoted and outside
// parentheses they can only be that clause; inside a quoted string (with its backslash escapes) or
// a parenthesis they are left alone.

/** A window is never shorter than this, in minutes. */
export const JIRA_DELTA_MIN_WINDOW_MIN = 2;
/** Added to the time since the last pass, for a request in flight across the boundary. */
export const JIRA_DELTA_MARGIN_MIN = 1;

const MINUTE_MS = 60_000;
const ORDER_BY = /^order\s+by\b/i;
const WORD = /\w/;

/** Whether `jql[i]` starts a word: the first character, or one after a non-word character. */
const startsWord = (jql: string, i: number): boolean =>
  i === 0 || !WORD.test(jql.charAt(i - 1));

/** Where the query's own ORDER BY starts, outside strings and parentheses; -1 when it has none. */
function orderByAt(jql: string): number {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < jql.length; i += 1) {
    const c = jql.charAt(i);
    if (quote !== null) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (depth === 0 && startsWord(jql, i) && ORDER_BY.test(jql.slice(i)))
      return i;
  }
  return -1;
}

/**
 * `jql` narrowed to the issues updated in the last `minutes` (a whole number, Jira's relative date,
 * evaluated on Jira's own clock): `(<jql>) AND updated >= "-<minutes>m"`, any ORDER BY after it.
 */
export function deltaJql(jql: string, minutes: number): string {
  const at = orderByAt(jql);
  const where = (at === -1 ? jql : jql.slice(0, at)).trim();
  const order = at === -1 ? "" : ` ${jql.slice(at).trim()}`;
  const since = `updated >= "-${minutes}m"`;
  return `${where === "" ? since : `(${where}) AND ${since}`}${order}`;
}

/**
 * How many minutes a quick pass looks back: the time since the previous pass of either kind began,
 * rounded up, plus the margin; never under the minimum. On schedule that is the quick interval plus
 * a minute (2 at the default of one); a tick that ran late or long widens it by as much.
 */
export const deltaWindowMinutes = (elapsedMs: number): number =>
  Math.max(
    JIRA_DELTA_MIN_WINDOW_MIN,
    Math.ceil(elapsedMs / MINUTE_MS) + JIRA_DELTA_MARGIN_MIN,
  );
