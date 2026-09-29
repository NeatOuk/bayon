import type { SessionView } from "@bayon/proto";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test } from "vitest";
import type { Feed } from "@/feed/feed";
import { SessionScreen } from "@/session/session-screen";
import { readLeaseToken } from "@/session/pty-lease-storage";
import { missionView, sessionView, text } from "@/test/fixtures";
import { missionUrl, navigate, renderIde } from "@/test/ide-harness";
import { projectView } from "@/test/project-fixtures";
import { watchReactWarnings } from "@/test/console-errors";
import { renderWithProviders, silentFeed, stubFetch } from "@/test/render";

// The session screen's Watch tab and its lease token.
const SESSION = "/api/v1/sessions/s1";

afterEach(() => sessionStorage.clear());

const at = (view: SessionView) => stubFetch({ [SESSION]: view });

/** The whole app, for the address and the back links (as app-shell/back-link.test.tsx renders it). */
const BAYON = projectView();
const AGENT = "bayon-builder";
const ROUTES = {
  [SESSION]: sessionView({ id: "s1", state: "idle", agent_name: AGENT }),
  [missionUrl(AGENT)]: missionView([], AGENT),
};

test("Watch is a tab beside the Timeline: the same session, as a read-only terminal", async () => {
  const feed: Feed = {
    ...silentFeed,
    subscribeEvents: (_sessionId, on) => {
      on([text(1, "hello")], 1);
      return () => undefined;
    },
  };
  at(sessionView({ id: "s1", state: "running" }));
  const user = userEvent.setup();
  renderWithProviders(<SessionScreen sessionId="s1" backHref={null} />, {
    feed,
  });
  expect(await screen.findByText("hello")).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: "Watch" }));
  expect(await screen.findByLabelText("watch s1")).toBeTruthy();
  expect(screen.getByText(/typing here sends nothing/)).toBeTruthy();
});

test("this tab keeps its lease token while a takeover is pending — even through the idle between the run's end and the attach", async () => {
  sessionStorage.setItem("pty-lease:s1", "tab-token");
  const pending = {
    attach_intent_owner: "tab-token",
    attach_intent_at: 1_800_000_000_000,
  };
  at(sessionView({ id: "s1", state: "idle", ...pending }));
  renderWithProviders(<SessionScreen sessionId="s1" backHref={null} />);
  expect(await screen.findByRole("status")).toBeTruthy();
  // The clearing effect runs after the render that showed the row: let it, then look.
  await act(async () => undefined);
  expect(readLeaseToken("s1")).toBe("tab-token");
});

test("with nothing pending and nothing attached, a stale lease token is cleared, as before", async () => {
  sessionStorage.setItem("pty-lease:s1", "stale-token");
  at(sessionView({ id: "s1", state: "idle" }));
  renderWithProviders(<SessionScreen sessionId="s1" backHref={null} />);
  await waitFor(() => expect(readLeaseToken("s1")).toBeNull());
});

// the header names the session's agent, its id copyable.
test("the header names the agent, with the id to copy", async () => {
  at(sessionView({ id: "s1", state: "running", agent_name: "shop-builder" }));
  renderWithProviders(<SessionScreen sessionId="s1" backHref={null} />);
  expect(
    await screen.findByRole("heading", {
      level: 1,
      name: "Session · shop-builder",
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Copy the session id" }),
  ).toBeTruthy();
});

// the open tab is the address's `?tab=`, both ways, rewritten in place.
describe("the session's tab and ?tab=", () => {
  afterEach(() => {
    window.location.hash = "";
  });

  const tab = (name: string) => screen.getByRole("tab", { name });
  const selected = (name: string) => tab(name).getAttribute("aria-selected");

  test("?tab= opens its tab; a switch rewrites it in place, the default clears it, no history entry", async () => {
    renderIde("#/sessions/s1?tab=watch", BAYON, ROUTES);
    await screen.findByRole("heading", { name: /^Session/ });
    expect(selected("Watch")).toBe("true");
    const entries = window.history.length;
    const user = userEvent.setup();
    await user.click(tab("Diff"));
    expect(selected("Diff")).toBe("true");
    expect(window.location.hash).toBe("#/sessions/s1?tab=diff");
    await user.click(tab("Timeline"));
    expect(window.location.hash).toBe("#/sessions/s1");
    expect(window.history.length).toBe(entries);
    // A navigation that names a tab (back, forward, a link) opens it.
    navigate("#/sessions/s1?tab=terminal");
    await waitFor(() => expect(selected("Terminal")).toBe("true"));
  });

  test("switching tabs, the timeline among them, logs no React scheduling warning", async () => {
    renderIde("#/sessions/s1", BAYON, ROUTES);
    await screen.findByRole("heading", { name: /^Session/ });
    const warnings = watchReactWarnings();
    const user = userEvent.setup();
    for (const name of ["Diff", "Watch", "Timeline", "Diff", "Timeline"])
      await user.click(tab(name));
    // What a switch leaves for after it (the timeline's scroll event) has run.
    await act(async () => undefined);
    expect(warnings()).toEqual([]);
  });

  test("a back link from the next screen names the session at the tab it was left on", async () => {
    renderIde("#/tickets", BAYON, ROUTES);
    navigate("#/sessions/s1");
    await screen.findByRole("heading", { name: /^Session/ });
    await userEvent.setup().click(tab("Diff"));
    expect(window.location.hash).toBe("#/sessions/s1?tab=diff");
    // The session's own way back is unchanged by its tab.
    expect(screen.getByRole("link", { name: /^← / }).getAttribute("href")).toBe(
      "#/tickets",
    );
    navigate(`#/missions/${AGENT}`);
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: /^← / }).getAttribute("href"),
      ).toBe("#/sessions/s1?tab=diff"),
    );
    expect(screen.getByRole("link", { name: /^← / }).textContent).toBe(
      "← Session",
    );
  });
});

// a compressed session says what context compression saved, and warns when it failed open.
describe("context compression", () => {
  const compressed = (o: Partial<SessionView> = {}) =>
    sessionView({
      id: "s1",
      state: "idle",
      context_ruleset: "ctx1",
      tokens_saved: 18_000,
      context: {
        ruleset: "ctx1",
        runs: 2,
        calls: 4,
        blocks: 6,
        compressed: 4,
        failed: 0,
        chars_in: 80_000,
        chars_out: 8_000,
      },
      ...o,
    });

  test("the saving and its share of the large tool output, and no warning when nothing failed", async () => {
    at(compressed());
    renderWithProviders(<SessionScreen sessionId="s1" backHref={null} />);
    expect(
      await screen.findByText("context saved ≈ 18,000 tokens (90 %)"),
    ).toBeTruthy();
    expect(screen.queryByText("Context compression failed open")).toBeNull();
  });

  test("a block that failed open is a warning, naming how many", async () => {
    const base = compressed();
    at(
      compressed({
        context: base.context === null ? null : { ...base.context, failed: 2 },
      }),
    );
    renderWithProviders(<SessionScreen sessionId="s1" backHref={null} />);
    expect(
      await screen.findByText("Context compression failed open"),
    ).toBeTruthy();
    expect(
      screen.getByText(/2 large tool results were sent to the model whole/),
    ).toBeTruthy();
  });

  test("compressed but nothing reported yet; and a session not compressed says nothing of it", async () => {
    at(compressed({ tokens_saved: null, context: null }));
    renderWithProviders(<SessionScreen sessionId="s1" backHref={null} />);
    expect(await screen.findByText("context compression on")).toBeTruthy();
  });

  test("not compressed: no line", async () => {
    at(sessionView({ id: "s1", state: "idle" }));
    renderWithProviders(<SessionScreen sessionId="s1" backHref={null} />);
    expect(await screen.findByText("build")).toBeTruthy();
    expect(screen.queryByText(/context/)).toBeNull();
  });
});
