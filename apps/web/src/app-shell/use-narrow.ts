import { useSyncExternalStore } from "react";

// Below Tailwind's `lg` (64rem, 1024px) the sidebar is a sheet behind a menu button.
// Decided here rather than in CSS so exactly one navigation is in the page. The query asks "narrow?",
// so a browser without matchMedia, or a test environment that matches nothing, gets the desktop
// layout.

export const NARROW_QUERY = "(width < 64rem)";

const query = (): MediaQueryList | null =>
  typeof window.matchMedia === "function"
    ? window.matchMedia(NARROW_QUERY)
    : null;

const subscribe = (onChange: () => void) => {
  const list = query();
  list?.addEventListener("change", onChange);
  return () => list?.removeEventListener("change", onChange);
};

/** Whether the window is narrower than `lg`, live. */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, () => query()?.matches ?? false);
}
