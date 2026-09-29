import { IDEMPOTENCY_HEADER } from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { fleet, fleetRow } from "@/test/fixtures";
import { bodyOf, callsTo, renderWithProviders, stubFetch } from "@/test/render";
import { ticketView } from "@/test/ticket-fixtures";
import { TicketActions } from "@/tickets/ticket-actions";

const FLEET = "/api/v1/fleet";

const STAFF_ACCEPTED = {
  command_id: "cmd-1",
  session_id: "sess-1",
  created: true,
  agent_id: "agent-1",
  role: "builder",
  run_class: "build",
  handoff_id: null,
  ticket_status: "building",
};

test("Staff builder is absent on a non-staffable status", () => {
  renderWithProviders(
    <TicketActions
      ticket={ticketView({ num: 1, status: "done" })}
      transitions={[]}
    />,
  );
  expect(screen.queryByRole("button", { name: "Staff builder" })).toBeNull();
});

test("Staff builder is present on prioritized and staffed", () => {
  renderWithProviders(
    <TicketActions
      ticket={ticketView({ num: 1, status: "prioritized" })}
      transitions={[]}
    />,
  );
  expect(screen.getByRole("button", { name: "Staff builder" })).toBeTruthy();
});

test("a click POSTs {role: builder} and refreshes the ticket on success", async () => {
  const fetchMock = stubFetch({
    "/api/v1/tickets/7/staff": STAFF_ACCEPTED,
  });
  renderWithProviders(
    <TicketActions
      ticket={ticketView({ num: 7, status: "staffed" })}
      transitions={[]}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Staff builder" }));
  await waitFor(() =>
    expect(callsTo(fetchMock, "/api/v1/tickets/7/staff", "POST")).toHaveLength(
      1,
    ),
  );
  expect(bodyOf(fetchMock, "/api/v1/tickets/7/staff", "POST")).toEqual({
    role: "builder",
  });
});

test("Staff builder disables itself and names the holder when a live session already works the ticket", async () => {
  stubFetch({
    [FLEET]: fleet([
      fleetRow({
        id: "s-live",
        agent: "bayon-builder",
        state: "idle",
        ticket: 7,
      }),
    ]),
  });
  renderWithProviders(
    <TicketActions
      ticket={ticketView({ num: 7, status: "staffed" })}
      transitions={[]}
    />,
  );
  const button = (await screen.findByRole("button", {
    name: "Staff builder",
  })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(true));
  expect(screen.getByText(/Held by bayon-builder \(Idle\)/)).toBeTruthy();
  const link = screen.getByRole("link", { name: "session" });
  expect(link.getAttribute("href")).toBe("#/sessions/s-live");
});

test("Staff builder stays enabled when the fleet shows no session on this ticket", async () => {
  const fetchMock = stubFetch({
    [FLEET]: fleet([fleetRow({ id: "s-other", ticket: 99 })]),
  });
  renderWithProviders(
    <TicketActions
      ticket={ticketView({ num: 7, status: "staffed" })}
      transitions={[]}
    />,
  );
  // Wait for the real fleet response to resolve, not just for fetch to have been called (a call
  // is recorded synchronously, before react-query has applied the data) — otherwise this assertion
  // could pass before heldBy ever ran against real data, hiding a broken match.
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await fetchMock.mock.results[0]?.value;
  await waitFor(() => {
    const button = screen.getByRole("button", {
      name: "Staff builder",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
  // The footnote a match would render is absent: proof this ran against real, non-matching data.
  expect(screen.queryByText(/Held by/)).toBeNull();
});

test("a 409 shows the server's message without navigating away", async () => {
  stubFetch({
    "/api/v1/tickets/7/staff": () =>
      Response.json(
        {
          error: {
            class: "conflict",
            message: "not_staffable: already staffed",
            retryable: false,
          },
        },
        { status: 409 },
      ),
  });
  renderWithProviders(
    <TicketActions
      ticket={ticketView({ num: 7, status: "staffed" })}
      transitions={[]}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Staff builder" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("not_staffable: already staffed");
});

test("a retried staff click reuses its Idempotency-Key, so the server can refuse the second spawn", async () => {
  // The first attempt fails at the transport, the way a dropped connection does — the server may
  // well have queued the spawn already. The retry must arrive under the same key, or it queues a
  // second session.
  let attempt = 0;
  const fetchMock = stubFetch({
    "/api/v1/tickets/7/staff": () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError("Failed to fetch");
      return STAFF_ACCEPTED;
    },
  });
  renderWithProviders(
    <TicketActions
      ticket={ticketView({ num: 7, status: "staffed" })}
      transitions={[]}
    />,
  );
  const user = userEvent.setup();
  const button = () => screen.getByRole("button", { name: "Staff builder" });

  await user.click(button());
  await waitFor(() =>
    expect(callsTo(fetchMock, "/api/v1/tickets/7/staff", "POST")).toHaveLength(
      1,
    ),
  );
  await user.click(button());
  await waitFor(() =>
    expect(callsTo(fetchMock, "/api/v1/tickets/7/staff", "POST")).toHaveLength(
      2,
    ),
  );

  const keys = callsTo(fetchMock, "/api/v1/tickets/7/staff", "POST").map(
    ([, init]) => (init?.headers as Record<string, string>)[IDEMPOTENCY_HEADER],
  );
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
});

// a submit_plan refusal used to be a dead end — plan_path was settable only through
// PATCH, which no screen exposed, so an operator holding a written plan needed curl.
const SUBMIT_PLAN = {
  to: "plan_review" as const,
  rule: "submit_plan",
  allowed: false,
  reason: "missing_artifact" as const,
  detail: "plan_path is not set",
};

test("a move refused for a missing plan offers the path, and setting it PATCHes the ticket", async () => {
  const fetchMock = stubFetch({
    "/api/v1/tickets/3": ticketView({ num: 3, status: "spiking" }),
  });
  renderWithProviders(
    <TicketActions
      ticket={ticketView({ num: 3, key: "FRM-3", status: "spiking" })}
      transitions={[SUBMIT_PLAN]}
    />,
  );
  // The refusal still says why, and now stands beside what to do about it.
  expect(screen.getByText(/plan_path is not set/)).toBeTruthy();
  const field = screen.getByLabelText("Plan path");
  expect(field.getAttribute("placeholder")).toBe("docs/spikes/FRM-3.md");

  const user = userEvent.setup();
  const set = () => screen.getByRole("button", { name: "Set plan path" });
  // Nothing typed is nothing to set: the button cannot send an empty path.
  expect((set() as HTMLButtonElement).disabled).toBe(true);

  await user.type(field, "docs/spikes/FRM-3.md");
  await user.click(set());
  await waitFor(() =>
    expect(callsTo(fetchMock, "/api/v1/tickets/3", "PATCH")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, "/api/v1/tickets/3", "PATCH")).toEqual({
    plan_path: "docs/spikes/FRM-3.md",
  });
});

// The path being set is the case that most needs the field: a typo is still a missing_artifact,
// and hiding the field there left the operator exactly as stuck as before an earlier change.
test("a plan path that names no file is corrected in place, starting from the one it names", async () => {
  const fetchMock = stubFetch({
    "/api/v1/tickets/3": ticketView({ num: 3, status: "spiking" }),
  });
  renderWithProviders(
    <TicketActions
      ticket={ticketView({
        num: 3,
        key: "FRM-3",
        status: "spiking",
        plan_path: "docs/spikes/FMR-3.md",
      })}
      transitions={[
        { ...SUBMIT_PLAN, detail: "docs/spikes/FMR-3.md does not exist" },
      ]}
    />,
  );
  const field = screen.getByLabelText("Plan path") as HTMLInputElement;
  // Pre-filled with the path that failed, so the typo is visible and editable, not retyped blind.
  expect(field.value).toBe("docs/spikes/FMR-3.md");

  const user = userEvent.setup();
  const set = () => screen.getByRole("button", { name: "Update plan path" });
  // Re-sending the same path would bump the version and change nothing.
  expect((set() as HTMLButtonElement).disabled).toBe(true);

  await user.clear(field);
  await user.type(field, "docs/spikes/FRM-3.md");
  await user.click(set());
  await waitFor(() =>
    expect(callsTo(fetchMock, "/api/v1/tickets/3", "PATCH")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, "/api/v1/tickets/3", "PATCH")).toEqual({
    plan_path: "docs/spikes/FRM-3.md",
  });
});

test("no plan field on a refusal the operator cannot answer that way", () => {
  renderWithProviders(
    <TicketActions
      ticket={ticketView({ num: 3, status: "spiking" })}
      transitions={[
        {
          to: "planned",
          rule: "approve_plan",
          allowed: false,
          reason: "gate_not_passed",
          detail: "plan_review has not passed",
        },
      ]}
    />,
  );
  expect(screen.queryByLabelText("Plan path")).toBeNull();
});

// a move is named for where it goes, its rule quiet under it; the moves that take the
// ticket out of the flow stand apart, and ask first.
test("an onward move reads 'Move to …' with its rule as its description; stop moves stand apart", () => {
  renderWithProviders(
    <TicketActions
      ticket={ticketView({ num: 3, status: "code_review" })}
      transitions={[
        { to: "qa_harness", rule: "pass_review", allowed: true },
        { to: "review_fix", rule: "request_fix", allowed: true },
        { to: "parked", rule: "park", allowed: true },
        { to: "rejected", rule: "reject", allowed: true },
      ]}
    />,
  );
  const moves = screen.getByRole("list", { name: "moves" });
  const pass = within(moves).getByRole("button", {
    name: "Move to QA harness",
  });
  expect(
    document.getElementById(pass.getAttribute("aria-describedby") ?? "")
      ?.textContent,
  ).toBe("pass_review");
  expect(pass.getAttribute("title")).toBe("pass_review");
  expect(
    within(moves).getByRole("button", { name: "Move to Review fix" }),
  ).toBeTruthy();
  const stops = screen.getByRole("list", { name: "stop moves" });
  expect(
    within(stops)
      .getAllByRole("button")
      .map((b) => b.textContent),
  ).toEqual(["Park", "Reject"]);
  expect(
    within(stops).getByRole("button", { name: "Reject" }).dataset.variant,
  ).toBe("destructive");
  expect(within(moves).queryByRole("button", { name: "Park" })).toBeNull();
});

test("park asks first: Cancel moves nothing, the confirm moves it", async () => {
  const fetchMock = stubFetch({
    "/api/v1/tickets/3/transition": ticketView({ num: 3, status: "parked" }),
  });
  renderWithProviders(
    <TicketActions
      ticket={ticketView({ num: 3, key: "FRM-3", status: "backlog" })}
      transitions={[{ to: "parked", rule: "park", allowed: true }]}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Park" }));
  const ask = await screen.findByRole("alertdialog");
  expect(within(ask).getByText("Park FRM-3?")).toBeTruthy();
  await user.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(
    callsTo(fetchMock, "/api/v1/tickets/3/transition", "POST"),
  ).toHaveLength(0);

  await user.click(screen.getByRole("button", { name: "Park" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Park",
    }),
  );
  await waitFor(() =>
    expect(
      callsTo(fetchMock, "/api/v1/tickets/3/transition", "POST"),
    ).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, "/api/v1/tickets/3/transition", "POST")).toEqual({
    to: "parked",
  });
});

test("block needs notes, so its notes dialog is the confirmation: no second ask", async () => {
  renderWithProviders(
    <TicketActions
      ticket={ticketView({ num: 3, status: "building" })}
      transitions={[{ to: "blocked", rule: "block", allowed: true }]}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Block" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(screen.getByLabelText("Blocked reason")).toBeTruthy();
});

test("the move the next step names is the one primary button; the others are secondary", () => {
  renderWithProviders(
    <TicketActions
      ticket={ticketView({ num: 3, status: "code_review" })}
      suggested="qa_harness"
      transitions={[
        { to: "qa_harness", rule: "pass_review", allowed: true },
        { to: "review_fix", rule: "request_fix", allowed: true },
        {
          to: "done",
          rule: "finish",
          allowed: false,
          reason: "gate_not_passed",
        },
      ]}
    />,
  );
  const variant = (name: string) =>
    screen.getByRole("button", { name }).dataset.variant;
  expect(variant("Move to QA harness")).toBe("default");
  expect(variant("Move to Review fix")).toBe("secondary");
  expect(variant("Move to Done")).toBe("outline");
});
