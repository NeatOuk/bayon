import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { StopButton } from "@/session/stop-button";
import { sessionView } from "@/test/fixtures";
import {
  apiError,
  bodyOf,
  callsTo,
  renderWithProviders,
  stubFetch,
} from "@/test/render";

const STOP = "/api/v1/sessions/s1/stop";
const ACCEPTED = { command_id: "C-1", session_id: "s1", created: true };
const idle = sessionView({ id: "s1", state: "idle" });

test("graceful is the default action, and closes the dialog on success", async () => {
  const fetchMock = stubFetch({ [STOP]: ACCEPTED });
  const user = userEvent.setup();
  renderWithProviders(<StopButton session={idle} />);
  await user.click(screen.getByRole("button", { name: "Stop" }));
  await user.click(screen.getByRole("button", { name: "Stop (graceful)" }));
  await waitFor(() => expect(callsTo(fetchMock, STOP, "POST")).toHaveLength(1));
  expect(bodyOf(fetchMock, STOP, "POST")).toEqual({ mode: "graceful" });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  // The dialog closes on a toast saying what was asked, not silently.
  expect(
    await screen.findByRole("status", {
      name: "Stop requested: it finishes its turn first",
    }),
  ).toBeTruthy();
});

test("kill sends mode: kill", async () => {
  const fetchMock = stubFetch({ [STOP]: ACCEPTED });
  const user = userEvent.setup();
  renderWithProviders(<StopButton session={idle} />);
  await user.click(screen.getByRole("button", { name: "Stop" }));
  await user.click(screen.getByRole("button", { name: "Kill now" }));
  await waitFor(() => expect(callsTo(fetchMock, STOP, "POST")).toHaveLength(1));
  expect(bodyOf(fetchMock, STOP, "POST")).toEqual({ mode: "kill" });
});

test("a refused stop shows the server's error and keeps the dialog", async () => {
  stubFetch({
    [STOP]: () => apiError(409, "conflict", "the session already ended"),
  });
  const user = userEvent.setup();
  renderWithProviders(<StopButton session={idle} />);
  await user.click(screen.getByRole("button", { name: "Stop" }));
  await user.click(screen.getByRole("button", { name: "Stop (graceful)" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "the session already ended",
  );
  expect(screen.getByRole("alertdialog")).toBeTruthy();
});

test("a session that has already ended cannot be stopped", () => {
  for (const state of ["exited", "handed_off", "stopping"] as const) {
    const { unmount } = renderWithProviders(
      <StopButton session={{ ...idle, state }} />,
    );
    expect(
      (screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    unmount();
  }
});

// a suspended session is the one end an operator could not get out of, so it is offered
// the discard alone — graceful has nothing left to do there, and the server refuses it.
test("a suspended session is offered the discard, and only the discard", async () => {
  const fetchMock = stubFetch({ [STOP]: ACCEPTED });
  const user = userEvent.setup();
  const suspended = sessionView({ id: "s1", state: "resumable" });
  renderWithProviders(<StopButton session={suspended} />);

  const open = screen.getByRole("button", { name: "Discard" });
  expect((open as HTMLButtonElement).disabled).toBe(false);
  await user.click(open);
  expect(screen.queryByRole("button", { name: "Stop (graceful)" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Discard for good" }));
  await waitFor(() => expect(callsTo(fetchMock, STOP, "POST")).toHaveLength(1));
  expect(bodyOf(fetchMock, STOP, "POST")).toEqual({ mode: "kill" });
});
