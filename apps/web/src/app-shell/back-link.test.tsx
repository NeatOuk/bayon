import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { agentHome } from "@/app-shell/back-link";
import { watchReactWarnings } from "@/test/console-errors";
import { missionView, sessionView } from "@/test/fixtures";
import { missionUrl, navigate, renderIde } from "@/test/ide-harness";
import { projectView } from "@/test/project-fixtures";

// Real back links: the session and mission screens go back to where the operator came
// from; arriving from outside the app, to a sensible parent.

const BAYON = projectView();
const ROUTES = {
  "/api/v1/sessions/s1": sessionView({ id: "s1", state: "idle" }),
  [missionUrl("bayon-builder")]: missionView([], "bayon-builder"),
};

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = "";
});

const back = () => screen.getByRole("link", { name: /^← / });

test("arriving from outside, a session's way back is its parent, the Fleet, as a plain link", async () => {
  renderIde("#/sessions/s1", BAYON, ROUTES);
  await screen.findByRole("heading", { name: "Session" });
  expect(back().textContent).toBe("← Fleet");
  expect(back().getAttribute("href")).toBe("#/");
  const history = vi.spyOn(window.history, "back");
  await userEvent.setup().click(back());
  expect(history).not.toHaveBeenCalled();
  await waitFor(() => expect(window.location.hash).toBe("#/"));
});

test("arriving from a screen of the app, it names that screen and goes back in history", async () => {
  renderIde("#/tickets", BAYON, ROUTES);
  navigate("#/sessions/s1");
  await screen.findByRole("heading", { name: "Session" });
  expect(back().textContent).toBe("← Tickets");
  expect(back().getAttribute("href")).toBe("#/tickets");
  const history = vi.spyOn(window.history, "back").mockImplementation(() => {});
  // A modified click is the browser's (a new tab), not a step back. (The test stops the browser's
  // own follow-through, which jsdom would run in the current tab, later.)
  const stop = (event: Event) => event.preventDefault();
  window.addEventListener("click", stop);
  fireEvent.click(back(), { metaKey: true });
  window.removeEventListener("click", stop);
  expect(history).not.toHaveBeenCalled();
  fireEvent.click(back());
  expect(history).toHaveBeenCalledOnce();
});

test("after going back, the way back is the entry before this one, not the page just left", async () => {
  const warnings = watchReactWarnings();
  renderIde("#/tickets", BAYON, ROUTES);
  navigate("#/sessions/s1");
  const session: unknown = window.history.state;
  navigate("#/runners");
  // Back to the session, as the browser does it: that entry's address and its state come back.
  act(() => {
    window.history.replaceState(session, "", "#/sessions/s1");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await screen.findByRole("heading", { name: /^Session/ });
  expect(back().textContent).toBe("← Tickets");
  expect(back().getAttribute("href")).toBe("#/tickets");
  // Arriving back (the trail notified from the native hashchange) schedules nothing React refuses.
  await act(async () => undefined);
  expect(warnings()).toEqual([]);
});

test("a mission's parent is its agent's tab in its project, or the Fleet for an unknown agent", async () => {
  renderIde("#/missions/bayon-builder", BAYON, ROUTES);
  await waitFor(() =>
    expect(back().getAttribute("href")).toBe(
      "#/p/ws-bayon/agents?open=agent:bayon-builder",
    ),
  );
  expect(back().textContent).toBe("← Agents");
  expect(agentHome([BAYON], "someone-else")).toBe("#/");
});
