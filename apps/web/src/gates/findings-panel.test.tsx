import type { FindingView } from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  apiError,
  bodyOf,
  callsTo,
  renderWithProviders,
  stubFetch,
} from "@/test/render";
import {
  finding,
  gateView,
  ticketDetail,
  ticketView,
} from "@/test/ticket-fixtures";
import { TicketScreen } from "@/tickets/ticket-screen";

const DETAIL = "/api/v1/tickets/812";
const RESOLVE = "/api/v1/findings/f1/resolve";
const WAIVE = "/api/v1/findings/f1/waive";
const TICKET = ticketView({ num: 812, status: "review_fix" });

/** The ticket with one finding on a failed code_review, as `current()` has it when fetched. */
const detailWith = (current: () => FindingView) => () =>
  ticketDetail(TICKET, {
    gates: [
      gateView({
        kind: "code_review",
        state: "failed",
        reason: "blocking_findings",
        findings_total: 1,
        findings_unresolved: current().status === "open" ? 1 : 0,
        findings: [current()],
      }),
    ],
  });

const OPEN = finding({
  id: "f1",
  summary: "idempotency guard missing",
  file: "src/transfer.ts",
  line: 42,
});

const findingsRegion = () => screen.getByRole("region", { name: "findings" });

async function openDialog(trigger: "Resolve" | "Waive") {
  const user = userEvent.setup();
  renderWithProviders(<TicketScreen num={812} />);
  const region = await screen.findByRole("region", { name: "findings" });
  await user.click(within(region).getByRole("button", { name: trigger }));
  return { user, dialog: await screen.findByRole("dialog") };
}

test("each finding shows its severity, place and gate attempt", async () => {
  stubFetch({ [DETAIL]: detailWith(() => OPEN) });
  renderWithProviders(<TicketScreen num={812} />);
  const region = await screen.findByRole("region", { name: "findings" });
  const [, row] = within(region).getAllByRole("row");
  expect(row?.textContent).toMatch(
    /^majoridempotency guard missingsrc\/transfer\.ts:42code_review #1open/,
  );
});

test("resolving needs the fixing run and a note; then it posts both and the ticket refetches", async () => {
  let current = OPEN;
  const fetchMock = stubFetch({
    [DETAIL]: detailWith(() => current),
    [RESOLVE]: () => {
      current = {
        ...OPEN,
        status: "resolved",
        resolved_by_run_id: "R-fix",
        resolved_by: "operator",
        resolution_note: "guarded at the inner tx",
      };
      return current;
    },
  });
  const { user, dialog } = await openDialog("Resolve");
  await user.click(
    within(dialog).getByRole("button", { name: "Resolve finding" }),
  );
  expect(within(dialog).getByRole("alert").textContent).toBe(
    "Name the fixing run and write a note of 1 to 500 characters.",
  );
  expect(callsTo(fetchMock, RESOLVE, "POST")).toHaveLength(0);

  await user.type(within(dialog).getByLabelText("Fixing run"), " R-fix ");
  await user.type(
    within(dialog).getByLabelText("Note"),
    "guarded at the inner tx",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Resolve finding" }),
  );
  await waitFor(() =>
    expect(callsTo(fetchMock, RESOLVE, "POST")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, RESOLVE, "POST")).toEqual({
    run_id: "R-fix",
    note: "guarded at the inner tx",
  });
  expect(
    await within(findingsRegion()).findByText(
      "resolved by run R-fix: guarded at the inner tx",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    (await screen.findByRole("status", { name: /^Resolved finding/ }))
      .textContent,
  ).toMatch(/^Resolved finding "/);
});

test("a fixing run on another ticket is refused inside the dialog (422)", async () => {
  stubFetch({
    [DETAIL]: detailWith(() => OPEN),
    [RESOLVE]: () =>
      apiError(422, "law_refused", "run R-9 works ticket-9, not ticket-812"),
  });
  const { user, dialog } = await openDialog("Resolve");
  await user.type(within(dialog).getByLabelText("Fixing run"), "R-9");
  await user.type(within(dialog).getByLabelText("Note"), "fixed elsewhere");
  await user.click(
    within(dialog).getByRole("button", { name: "Resolve finding" }),
  );
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "law_refused: run R-9 works ticket-9, not ticket-812",
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("waiving needs a reason; the reason then stays on the ticket", async () => {
  let current = OPEN;
  const fetchMock = stubFetch({
    [DETAIL]: detailWith(() => current),
    [WAIVE]: () => {
      current = {
        ...OPEN,
        status: "waived",
        waived_by: "operator",
        waive_reason: "known false positive",
      };
      return current;
    },
  });
  const { user, dialog } = await openDialog("Waive");
  await user.type(within(dialog).getByLabelText("Reason"), "   ");
  await user.click(
    within(dialog).getByRole("button", { name: "Waive finding" }),
  );
  expect(within(dialog).getByRole("alert").textContent).toBe(
    "Give a reason of 1 to 500 characters.",
  );
  expect(callsTo(fetchMock, WAIVE, "POST")).toHaveLength(0);

  await user.clear(within(dialog).getByLabelText("Reason"));
  await user.type(
    within(dialog).getByLabelText("Reason"),
    "known false positive",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Waive finding" }),
  );
  await waitFor(() =>
    expect(bodyOf(fetchMock, WAIVE, "POST")).toEqual({
      reason: "known false positive",
    }),
  );
  expect(
    await within(findingsRegion()).findByText(
      "waived by operator: known false positive",
    ),
  ).toBeTruthy();
  expect(
    within(findingsRegion()).queryByRole("button", { name: "Waive" }),
  ).toBeNull();
});

test("a 409 says the finding moved on, closes the dialog and refetches the ticket", async () => {
  let current = OPEN;
  const fetchMock = stubFetch({
    [DETAIL]: detailWith(() => current),
    [WAIVE]: () => {
      current = { ...OPEN, status: "resolved", resolved_by_run_id: "R-7" };
      return apiError(409, "conflict", "finding f1 is resolved, not open");
    },
  });
  const { user, dialog } = await openDialog("Waive");
  await user.type(within(dialog).getByLabelText("Reason"), "not needed");
  await user.click(
    within(dialog).getByRole("button", { name: "Waive finding" }),
  );
  expect(
    await within(findingsRegion()).findByText(
      /changed before your write arrived \(conflict: finding f1 is resolved, not open\)/,
    ),
  ).toBeTruthy();
  expect(
    await within(findingsRegion()).findByText("resolved by run R-7"),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callsTo(fetchMock, DETAIL).length).toBeGreaterThanOrEqual(2);
});
