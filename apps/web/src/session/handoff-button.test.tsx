import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { HandoffButton } from "@/session/handoff-button";
import { sessionView } from "@/test/fixtures";
import {
  apiError,
  bodyOf,
  callsTo,
  renderWithProviders,
  stubFetch,
} from "@/test/render";

const HANDOFF = "/api/v1/sessions/s1/handoff";
const ACCEPTED = { command_id: "C-1", session_id: "s1", created: true };
const running = sessionView({
  id: "s1",
  state: "running",
  ticket_id: "ticket-812",
});

test("a running session hands off with the operator reason and the note", async () => {
  const fetchMock = stubFetch({ [HANDOFF]: ACCEPTED });
  const user = userEvent.setup();
  renderWithProviders(<HandoffButton session={running} />);
  await user.click(screen.getByRole("button", { name: "Hand off" }));
  await user.type(
    screen.getByLabelText("Note (optional)"),
    "  context is noisy  ",
  );
  await user.click(screen.getByRole("button", { name: "Hand off now" }));
  await waitFor(() =>
    expect(callsTo(fetchMock, HANDOFF, "POST")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, HANDOFF, "POST")).toEqual({
    reason: "operator",
    note: "context is noisy",
  });
  expect(
    await screen.findByRole("status", { name: "Hand-off requested" }),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("without a note the body is the reason alone", async () => {
  const fetchMock = stubFetch({ [HANDOFF]: ACCEPTED });
  const user = userEvent.setup();
  renderWithProviders(<HandoffButton session={running} />);
  await user.click(screen.getByRole("button", { name: "Hand off" }));
  await user.click(screen.getByRole("button", { name: "Hand off now" }));
  await waitFor(() =>
    expect(callsTo(fetchMock, HANDOFF, "POST")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, HANDOFF, "POST")).toEqual({ reason: "operator" });
});

test("a refused hand-off shows the server's error and keeps the dialog", async () => {
  stubFetch({
    [HANDOFF]: () => apiError(409, "conflict", "the session is not running"),
  });
  const user = userEvent.setup();
  renderWithProviders(<HandoffButton session={running} />);
  await user.click(screen.getByRole("button", { name: "Hand off" }));
  await user.click(screen.getByRole("button", { name: "Hand off now" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "the session is not running",
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("a session that is not running, or holds no ticket, cannot be handed off", () => {
  const { unmount } = renderWithProviders(
    <HandoffButton session={{ ...running, state: "idle" }} />,
  );
  expect(
    (screen.getByRole("button", { name: "Hand off" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  unmount();
  renderWithProviders(
    <HandoffButton session={{ ...running, ticket_id: null }} />,
  );
  expect(
    (screen.getByRole("button", { name: "Hand off" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
