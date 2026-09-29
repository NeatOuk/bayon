import type { FeedStatus } from "@bayon/proto";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeedIndicator } from "@/feed/feed-indicator";
import { renderWithProviders, silentFeed } from "@/test/render";
import { TimelineView } from "@/timeline/timeline";

// a dead socket used to render as an empty list, identical to a session that had done
// nothing. Both halves of the fix are checked here: the header says so, and the list says so.

const feedAt = (status: FeedStatus) => ({ ...silentFeed, status });
const statusText = () => screen.getByRole("status").textContent ?? "";

test("the header stays quiet while the feed delivers", () => {
  renderWithProviders(<FeedIndicator />, { feed: feedAt("open") });
  expect(screen.queryByRole("status")).toBeNull();
});

test("a feed that is not delivering is named in the header", () => {
  renderWithProviders(<FeedIndicator />, { feed: feedAt("reconnecting") });
  expect(statusText()).toContain("Feed disconnected");
  expect(screen.getByText("Feed disconnected").dataset.tone).toBe("danger");
});

test("a first connection says so rather than claiming to be dead", () => {
  renderWithProviders(<FeedIndicator />, { feed: feedAt("connecting") });
  expect(statusText()).toContain("Feed connecting…");
  expect(screen.getByText("Feed connecting…").dataset.tone).toBe("warning");
});

test("an empty timeline tells no events apart from no connection", () => {
  const live = renderWithProviders(<TimelineView sessionId="s1" items={[]} />);
  expect(statusText()).toContain("No events yet");
  live.unmount();

  renderWithProviders(
    <TimelineView sessionId="s1" items={[]} status="reconnecting" />,
  );
  expect(statusText()).toContain("not up to date");
});
