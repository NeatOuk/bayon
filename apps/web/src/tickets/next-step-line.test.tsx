import type { NextStep, TransitionOption } from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { inboxItem, inboxPage } from "@/test/inbox-fixtures";
import { bodyOf, callsTo, renderWithProviders, stubFetch } from "@/test/render";
import { gateView, ticketDetail, ticketView } from "@/test/ticket-fixtures";
import { TicketScreen } from "@/tickets/ticket-screen";

// The ticket header's next-step line: who the ticket waits on, the server's reason, and
// its action wired to the controls that already exist — a move, the Answer dialog, a gate rerun, a
// link where a pause lifts.

const DETAIL = "/api/v1/tickets/812";
const QUESTIONS = "/api/v1/inbox?status=open&ticket=812";

const line = async () => screen.findByLabelText("next step");

const detailWith = (
  next_step: NextStep,
  o: Parameters<typeof ticketDetail>[1] = {},
  ticket = ticketView({ num: 812, status: "parked", version: 5 }),
) => ticketDetail(ticket, { next_step, ...o });

const UNPARK: TransitionOption = {
  to: "backlog",
  rule: "unpark",
  allowed: true,
};

test("a parked ticket says its note, and Unpark moves it with If-Match", async () => {
  const fetchMock = stubFetch({
    [DETAIL]: detailWith(
      {
        waiting_on: "nothing",
        reason: "Parked: waits on the design",
        action: { kind: "transition", label: "Unpark", target: "backlog" },
      },
      { transitions: [UNPARK] },
    ),
    [`${DETAIL}/transition`]: ticketView({
      num: 812,
      status: "backlog",
      version: 6,
    }),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const next = await line();
  expect(within(next).getByText("Nothing to do")).toBeTruthy();
  expect(within(next).getByText("Parked: waits on the design")).toBeTruthy();
  await userEvent.click(within(next).getByRole("button", { name: "Unpark" }));
  await waitFor(() =>
    expect(callsTo(fetchMock, `${DETAIL}/transition`, "POST")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, `${DETAIL}/transition`, "POST")).toEqual({
    to: "backlog",
  });
  const [, init] = callsTo(fetchMock, `${DETAIL}/transition`, "POST")[0] ?? [];
  expect(new Headers(init?.headers).get("If-Match")).toBe('"5"');
});

test("a move that needs a note asks for it first, as the Actions panel does", async () => {
  const fetchMock = stubFetch({
    [DETAIL]: detailWith(
      {
        waiting_on: "you",
        reason: "QA needs your note (no QA harness configured)",
        action: {
          kind: "transition",
          label: "Pass with a note",
          target: "qa_human",
        },
      },
      {
        transitions: [
          {
            to: "qa_human",
            rule: "pass_harness",
            allowed: true,
            input: ["override_note"],
          },
        ],
      },
      ticketView({ num: 812, status: "qa_harness", version: 2 }),
    ),
    [`${DETAIL}/transition`]: ticketView({
      num: 812,
      status: "qa_human",
      version: 3,
    }),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const next = await line();
  // Waiting on you asks, it does not alarm: the warning tone, not danger.
  expect(within(next).getByText("Waiting on you").dataset.tone).toBe("warning");
  await userEvent.click(
    within(next).getByRole("button", { name: "Pass with a note" }),
  );
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(within(dialog).getByRole("textbox"), "checked by hand");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Move to Human QA" }),
  );
  await waitFor(() =>
    expect(bodyOf(fetchMock, `${DETAIL}/transition`, "POST")).toEqual({
      to: "qa_human",
      override_note: "checked by hand",
    }),
  );
});

test("a ticket waiting on answers opens the Inbox's own Answer dialog for its first question", async () => {
  const fetchMock = stubFetch({
    [DETAIL]: detailWith(
      {
        waiting_on: "you",
        reason: "Waiting on your answer to 1 question",
        action: { kind: "answer", label: "Answer it", target: "questions" },
      },
      {},
      ticketView({ num: 812, status: "building", open_questions: 1 }),
    ),
    [QUESTIONS]: inboxPage([inboxItem({ id: "h1", question: "Which store?" })]),
    "/api/v1/inbox/h1/answer": inboxItem({
      id: "h1",
      status: "answered",
      answer: "sqlite",
    }),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const next = await line();
  await userEvent.click(
    await within(next).findByRole("button", { name: "Answer" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Which store?")).toBeTruthy();
  await userEvent.type(within(dialog).getByRole("textbox"), "sqlite");
  await userEvent.click(within(dialog).getByRole("button", { name: /send/i }));
  await waitFor(() =>
    expect(bodyOf(fetchMock, "/api/v1/inbox/h1/answer", "POST")).toEqual({
      answer: "sqlite",
    }),
  );
});

test("until its questions load, the answer is a link to the Inbox", async () => {
  stubFetch({
    [DETAIL]: detailWith(
      {
        waiting_on: "you",
        reason: "Waiting on your answer to 1 question",
        action: { kind: "answer", label: "Answer it", target: "questions" },
      },
      {},
      ticketView({ num: 812, status: "building", workspace_id: "shop" }),
    ),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const next = await line();
  expect(
    within(next).getByRole("link", { name: "Answer it" }).getAttribute("href"),
  ).toBe("#/p/shop/inbox?ticket=812");
});

test("a review that cannot run offers the gate's own Rerun", async () => {
  const fetchMock = stubFetch({
    [DETAIL]: detailWith(
      {
        waiting_on: "you",
        reason: "Review timed out",
        action: {
          kind: "rerun_gate",
          label: "Rerun code_review",
          target: "g-cr",
        },
      },
      {
        gates: [
          gateView({
            id: "g-cr",
            kind: "code_review",
            state: "failed",
            attempt: 2,
          }),
        ],
      },
      ticketView({ num: 812, status: "code_review" }),
    ),
    "/api/v1/gates/g-cr/run": {
      gate_id: "g-cr",
      attempt: 3,
      command_id: "c1",
      session_id: "s9",
    },
  });
  renderWithProviders(<TicketScreen num={812} />);
  const next = await line();
  await userEvent.click(
    within(next).getByRole("button", { name: "Rerun code_review" }),
  );
  await waitFor(() =>
    expect(callsTo(fetchMock, "/api/v1/gates/g-cr/run", "POST")).toHaveLength(
      1,
    ),
  );
});

test.each([
  [
    "a paused project, to its Orchestrator view",
    { kind: "unpause", label: "Resume the project", target: "project" },
    "#/p/shop/orchestrator",
  ],
  [
    "a paused fleet, to the Fleet",
    { kind: "unpause", label: "Resume the fleet", target: "fleet" },
    "#/",
  ],
  [
    "no reviewer, to the Runners",
    { kind: "configure", label: "Set up a reviewer", target: "runners" },
    "#/runners",
  ],
  [
    "unreadable gate settings, to the Settings",
    { kind: "configure", label: "Check the gate settings", target: "settings" },
    "#/settings/general",
  ],
  [
    "a staffing proposal, to the Inbox",
    { kind: "answer", label: "Review the proposal", target: "proposal" },
    "#/p/shop/inbox?ticket=812",
  ],
] as const)("%s", async (_name, action, href) => {
  stubFetch({
    [DETAIL]: detailWith(
      { waiting_on: "paused", reason: "Paused. Next: something", action },
      {},
      ticketView({ num: 812, status: "backlog", workspace_id: "shop" }),
    ),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const next = await line();
  expect(
    within(next).getByRole("link", { name: action.label }).getAttribute("href"),
  ).toBe(href);
});

test("a hint is text, and a move the laws no longer allow shows no button", async () => {
  stubFetch({
    [DETAIL]: detailWith(
      {
        waiting_on: "you",
        reason: "Flagged needs human: look at it, then clear the flag",
        action: { kind: "none", label: "Clear the flag once handled" },
      },
      {},
      ticketView({ num: 812, status: "building" }),
    ),
  });
  const { unmount } = renderWithProviders(<TicketScreen num={812} />);
  const next = await line();
  expect(within(next).getByText("Clear the flag once handled")).toBeTruthy();
  expect(within(next).queryByRole("button")).toBeNull();
  unmount();

  stubFetch({
    [DETAIL]: detailWith(
      {
        waiting_on: "nothing",
        reason: "Parked: no note given",
        action: { kind: "transition", label: "Unpark", target: "backlog" },
      },
      { transitions: [{ ...UNPARK, allowed: false }] },
    ),
  });
  renderWithProviders(<TicketScreen num={812} />);
  expect(within(await line()).queryByRole("button")).toBeNull();
});

// a new ticket starts in one step, through the operator's own two doors in order.
const START = {
  waiting_on: "orchestrator",
  reason:
    "Waiting for the orchestrator to prioritise it (it wakes only when other work is due)",
  action: { kind: "start", label: "Start work" },
} as const;
const STAFFED = {
  command_id: "cmd-1",
  session_id: "sess-1",
  created: true,
  agent_id: "agent-1",
  role: "builder",
  run_class: "spike",
  handoff_id: null,
  ticket_status: "staffed",
};

test("Start work on a backlog ticket prioritises it with If-Match, then staffs a builder", async () => {
  const fetchMock = stubFetch({
    [DETAIL]: detailWith(
      START,
      {},
      ticketView({ num: 812, status: "backlog", version: 1 }),
    ),
    [`${DETAIL}/transition`]: ticketView({
      num: 812,
      status: "prioritized",
      version: 2,
    }),
    [`${DETAIL}/staff`]: STAFFED,
  });
  renderWithProviders(<TicketScreen num={812} />);
  const next = await line();
  await userEvent.click(
    within(next).getByRole("button", { name: "Start work" }),
  );
  await waitFor(() =>
    expect(callsTo(fetchMock, `${DETAIL}/staff`, "POST")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, `${DETAIL}/transition`, "POST")).toEqual({
    to: "prioritized",
  });
  const [, init] = callsTo(fetchMock, `${DETAIL}/transition`, "POST")[0] ?? [];
  expect(new Headers(init?.headers).get("If-Match")).toBe('"1"');
  expect(bodyOf(fetchMock, `${DETAIL}/staff`, "POST")).toEqual({
    role: "builder",
  });
  // Posted in that order: the staffing takes the prioritized ticket.
  const order = fetchMock.mock.calls
    .filter(([, i]) => i?.method === "POST")
    .map(([url]) => String(url));
  expect(order).toEqual([`${DETAIL}/transition`, `${DETAIL}/staff`]);
});

test("Start work on a prioritized ticket only staffs; a refusal reads in plain words", async () => {
  const fetchMock = stubFetch({
    [DETAIL]: detailWith(
      { ...START, waiting_on: "you", reason: "Prioritised" },
      {},
      ticketView({ num: 812, status: "prioritized", version: 2 }),
    ),
    [`${DETAIL}/staff`]: () =>
      Response.json(
        {
          error: {
            class: "admission_refused",
            message:
              "no_agent: no enabled builder in project demo has a free slot",
            retryable: true,
          },
        },
        { status: 429 },
      ),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const next = await line();
  await userEvent.click(
    within(next).getByRole("button", { name: "Start work" }),
  );
  const alert = await within(next).findByRole("alert");
  expect(alert.textContent).toBe(
    "No enabled builder in project demo has a free slot.",
  );
  expect(callsTo(fetchMock, `${DETAIL}/transition`, "POST")).toHaveLength(0);
});
