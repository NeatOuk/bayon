import type { QueryClient } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, test, vi } from "vitest";
import { retryUnlessFinal } from "@/api/query-client";

const feeds: { close: ReturnType<typeof vi.fn> }[] = [];
vi.mock("@/feed/feed", () => ({
  createBrowserFeed: vi.fn(() => {
    const feed = { close: vi.fn() };
    feeds.push(feed);
    return feed;
  }),
}));

let lastFeed: unknown;
let lastQueryClient: QueryClient | undefined;
vi.mock("@/app", () => ({
  App: (props: {
    readonly feed: unknown;
    readonly queryClient: QueryClient;
  }) => {
    lastFeed = props.feed;
    lastQueryClient = props.queryClient;
    return null;
  },
}));

const { Shell } = await import("@/shell");

test("StrictMode's double-invoked effect leaves App with a feed that was never closed", () => {
  act(() => {
    render(
      <StrictMode>
        <Shell onLogout={null} />
      </StrictMode>,
    );
  });
  // Sanity check that this test environment actually exercises the double-invoke this bug depends on.
  expect(feeds.length).toBeGreaterThan(1);
  const used = lastFeed as { close: ReturnType<typeof vi.fn> };
  expect(used.close).not.toHaveBeenCalled();
});

// TanStack's default retries a failure the server calls final three times, and a hidden
// tab pauses the retry: the ticket screen said "loading" for good over a body the schema rejected.
test("the app's QueryClient does not retry a failure the server calls final", () => {
  act(() => {
    render(<Shell onLogout={null} />);
  });
  expect(lastQueryClient?.getDefaultOptions().queries?.retry).toBe(
    retryUnlessFinal,
  );
});
