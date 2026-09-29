import { useCallback, useState } from "react";
import { tabOf, withTab } from "@/lib/hash-tab";
import { replaceHash } from "@/lib/history";
import { parseRoute, useHash } from "@/routing";

// A screen's tabs, kept in the URL's `?tab=` so a reload, a shared link or a back link
// opens the same tab. The router takes the pair off before matching, for the screens with tabs of
// their own (routing.ts). A switch rewrites this entry's address in place (lib/history's
// replaceHash): no navigation, no history entry, and the back-link trail keeps the new address.
//
// The URL's tab wins while it names one of this screen's; otherwise the last one chosen here stands
// — so an IDE view kept mounted under an editor tab (whose own `tab` it cannot read) keeps its tab.

/**
 * Whether the router shows the same screen for `to` as for `from`, a `tab` aside: never when `to`
 * is Not found (a screen whose address takes no tab).
 */
export function sameScreen(from: string, to: string): boolean {
  if (parseRoute(to).name === "notFound") return false;
  return (
    JSON.stringify(parseRoute(withTab(from, null))) ===
    JSON.stringify(parseRoute(withTab(to, null)))
  );
}

export function useHashTab<T extends string>(
  tabs: readonly T[],
  fallback: T,
  keeps: (from: string, to: string) => boolean = sameScreen,
): readonly [T, (next: T) => void] {
  const hash = useHash();
  const named = tabs.find((tab) => tab === tabOf(hash)) ?? null;
  const [chosen, setChosen] = useState<T>(named ?? fallback);
  // The address moved to another of this screen's tabs (a link, back, forward): follow it.
  if (named !== null && named !== chosen) setChosen(named);

  const choose = useCallback(
    (next: T) => {
      setChosen(next);
      const from = window.location.hash;
      const to = withTab(from, next === fallback ? null : next);
      if (to !== from && keeps(from, to)) replaceHash(to);
    },
    [fallback, keeps],
  );
  return [named ?? chosen, choose] as const;
}
