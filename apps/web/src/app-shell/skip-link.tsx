import type { RefObject } from "react";

/**
 * "Skip to content": the page's first stop for the keyboard, visible only while it has
 * focus, moving focus past the sidebar's links to the screen. A button, not an `#anchor`: the hash
 * is the router's.
 */
export function SkipLink({
  target,
}: {
  readonly target: RefObject<HTMLElement | null>;
}) {
  return (
    <button
      type="button"
      className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-popover focus-visible:px-3 focus-visible:py-2 focus-visible:text-sm focus-visible:shadow-lg focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
      onClick={() => target.current?.focus()}
    >
      Skip to content
    </button>
  );
}
