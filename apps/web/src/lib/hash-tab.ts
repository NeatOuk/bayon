// A screen's tab in the URL: `?tab=<name>` on the hash, beside whatever else the hash's
// query holds. Pure, so the router (which strips it before matching), the hook in
// components/use-hash-tab.ts and their tests share one reading.

const TAB = "tab";

/** The hash's path and its query pairs, raw. */
function split(hash: string): {
  readonly path: string;
  readonly pairs: readonly string[];
} {
  const at = hash.indexOf("?");
  if (at < 0) return { path: hash, pairs: [] };
  const query = hash.slice(at + 1);
  return {
    path: hash.slice(0, at),
    pairs: query === "" ? [] : query.split("&"),
  };
}

const isTabPair = (pair: string): boolean => pair.startsWith(`${TAB}=`);

/**
 * The `tab` the hash names, decoded; null when it names none, names it twice, or its value is
 * malformed or empty.
 */
export function tabOf(hash: string): string | null {
  const named = split(hash).pairs.filter(isTabPair);
  const [pair] = named;
  if (pair === undefined || named.length > 1) return null;
  try {
    const value = decodeURIComponent(pair.slice(TAB.length + 1));
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/** The hash with its `tab` set to `tab` (last, after the other pairs), or taken out for null. */
export function withTab(hash: string, tab: string | null): string {
  const { path, pairs } = split(hash);
  const rest = pairs.filter((pair) => !isTabPair(pair));
  const next =
    tab === null ? rest : [...rest, `${TAB}=${encodeURIComponent(tab)}`];
  if (next.length === 0) return path;
  // An empty hash is the Fleet's `#/`: a query needs the `#`, or it would land in the URL's search.
  return `${path === "" ? "#/" : path}?${next.join("&")}`;
}
