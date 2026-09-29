import type { GateView } from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
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
import {
  ZERO_ECONOMICS,
  gateView,
  ticketDetail,
  ticketView,
} from "@/test/ticket-fixtures";
import { TicketScreen } from "@/tickets/ticket-screen";

const DETAIL = "/api/v1/tickets/812";
const TICKET = ticketView({ num: 812, status: "code_review" });

const detail = (gates: readonly GateView[], rounds = 0) =>
  ticketDetail(TICKET, {
    gates: [...gates],
    economics: { ...ZERO_ECONOMICS, review_rounds: rounds },
  });

/** One kind's card in the strip. */
const card = async (name: string) =>
  within(await screen.findByRole("region", { name: "gates" })).getByRole(
    "listitem",
    { name },
  );

test("each kind shows its latest attempt: state, attempt, runner, flags and session; the earlier ones say why they failed", async () => {
  stubFetch({
    [DETAIL]: detail(
      [
        gateView({
          id: "pr1",
          kind: "plan_review",
          state: "passed",
          session_id: "S-plan",
          evidence: evidence({
            flags: {
              single_runner_review: true,
              fallback_from: "reviewer-a",
              base_drift: true,
            },
          }),
        }),
        gateView({
          id: "cr1",
          kind: "code_review",
          state: "failed",
          reason: "blocking_findings",
        }),
        gateView({
          id: "cr2",
          kind: "code_review",
          attempt: 2,
          state: "failed",
          reason: "timeout",
          evidence: { reason: "timeout" },
        }),
        gateView({
          id: "cr3",
          kind: "code_review",
          attempt: 3,
          state: "running",
          session_id: "S-live",
        }),
      ],
      3,
    ),
    "/api/v1/sessions/S-live": sessionView({
      id: "S-live",
      runner_id: "reviewer-c",
    }),
  });
  renderWithProviders(<TicketScreen num={812} />);
  expect(await screen.findByText("3 review rounds")).toBeTruthy();

  const plan = await card("plan_review");
  expect(within(plan).getByText("Passed")).toBeTruthy();
  expect(within(plan).getByText("attempt 1")).toBeTruthy();
  expect(within(plan).getByText("reviewer-b")).toBeTruthy();
  for (const flag of [
    "single-runner review",
    "fallback from reviewer-a",
    "base drift",
  ])
    expect(within(plan).getByText(flag)).toBeTruthy();
  expect(
    within(plan)
      .getByRole("link", { name: "reviewer session" })
      .getAttribute("href"),
  ).toBe("#/sessions/S-plan");
  expect(within(plan).queryByRole("button")).toBeNull();

  const code = await card("code_review");
  expect(within(code).getByText("attempt 3")).toBeTruthy();
  expect(within(code).getByText("Running")).toBeTruthy();
  expect(within(code).getByText("automatic retry of #2")).toBeTruthy();
  expect(
    within(code)
      .getByRole("link", { name: "live reviewer" })
      .getAttribute("href"),
  ).toBe("#/sessions/S-live");
  expect(await within(code).findByText("reviewer-c")).toBeTruthy();
  const earlier = within(code).getByRole("list", { name: "earlier attempts" });
  expect(
    within(earlier)
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual(["#2 failed (timeout)", "#1 failed (blocking findings)"]);
  expect(within(code).getByRole("button", { name: "Waive" })).toBeTruthy();
  expect(within(code).queryByRole("button", { name: "Rerun" })).toBeNull();
});

test("a gate that failed before a review says why in its card", async () => {
  const why =
    "code_reviewer on local (unbound: every runner): fixture: code_review needs structured output; other: not certified here";
  stubFetch({
    [DETAIL]: detail([
      gateView({
        id: "cr1",
        kind: "code_review",
        state: "failed",
        reason: "no_reviewer",
        evidence: {
          reason: "no_reviewer",
          detail: why,
          considered: {
            role: "code_reviewer",
            executor_id: "local",
            bound: false,
            runners: [
              { runner_id: "fixture", why: ["needs_output_schema"] },
              { runner_id: "other", why: ["not_certified"] },
            ],
          },
        },
      }),
    ]),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const code = await card("code_review");
  expect(within(code).getByText("Failed (no reviewer)")).toBeTruthy();
  expect(within(code).getByText(why)).toBeTruthy();
});

test("failed (superseded) and a reviewer error read apart from a findings failure", async () => {
  stubFetch({
    [DETAIL]: detail([
      gateView({
        id: "pr1",
        kind: "plan_review",
        state: "failed",
        reason: "blocking_findings",
        evidence: evidence({ reason: "blocking_findings" }),
      }),
      gateView({
        id: "cr1",
        kind: "code_review",
        state: "failed",
        reason: "superseded",
        evidence: { reason: "superseded" },
      }),
      gateView({
        id: "ce1",
        kind: "ce_review",
        state: "failed",
        reason: "reviewer_error",
        evidence: evidence({ exit_code: 1, reason: "reviewer_error" }),
      }),
    ]),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const badge = async (gate: string, text: string) =>
    within(await card(gate)).getByText(text).dataset.tone;
  // Three tones (status.ts): the findings are the code's failure, the reviewer's own failure wants
  // a look, and a round the ticket moved past is neither.
  expect(await badge("plan_review", "Failed (blocking findings)")).toBe(
    "danger",
  );
  expect(await badge("code_review", "Failed (superseded)")).toBe("neutral");
  expect(await badge("ce_review", "Failed (reviewer error)")).toBe("warning");
  expect(
    within(await card("ce_review")).getByText(/Not a finding\./),
  ).toBeTruthy();
  expect(
    within(await card("code_review")).getByText(
      "The ticket moved on while the review ran.",
    ),
  ).toBeTruthy();
});

test("a waived gate shows its reason for good, and offers nothing more", async () => {
  stubFetch({
    [DETAIL]: detail([
      gateView({
        id: "cr1",
        kind: "code_review",
        state: "failed",
        reason: "reviewer_error",
      }),
      gateView({
        id: "cr2",
        kind: "code_review",
        attempt: 2,
        state: "waived",
        waive_reason: "reviewer flaked twice; checked by hand",
      }),
    ]),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const code = await card("code_review");
  expect(within(code).getByText("Waived")).toBeTruthy();
  expect(
    within(code).getByText("Waived: reviewer flaked twice; checked by hand"),
  ).toBeTruthy();
  expect(within(code).getByText("#1 failed (reviewer error)")).toBeTruthy();
  expect(within(code).queryByRole("button")).toBeNull();
});

test("waiving a gate needs a reason; it then posts it and the ticket refetches", async () => {
  let state = "failed";
  const WAIVE = "/api/v1/gates/g1/waive";
  const gate = () =>
    gateView({
      id: "g1",
      kind: "code_review",
      state,
      reason: state === "failed" ? "blocking_findings" : null,
      waive_reason: state === "waived" ? "accepted risk" : null,
    });
  const fetchMock = stubFetch({
    [DETAIL]: () => detail([gate()]),
    [WAIVE]: () => {
      state = "waived";
      return gate();
    },
  });
  const user = userEvent.setup();
  renderWithProviders(<TicketScreen num={812} />);
  await user.click(
    within(await card("code_review")).getByRole("button", { name: "Waive" }),
  );
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Waive gate" }));
  expect(within(dialog).getByRole("alert").textContent).toBe(
    "Give a reason of 1 to 500 characters.",
  );
  expect(callsTo(fetchMock, WAIVE, "POST")).toHaveLength(0);

  await user.type(within(dialog).getByLabelText("Reason"), "accepted risk");
  await user.click(within(dialog).getByRole("button", { name: "Waive gate" }));
  await waitFor(() =>
    expect(bodyOf(fetchMock, WAIVE, "POST")).toEqual({
      reason: "accepted risk",
    }),
  );
  expect(
    await within(await card("code_review")).findByText("Waived: accepted risk"),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  // The dialog closes, so a toast says what happened.
  expect(
    await screen.findByRole("status", { name: "Waived code_review #1" }),
  ).toBeTruthy();
});

test("a rerun posts, and the ticket refetches with the next attempt", async () => {
  let reran = false;
  const RUN = "/api/v1/gates/g1/run";
  const first = gateView({
    id: "g1",
    kind: "code_review",
    state: "failed",
    reason: "base_drift",
  });
  const fetchMock = stubFetch({
    [DETAIL]: () =>
      detail(
        reran
          ? [
              first,
              gateView({
                id: "g2",
                kind: "code_review",
                attempt: 2,
                state: "running",
              }),
            ]
          : [first],
      ),
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
  renderWithProviders(<TicketScreen num={812} />);
  expect(
    within(await card("code_review")).getByText(
      "The base moved under the review.",
    ),
  ).toBeTruthy();
  await user.click(
    within(await card("code_review")).getByRole("button", { name: "Rerun" }),
  );
  expect(
    await within(await card("code_review")).findByText("attempt 2"),
  ).toBeTruthy();
  expect(callsTo(fetchMock, RUN, "POST")).toHaveLength(1);
  expect(
    within(await card("code_review")).getByText("#1 failed (base drift)"),
  ).toBeTruthy();
  expect(
    await screen.findByRole("status", { name: "Rerunning code_review #1" }),
  ).toBeTruthy();
});

test("a 409 on rerun says the gate moved on and refetches the ticket", async () => {
  let moved = false;
  const fetchMock = stubFetch({
    [DETAIL]: () =>
      detail([
        gateView({
          id: "g1",
          kind: "code_review",
          state: moved ? "waived" : "failed",
          reason: moved ? null : "blocking_findings",
          waive_reason: moved ? "waived elsewhere" : null,
        }),
      ]),
    "/api/v1/gates/g1/run": () => {
      moved = true;
      return apiError(409, "conflict", "gate g1 is waived, not failed");
    },
  });
  const user = userEvent.setup();
  renderWithProviders(<TicketScreen num={812} />);
  await user.click(
    within(await card("code_review")).getByRole("button", { name: "Rerun" }),
  );
  expect(
    await screen.findByText(
      /code_review #1 changed before your write arrived \(gate g1 is waived, not failed\)/,
    ),
  ).toBeTruthy();
  expect(
    await within(await card("code_review")).findByText(
      "Waived: waived elsewhere",
    ),
  ).toBeTruthy();
  expect(callsTo(fetchMock, DETAIL).length).toBeGreaterThanOrEqual(2);
});

test("a rerun the laws refuse (422) says why beside the button", async () => {
  stubFetch({
    [DETAIL]: detail([
      gateView({
        id: "g1",
        kind: "code_review",
        state: "failed",
        reason: "reviewer_error",
      }),
    ]),
    "/api/v1/gates/g1/run": () =>
      apiError(422, "law_refused", "the ticket is not in code_review"),
  });
  const user = userEvent.setup();
  renderWithProviders(<TicketScreen num={812} />);
  const code = await card("code_review");
  await user.click(within(code).getByRole("button", { name: "Rerun" }));
  expect((await within(code).findByRole("alert")).textContent).toBe(
    "the ticket is not in code_review",
  );
});

test("a gates frame naming this ticket refetches it, so the live reviewer's link appears", async () => {
  let sessionId: string | null = null;
  const fetchMock = stubFetch({
    [DETAIL]: () =>
      detail([
        gateView({
          id: "g1",
          kind: "code_review",
          state: "running",
          session_id: sessionId,
        }),
      ]),
  });
  const { feed, pushGates } = pushFeed();
  renderWithProviders(<TicketScreen num={812} />, { feed });
  expect(
    within(await card("code_review")).queryByRole("link", {
      name: "live reviewer",
    }),
  ).toBeNull();
  pushGates(
    gatesPage([
      gateSummary({ id: "g9", kind: "code_review" }, gateTicket(999)),
    ]),
  );
  sessionId = "S-live";
  pushGates(
    gatesPage([
      gateSummary(
        { id: "g1", kind: "code_review", session_id: "S-live" },
        gateTicket(812),
      ),
    ]),
  );
  expect(
    await within(await card("code_review")).findByRole("link", {
      name: "live reviewer",
    }),
  ).toBeTruthy();
  expect(callsTo(fetchMock, DETAIL)).toHaveLength(2);
});

test("a gates frame that moves a gate on this ticket is announced in a polite live region", async () => {
  let decided = false;
  stubFetch({
    [DETAIL]: () =>
      detail([
        gateView({
          id: "g1",
          kind: "code_review",
          ...(decided
            ? { state: "failed", reason: "timeout" }
            : { state: "running" }),
        }),
      ]),
  });
  const { feed, pushGates } = pushFeed();
  renderWithProviders(<TicketScreen num={812} />, { feed });
  await card("code_review");
  const status = within(
    screen.getByRole("region", { name: "gates" }),
  ).getByRole("status");
  expect(status.getAttribute("aria-live")).toBe("polite");
  expect(status.textContent).toBe("");
  decided = true;
  pushGates(
    gatesPage([
      gateSummary(
        { id: "g1", kind: "code_review", state: "failed", reason: "timeout" },
        gateTicket(812),
      ),
    ]),
  );
  await waitFor(() =>
    expect(status.textContent).toBe("code_review: #1 failed (timeout)."),
  );
});
