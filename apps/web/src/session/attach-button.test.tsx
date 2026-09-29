import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test } from "vitest";
import { AttachButton } from "@/session/attach-button";
import { readLeaseToken } from "@/session/pty-lease-storage";
import { sessionView } from "@/test/fixtures";
import {
  apiError,
  bodyOf,
  callsTo,
  renderWithProviders,
  stubFetch,
} from "@/test/render";

const ATTACH = "/api/v1/sessions/s1/attach";
const ACCEPTED = { command_id: "C-1", session_id: "s1", created: true };
const idle = sessionView({ id: "s1", state: "idle", executor_id: "local" });
const running = sessionView({
  id: "s1",
  state: "running",
  executor_id: "local",
});

afterEach(() => sessionStorage.clear());

interface AttachBody {
  readonly client_token: string;
  readonly when: string;
}

test("attach is a plain action on an idle session: no dialog, mints and sends a client token, persists it", async () => {
  const fetchMock = stubFetch({ [ATTACH]: ACCEPTED });
  const user = userEvent.setup();
  renderWithProviders(<AttachButton session={idle} />);
  await user.click(screen.getByRole("button", { name: "Attach" }));
  await waitFor(() =>
    expect(callsTo(fetchMock, ATTACH, "POST")).toHaveLength(1),
  );
  const sent = bodyOf(fetchMock, ATTACH, "POST") as AttachBody;
  expect(typeof sent.client_token).toBe("string");
  expect(sent.client_token.length).toBeGreaterThan(0);
  // Idle has no turn to interrupt; turn_end takes it at once, and waits should a run start first.
  expect(sent.when).toBe("turn_end");
  // Persisted before the request went out, so a reload before the response even lands still works.
  expect(readLeaseToken("s1")).toBe(sent.client_token);
});

test("attach is disabled off the local executor, or when the session can't be attached", () => {
  const { unmount } = renderWithProviders(
    <AttachButton session={{ ...idle, executor_id: "ctr-lab" }} />,
  );
  expect(
    (screen.getByRole("button", { name: "Attach" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  unmount();

  for (const state of ["exited", "resumable", "handed_off"] as const) {
    const rendered = renderWithProviders(
      <AttachButton session={{ ...idle, state }} />,
    );
    expect(
      (screen.getByRole("button", { name: "Attach" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    rendered.unmount();
  }
});

test("a refused attach shows the server's error", async () => {
  stubFetch({
    [ATTACH]: () => apiError(409, "conflict", "already held"),
  });
  const user = userEvent.setup();
  renderWithProviders(<AttachButton session={idle} />);
  await user.click(screen.getByRole("button", { name: "Attach" }));
  expect((await screen.findByRole("alert")).textContent).toBe("already held");
});

test("detach shows a confirm dialog before sending the command, and clears the persisted token", async () => {
  sessionStorage.setItem("pty-lease:s1", "some-token");
  const attached = sessionView({ id: "s1", state: "human_attached" });
  const fetchMock = stubFetch({ [ATTACH]: ACCEPTED });
  const user = userEvent.setup();
  renderWithProviders(<AttachButton session={attached} />);
  await user.click(screen.getByRole("button", { name: "Detach" }));
  const dialog = screen.getByRole("alertdialog");
  expect(callsTo(fetchMock, ATTACH, "DELETE")).toHaveLength(0);
  // Both the trigger and the dialog's confirm button say "Detach": scope to the dialog for it.
  await user.click(within(dialog).getByRole("button", { name: "Detach" }));
  await waitFor(() =>
    expect(callsTo(fetchMock, ATTACH, "DELETE")).toHaveLength(1),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(readLeaseToken("s1")).toBeNull();
});

describe("mid-turn: take over after this step, or now", () => {
  test("a running session offers both; after this step is the plain action, sent as turn_end with no dialog", async () => {
    const fetchMock = stubFetch({ [ATTACH]: ACCEPTED });
    const user = userEvent.setup();
    renderWithProviders(<AttachButton session={running} />);
    expect(screen.queryByRole("button", { name: "Attach" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Take over now (interrupts)" }),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Take over after this step" }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() =>
      expect(callsTo(fetchMock, ATTACH, "POST")).toHaveLength(1),
    );
    const sent = bodyOf(fetchMock, ATTACH, "POST") as AttachBody;
    expect(sent.when).toBe("turn_end");
    expect(readLeaseToken("s1")).toBe(sent.client_token);
    // Accepted, not yet claimed: the pending state stands in until the row says so.
    expect((await screen.findByRole("status")).textContent).toBe(
      "taking over after this step…",
    );
    expect(
      screen.queryByRole("button", { name: "Take over after this step" }),
    ).toBeNull();
  });

  test("take over now asks first: cancelling sends nothing, confirming sends now", async () => {
    const fetchMock = stubFetch({ [ATTACH]: ACCEPTED });
    const user = userEvent.setup();
    renderWithProviders(<AttachButton session={running} />);

    await user.click(
      screen.getByRole("button", { name: "Take over now (interrupts)" }),
    );
    let dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("in the middle of its turn");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(callsTo(fetchMock, ATTACH, "POST")).toHaveLength(0);

    await user.click(
      screen.getByRole("button", { name: "Take over now (interrupts)" }),
    );
    dialog = screen.getByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Take over now" }),
    );
    await waitFor(() =>
      expect(callsTo(fetchMock, ATTACH, "POST")).toHaveLength(1),
    );
    expect((bodyOf(fetchMock, ATTACH, "POST") as AttachBody).when).toBe("now");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  test("a refused now shows the server's error in its dialog", async () => {
    stubFetch({ [ATTACH]: () => apiError(409, "conflict", "not now") });
    const user = userEvent.setup();
    renderWithProviders(<AttachButton session={running} />);
    await user.click(
      screen.getByRole("button", { name: "Take over now (interrupts)" }),
    );
    const dialog = screen.getByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Take over now" }),
    );
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "not now",
    );
  });

  test("a pending takeover shows as such, with a Cancel that sends the detach and clears the token", async () => {
    sessionStorage.setItem("pty-lease:s1", "tab-token");
    const pending = {
      ...running,
      attach_intent_owner: "tab-token",
      attach_intent_at: 1_800_000_000_000,
    };
    const fetchMock = stubFetch({ [ATTACH]: ACCEPTED });
    const user = userEvent.setup();
    renderWithProviders(<AttachButton session={pending} />);
    expect(screen.getByRole("status").textContent).toBe(
      "taking over after this step…",
    );
    expect(
      screen.queryByRole("button", { name: "Take over after this step" }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(callsTo(fetchMock, ATTACH, "DELETE")).toHaveLength(1),
    );
    expect(callsTo(fetchMock, ATTACH, "POST")).toHaveLength(0);
    expect(readLeaseToken("s1")).toBeNull();
  });

  test("an ended session never shows a takeover as pending", () => {
    renderWithProviders(
      <AttachButton
        session={{
          ...running,
          state: "exited",
          attach_intent_owner: "t",
          attach_intent_at: 1,
        }}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Attach" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
