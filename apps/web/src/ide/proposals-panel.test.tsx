import type { InboxItem } from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { inboxItem, inboxPage } from "@/test/inbox-fixtures";
import { proposalsUrl, renderIde, tabNames } from "@/test/ide-harness";
import { projectAgent, projectView } from "@/test/project-fixtures";
import { pushFeed } from "@/test/push-feed";
import { bodyOf, callsTo } from "@/test/render";

// The Orchestrator view's pending proposals: the project's open staffing proposals,
// answered approve or reject in place through `POST /inbox/:id/answer`. A retryable 409 (the agent
// busy) keeps the request open, so its row stays and says why; a final one refetches the list.

const ORCH = projectAgent({ id: "bayon-orchestrator", kind: "orchestrator" });
const BUILDER = projectAgent({
  id: "A-BUILDER",
  name: "bayon-builder",
  runner_id: "runner-a",
});
const BAYON = projectView({ agents: [ORCH, BUILDER], staff_approval: true });
const HASH = "#/p/ws-bayon/orchestrator";
const PROPOSALS = proposalsUrl("ws-bayon");
const answerUrl = (id: string) => `/api/v1/inbox/${id}/answer`;

const proposal = (id: string, num: number, over: Partial<InboxItem> = {}) =>
  inboxItem({
    id,
    kind: "staff_approval",
    question: `Staff FRM-${num} with A-BUILDER (builder, build)?`,
    context_md: "Runner: runner-a. Hand-off: none.",
    options: ["approve", "reject"],
    ticket: {
      id: `ticket-${num}`,
      num,
      title: `ticket ${num}`,
      status: "prioritized",
    },
    session: {
      id: "S-O",
      agent: "bayon-orchestrator",
      role: "orchestrator",
      state: "running",
    },
    proposal: {
      agent_id: "A-BUILDER",
      runner_id: "runner-a",
      role: "builder",
      run_class: "build",
      handoff_id: null,
    },
    ...over,
  });

const R12 = proposal("R12", 12);
const R13 = proposal("R13", 13, {
  asked_at: 1_800_000_060_000,
  proposal: {
    agent_id: "A-GONE",
    runner_id: "runner-b",
    role: "reviewer",
    run_class: "review",
    handoff_id: "01JHANDOFF0000000000000042",
  },
});

const answered = (item: InboxItem, answer: string): InboxItem => ({
  ...item,
  status: "answered",
  answer,
  answered_by: "operator",
  answered_at: 1_800_000_120_000,
});

const conflict = (message: string, retryable: boolean) =>
  Response.json(
    { error: { class: "conflict", message, retryable } },
    { status: 409 },
  );

const panel = () => screen.findByRole("region", { name: "proposals" });
const row = async (name: string) =>
  within(await panel()).findByRole("listitem", { name: `proposal ${name}` });

afterEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
});

test("each open proposal shows its ticket, the proposed agent and runner, role, run class, hand-off and when it was asked; a ticket opens its tab", async () => {
  renderIde(HASH, BAYON, {
    [PROPOSALS]: inboxPage([R13, R12], "next"),
  });
  const r12 = await row("#12");
  const facts = (item: HTMLElement) =>
    within(item)
      .getAllByRole("term")
      .map((term) => `${term.textContent}: ${term.nextSibling?.textContent}`);
  expect(facts(r12)).toEqual([
    "Agent: bayon-builderrunner-a",
    "As: builder · build",
    "Hand-off: none",
  ]);
  expect(within(r12).getByText("ticket 12")).toBeTruthy();
  expect(within(r12).getByText("asked 2027-01-15 08:00 UTC")).toBeTruthy();
  // An agent the project does not list is named by its id; a hand-off by its id, shortened in the
  // middle and whole for a screen reader.
  expect(facts(await row("#13"))).toEqual([
    "Agent: A-GONErunner-b",
    "As: reviewer · review",
    "Hand-off: 01JH…00004201JHANDOFF0000000000000042",
  ]);
  expect(
    within(await panel())
      .getByRole("link", { name: "the Inbox" })
      .getAttribute("href"),
  ).toBe("#/inbox");

  const user = userEvent.setup();
  await user.click(within(r12).getByRole("link", { name: "#12" }));
  expect(window.location.hash).toBe(`${HASH}?open=ticket:12`);
  await waitFor(() => expect(tabNames()).toEqual(["Orchestrator", "#12"]));
});

test("approve answers approve; the row leaves at once and the proposals are refetched", async () => {
  let open = [R12, R13];
  const fetchMock = renderIde(HASH, BAYON, {
    [PROPOSALS]: () => inboxPage(open),
    [answerUrl("R12")]: () => {
      open = [R13];
      return answered(R12, "approve");
    },
  });
  const user = userEvent.setup();
  await user.click(
    within(await row("#12")).getByRole("button", { name: "Approve #12" }),
  );
  await waitFor(() =>
    expect(
      within(screen.getByRole("list", { name: "open proposals" })).queryByRole(
        "listitem",
        { name: "proposal #12" },
      ),
    ).toBe(null),
  );
  expect(bodyOf(fetchMock, answerUrl("R12"), "POST")).toEqual({
    answer: "approve",
  });
  // The answer is told in a toast.
  expect(
    await screen.findByRole("status", { name: "Approved: #12" }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(callsTo(fetchMock, PROPOSALS).length).toBeGreaterThan(1),
  );
  expect(await row("#13")).toBeTruthy();
});

test("approve while the agent is busy: a retryable 409 keeps the row open with the server's reason, and nothing is refetched", async () => {
  const fetchMock = renderIde(HASH, BAYON, {
    [PROPOSALS]: inboxPage([R12]),
    [answerUrl("R12")]: () =>
      conflict(
        "not staffable (no_agent): bayon-builder has no free slot",
        true,
      ),
  });
  const user = userEvent.setup();
  const r12 = await row("#12");
  await user.click(within(r12).getByRole("button", { name: "Approve #12" }));
  expect((await within(r12).findByRole("alert")).textContent).toBe(
    "Not approved: not staffable (no_agent): bayon-builder has no free slot",
  );
  expect(r12.isConnected).toBe(true);
  expect(await row("#12")).toBe(r12);
  expect(screen.queryByRole("status", { name: /^Approved/ })).toBe(null);
  expect(callsTo(fetchMock, answerUrl("R12"), "POST")).toHaveLength(1);
  expect(callsTo(fetchMock, PROPOSALS)).toHaveLength(1);
  // Still open: it can be approved again once the agent is free.
  expect(
    (
      within(r12).getByRole("button", {
        name: "Approve #12",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

test("reject asks first: cancel sends nothing, and the proposal stays open", async () => {
  const fetchMock = renderIde(HASH, BAYON, {
    [PROPOSALS]: inboxPage([R12]),
    [answerUrl("R12")]: () => answered(R12, "reject"),
  });
  const user = userEvent.setup();
  const r12 = await row("#12");
  await user.click(within(r12).getByRole("button", { name: "Reject #12" }));
  const ask = await screen.findByRole("alertdialog");
  expect(within(ask).getByText("Reject #12?")).toBeTruthy();
  expect(
    within(ask).getByText(
      "Nothing starts, and the orchestrator will not propose this phase of #12 again.",
    ),
  ).toBeTruthy();
  await user.click(within(ask).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBe(null));
  expect(callsTo(fetchMock, answerUrl("R12"), "POST")).toHaveLength(0);
  expect(r12.isConnected).toBe(true);
});

test("reject, confirmed, answers reject, and the row leaves", async () => {
  let open = [R12];
  const fetchMock = renderIde(HASH, BAYON, {
    [PROPOSALS]: () => inboxPage(open),
    [answerUrl("R12")]: () => {
      open = [];
      return answered(R12, "reject");
    },
  });
  const user = userEvent.setup();
  await user.click(
    within(await row("#12")).getByRole("button", { name: "Reject #12" }),
  );
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Reject #12",
    }),
  );
  expect(await within(await panel()).findByText("None open.")).toBeTruthy();
  expect(bodyOf(fetchMock, answerUrl("R12"), "POST")).toEqual({
    answer: "reject",
  });
  expect(
    await screen.findByRole("status", { name: "Rejected: #12" }),
  ).toBeTruthy();
});

test("a final 409 (answered elsewhere) says so in the server's words and refetches the list: the answered row leaves", async () => {
  let open = [R12];
  const fetchMock = renderIde(HASH, BAYON, {
    [PROPOSALS]: () => inboxPage(open),
    [answerUrl("R12")]: () => {
      open = [];
      return conflict("human request R12 is answered already", false);
    },
  });
  const user = userEvent.setup();
  const r12 = await row("#12");
  await user.click(within(r12).getByRole("button", { name: "Approve #12" }));
  // The row may be gone already, so the reason is told in an error toast.
  const refusal = await screen.findByRole("alert", {
    name: "Not answered: #12",
  });
  expect(refusal.textContent).toContain(
    "human request R12 is answered already. The proposals are refreshed.",
  );
  expect(await within(await panel()).findByText("None open.")).toBeTruthy();
  expect(callsTo(fetchMock, PROPOSALS)).toHaveLength(2);
});

test("both answers are disabled while one is in flight", async () => {
  let release: (() => void) | undefined;
  let open = [R12];
  renderIde(HASH, BAYON, {
    [PROPOSALS]: () => inboxPage(open),
    [answerUrl("R12")]: () =>
      new Promise((resolve) => {
        release = () => {
          open = [];
          resolve(answered(R12, "approve"));
        };
      }),
  });
  const user = userEvent.setup();
  const r12 = await row("#12");
  const button = (name: string) =>
    within(r12).getByRole("button", { name }) as HTMLButtonElement;
  await user.click(button("Approve #12"));
  await waitFor(() => expect(button("Approve #12").disabled).toBe(true));
  expect(button("Reject #12").disabled).toBe(true);
  await waitFor(() => expect(release).toBeDefined());
  release?.();
  expect(await within(await panel()).findByText("None open.")).toBeTruthy();
  expect(r12.isConnected).toBe(false);
});

test("an inbox frame refetches the proposals: a new one appears", async () => {
  const { feed, pushInbox } = pushFeed();
  let open: InboxItem[] = [];
  const fetchMock = renderIde(
    HASH,
    BAYON,
    { [PROPOSALS]: () => inboxPage(open) },
    feed,
  );
  expect(await within(await panel()).findByText("None open.")).toBeTruthy();
  open = [R12];
  pushInbox(inboxPage([]));
  expect(await row("#12")).toBeTruthy();
  expect(callsTo(fetchMock, PROPOSALS)).toHaveLength(2);
});

test("a request without the proposal's fields shows its question and context as asked; approval off says it", async () => {
  renderIde(HASH, projectView({ agents: [ORCH, BUILDER] }), {
    [PROPOSALS]: inboxPage([proposal("R12", 12, { proposal: null })]),
  });
  const r12 = await row("#12");
  expect(
    within(r12).getByText("Staff FRM-12 with A-BUILDER (builder, build)?"),
  ).toBeTruthy();
  expect(
    within(r12).getByText("Runner: runner-a. Hand-off: none."),
  ).toBeTruthy();
  expect(within(r12).queryByRole("term")).toBe(null);
});

test("with approval off and nothing open, the panel says the orchestrator staffs without asking", async () => {
  renderIde(HASH, projectView({ agents: [ORCH, BUILDER] }));
  expect(
    await within(await panel()).findByText(
      "None open. Approval is off: the orchestrator staffs without asking.",
    ),
  ).toBeTruthy();
});
