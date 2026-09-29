import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { sameScreen, useHashTab } from "@/components/use-hash-tab";

const TABS = ["timeline", "watch", "diff"] as const;

afterEach(() => {
  window.history.replaceState(null, "", "#");
});

test("a chosen tab is written to ?tab= in place: no navigation, no history entry; the default clears it", () => {
  window.location.hash = "#/sessions/s1";
  const { result } = renderHook(() => useHashTab(TABS, "timeline"));
  expect(result.current[0]).toBe("timeline");
  let fired = 0;
  const count = () => {
    fired += 1;
  };
  window.addEventListener("hashchange", count);
  const entries = window.history.length;
  act(() => result.current[1]("diff"));
  expect(result.current[0]).toBe("diff");
  expect(window.location.hash).toBe("#/sessions/s1?tab=diff");
  act(() => result.current[1]("timeline"));
  expect(window.location.hash).toBe("#/sessions/s1");
  window.removeEventListener("hashchange", count);
  // replaceState: no hashchange, so the router does not re-render the screen as a navigation.
  expect(fired).toBe(0);
  expect(window.history.length).toBe(entries);
});

test("?tab= in the hash opens that tab; an unknown one falls back to the default", () => {
  window.history.replaceState(null, "", "#/sessions/s1?tab=watch");
  const opened = renderHook(() => useHashTab(TABS, "timeline"));
  expect(opened.result.current[0]).toBe("watch");
  window.history.replaceState(null, "", "#/sessions/s1?tab=nope");
  const unknown = renderHook(() => useHashTab(TABS, "timeline"));
  expect(unknown.result.current[0]).toBe("timeline");
});

test("a hash change naming another tab moves to it", () => {
  window.location.hash = "#/sessions/s1";
  const { result } = renderHook(() => useHashTab(TABS, "timeline"));
  act(() => {
    window.history.replaceState(null, "", "#/sessions/s1?tab=diff");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(result.current[0]).toBe("diff");
});

test("on a screen whose address takes no tab, the tab lives here alone and the URL is left as it is", () => {
  window.location.hash = "#/tickets/7";
  const { result } = renderHook(() => useHashTab(TABS, "timeline"));
  act(() => result.current[1]("diff"));
  expect(result.current[0]).toBe("diff");
  expect(window.location.hash).toBe("#/tickets/7");
});

test("a tab chosen here stands while the address names none of this screen's (an IDE view under an editor tab)", () => {
  window.location.hash = "#/p/shop/inbox";
  const { result } = renderHook(() => useHashTab(TABS, "timeline"));
  act(() => result.current[1]("watch"));
  expect(window.location.hash).toBe("#/p/shop/inbox?tab=watch");
  act(() => {
    window.history.replaceState(null, "", "#/p/shop/inbox?open=ticket:7");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(result.current[0]).toBe("watch");
});

test("sameScreen compares what the router shows, a tab aside", () => {
  expect(sameScreen("#/sessions/s1", "#/sessions/s1?tab=diff")).toBe(true);
  expect(sameScreen("#/inbox?ticket=8", "#/inbox?ticket=8&tab=answered")).toBe(
    true,
  );
  expect(sameScreen("#/tickets/7", "#/tickets/7")).toBe(true);
  expect(sameScreen("#/tickets/7", "#/tickets/8")).toBe(false);
  // A screen whose address takes no tab: the tab would make it Not found.
  expect(sameScreen("#/tickets/7", "#/tickets/7?tab=a")).toBe(false);
  expect(sameScreen("", "#/?tab=answered")).toBe(false);
});
