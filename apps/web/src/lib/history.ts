// The tab's history as the app keeps it (back links; moved here by an earlier change so the
// address can be rewritten in place without the trail going stale). Each history entry this app
// makes is stamped with its place in the tab's history (`history.state.bayonIndex`), and the address
// seen at each place is remembered, so the entry before this one is known exactly — after a back or
// a forward too, where a hashchange's `oldURL` would name the page just left instead.
//
// An address rewritten in place (an alias made canonical, a screen's `?tab=`) goes through
// `replaceHash`: history.replaceState fires no hashchange, so the trail and every reader of the
// address are told here instead.

interface Stamped {
  readonly bayonIndex?: unknown;
}

/** The address seen at each stamped place; the place the tab is at; the address before it. */
const trail = new Map<number, string>();
let current: number | null = null;
let previous: string | null = null;
const listeners = new Set<() => void>();

const notify = (): void => listeners.forEach((listener) => listener());

/**
 * On every arrival: an unstamped entry is new, one past the entry it was reached from, and the
 * entries that were ahead of that one are gone from the browser's history too.
 */
export function stamp(): void {
  const raw: unknown = window.history.state;
  const state: Stamped =
    typeof raw === "object" && raw !== null ? (raw as Stamped) : {};
  const known = typeof state.bayonIndex === "number" ? state.bayonIndex : null;
  const index = known ?? (current === null ? 0 : current + 1);
  if (known === null) {
    window.history.replaceState({ ...state, bayonIndex: index }, "");
    for (const place of [...trail.keys()])
      if (place > index) trail.delete(place);
  }
  current = index;
  trail.set(index, window.location.hash);
  previous = trail.get(index - 1) ?? null;
  notify();
}

/** Starts keeping the trail; the returned function stops and forgets it. */
export function startTrail(): () => void {
  stamp();
  window.addEventListener("hashchange", stamp);
  return () => {
    window.removeEventListener("hashchange", stamp);
    trail.clear();
    current = null;
    previous = null;
  };
}

/**
 * Rewrites this entry's address to `to`, in place: no history entry is added and no hashchange
 * fires, but the trail remembers the new address for this place (so a later back link names it,
 * `?tab=` and all) and every subscriber hears of it.
 */
export function replaceHash(to: string): void {
  window.history.replaceState(window.history.state, "", to);
  if (current !== null) trail.set(current, window.location.hash);
  notify();
}

/** Called on every stamp and every in-place rewrite. */
export function subscribeHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The address of the in-app entry before this one, or null when it is not known to be ours. */
export const previousHash = (): string | null => previous;
