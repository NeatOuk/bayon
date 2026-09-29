import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { ReviewQueueScreen } from "@/gates/review-queue-screen";
import { sessionView } from "@/test/fixtures";
import {
  evidence,
  gateSummary,
  gateTicket,
  gatesPage,
} from "@/test/gate-fixtures";
import { pushFeed } from "@/test/push-feed";
import {
  apiError,
  bodyOf,
  callsTo,
  renderWithProviders,
  stubFetch,
} from "@/test/render";

const QUEUE = "/api/v1/gates?state=running%2Cfailed&latest=1&limit=100";

test("it loads, then lists the failed gates that need you and the running ones, each with its ticket and reviewer", async () => {
  stubFetch({
    [QUEUE]: gatesPage([
      gateSummary(
        { id: "g-run", kind: "plan_review", session_id: "S-live" },
        gateTicket(813, { title: "ledger lock" }),
      ),
      gateSummary(
        {
          id: "g-fail",
          kind: "code_review",
          attempt: 2,
          state: "failed",
          reason: "blocking_findings",
          findings_total: 2,
          findings_unresolved: 1,
          session_id: "S-rev",
          evidence: evidence({ flags: { single_runner_review: true } }),
        },
        gateTicket(812, { title: "transfer idempotency" }),
      ),
    ]),
    "/api/v1/sessions/S-live": sessionView({
      id: "S-live",
      runner_id: "reviewer-c",
    }),
  });
  renderWithProviders(<ReviewQueueScreen />);
  expect(screen.getByRole("status").textContent).toBe(
    "Loading the review queue…",
  );

  const failed = await screen.findByRole("region", { name: "failed" });
  expect(within(failed).getByText("Failed · 1")).toBeTruthy();
  expect(
    within(failed)
      .getByRole("link", { name: "FRM-812 transfer idempotency" })
      .getAttribute("href"),
  ).toBe("#/tickets/812");
  expect(within(failed).getByText("code_review #2")).toBeTruthy();
  expect(within(failed).getByText("Failed (blocking findings)")).toBeTruthy();
  expect(within(failed).getByText("reviewer-b")).toBeTruthy();
  expect(within(failed).getByText("single-runner review")).toBeTruthy();
  expect(
    within(failed)
      .getByRole("link", { name: "reviewer session" })
      .getAttribute("href"),
  ).toBe("#/sessions/S-rev");
  expect(within(failed).getByText("1 open / 2")).toBeTruthy();
  expect(within(failed).getByRole("button", { name: "Rerun" })).toBeTruthy();

  const running = screen.getByRole("region", { name: "running" });
  expect(
    within(running)
      .getByRole("link", { name: "live reviewer" })
      .getAttribute("href"),
  ).toBe("#/sessions/S-live");
  expect(await within(running).findByText("reviewer-c")).toBeTruthy();
  expect(within(running).queryByRole("button", { name: "Rerun" })).toBeNull();
  expect(within(running).getByRole("button", { name: "Waive" })).toBeTruthy();
});

test("an empty queue says there is nothing to review", async () => {
  stubFetch({ [QUEUE]: gatesPage([]) });
  renderWithProviders(<ReviewQueueScreen />);
  expect(await screen.findByText("Nothing to review")).toBeTruthy();
});

test("a failed read says so", async () => {
  stubFetch({ [QUEUE]: () => apiError(500, "internal", "db down") });
  renderWithProviders(<ReviewQueueScreen />);
  const alert = await screen.findByRole("alert");
  expect(
    within(alert).getByText("The review queue is unavailable"),
  ).toBeTruthy();
  expect(within(alert).getByText("internal: db down")).toBeTruthy();
  expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("a rerun posts, and the queue refetches with the new attempt running", async () => {
  let reran = false;
  const RUN = "/api/v1/gates/g1/run";
  const fetchMock = stubFetch({
    [QUEUE]: () =>
      gatesPage([
        reran
          ? gateSummary({ id: "g2", kind: "code_review", attempt: 2 })
          : gateSummary({
              id: "g1",
              kind: "code_review",
              state: "failed",
              reason: "reviewer_error",
            }),
      ]),
    [RUN]: () => {
      reran = true;
      return {
        gate_id: "g2",
        attempt: 2,
        command_id: "cmd-1",
        session_id: "S-2",
      };
    },
  });
  const user = userEvent.setup();
  renderWithProviders(<ReviewQueueScreen />);
  const failed = await screen.findByRole("region", { name: "failed" });
  await user.click(within(failed).getByRole("button", { name: "Rerun" }));
  const running = screen.getByRole("region", { name: "running" });
  expect(await within(running).findByText("code_review #2")).toBeTruthy();
  expect(callsTo(fetchMock, RUN, "POST")).toHaveLength(1);
});

test("a waiver needs a reason; a 409 then says the gate was decided first and refetches", async () => {
  let decided = false;
  const WAIVE = "/api/v1/gates/g1/waive";
  const fetchMock = stubFetch({
    [QUEUE]: () =>
      gatesPage(
        decided ? [] : [gateSummary({ id: "g1", kind: "code_review" })],
      ),
    [WAIVE]: () => {
      decided = true;
      return apiError(
        409,
        "conflict",
        "gate g1 is passed, not running | failed",
      );
    },
  });
  const user = userEvent.setup();
  renderWithProviders(<ReviewQueueScreen />);
  const running = await screen.findByRole("region", { name: "running" });
  await user.click(within(running).getByRole("button", { name: "Waive" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Waive gate" }));
  expect(within(dialog).getByRole("alert").textContent).toBe(
    "Give a reason of 1 to 500 characters.",
  );
  expect(callsTo(fetchMock, WAIVE, "POST")).toHaveLength(0);

  await user.type(within(dialog).getByLabelText("Reason"), "not worth a rerun");
  await user.click(within(dialog).getByRole("button", { name: "Waive gate" }));
  await waitFor(() =>
    expect(bodyOf(fetchMock, WAIVE, "POST")).toEqual({
      reason: "not worth a rerun",
    }),
  );
  expect(
    await screen.findByText(
      /code_review #1 changed before your write arrived \(conflict: gate g1 is passed, not running \| failed\)/,
    ),
  ).toBeTruthy();
  expect(await screen.findByText("Nothing to review")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callsTo(fetchMock, QUEUE).length).toBeGreaterThanOrEqual(2);
});

test("a gates frame replaces the queue", async () => {
  stubFetch({ [QUEUE]: gatesPage([]) });
  const { feed, pushGates } = pushFeed();
  renderWithProviders(<ReviewQueueScreen />, { feed });
  await screen.findByText("Nothing to review");
  pushGates(
    gatesPage([
      gateSummary({
        id: "g7",
        kind: "ce_review",
        state: "failed",
        reason: "reviewer_error",
      }),
    ]),
  );
  expect(await screen.findByText("Failed (reviewer error)")).toBeTruthy();
  expect(screen.queryByText("Nothing to review")).toBeNull();
});

test("loading is silent; a push that moves a gate is announced in a polite live region", async () => {
  stubFetch({
    [QUEUE]: gatesPage([
      gateSummary({ id: "g1", kind: "code_review" }, gateTicket(812)),
    ]),
  });
  const { feed, pushGates } = pushFeed();
  renderWithProviders(<ReviewQueueScreen />, { feed });
  await screen.findByRole("link", { name: "FRM-812 ticket 812" });
  const status = screen.getByRole("status");
  expect(status.getAttribute("aria-live")).toBe("polite");
  expect(status.textContent).toBe("");
  pushGates(
    gatesPage([
      gateSummary(
        {
          id: "g1",
          kind: "code_review",
          state: "failed",
          reason: "blocking_findings",
        },
        gateTicket(812),
      ),
    ]),
  );
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe(
      "code_review on FRM-812: #1 failed (blocking findings).",
    ),
  );
});

test("a push keeps the pages loaded with Load more, refetched on their cursors", async () => {
  const CURSOR = "1800000000000.g1";
  const PAGE_2 = `${QUEUE}&cursor=${CURSOR}`;
  let pushed = false;
  const firstPage = () =>
    gatesPage(
      [
        ...(pushed
          ? [gateSummary({ id: "g0", kind: "code_review" }, gateTicket(3))]
          : []),
        gateSummary({ id: "g1", kind: "code_review" }, gateTicket(1)),
      ],
      CURSOR,
    );
  const fetchMock = stubFetch({
    [QUEUE]: firstPage,
    [PAGE_2]: gatesPage([
      gateSummary({ id: "g2", kind: "code_review" }, gateTicket(2)),
    ]),
  });
  const { feed, pushGates } = pushFeed();
  const user = userEvent.setup();
  renderWithProviders(<ReviewQueueScreen />, { feed });
  await screen.findByRole("link", { name: "FRM-1 ticket 1" });
  await user.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByRole("link", { name: "FRM-2 ticket 2" });

  pushed = true;
  pushGates(firstPage());
  expect(
    await screen.findByRole("link", { name: "FRM-3 ticket 3" }),
  ).toBeTruthy();
  expect(screen.getByRole("link", { name: "FRM-2 ticket 2" })).toBeTruthy();
  expect(screen.getAllByRole("link", { name: "FRM-1 ticket 1" })).toHaveLength(
    1,
  );
  await waitFor(() => expect(callsTo(fetchMock, PAGE_2)).toHaveLength(2));
  expect(screen.getByRole("link", { name: "FRM-2 ticket 2" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("more pages load on the keyset cursor", async () => {
  stubFetch({
    [QUEUE]: gatesPage(
      [gateSummary({ id: "g1", kind: "code_review" }, gateTicket(1))],
      "1800000000000.g1",
    ),
    [`${QUEUE}&cursor=1800000000000.g1`]: gatesPage([
      gateSummary({ id: "g2", kind: "code_review" }, gateTicket(2)),
    ]),
  });
  const user = userEvent.setup();
  renderWithProviders(<ReviewQueueScreen />);
  await screen.findByRole("link", { name: "FRM-1 ticket 1" });
  await user.click(screen.getByRole("button", { name: "Load more" }));
  expect(
    await screen.findByRole("link", { name: "FRM-2 ticket 2" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});
