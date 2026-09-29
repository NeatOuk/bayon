import type { HandoffDetail } from "@bayon/proto";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { HandoffChain } from "@/handoffs/handoff-chain";
import { renderWithProviders, stubFetch } from "@/test/render";
import { handoffView } from "@/test/ticket-fixtures";

const T0 = 1_800_000_000_000;

const packet = (id: string): HandoffDetail => ({
  ...handoffView({ id, goal_line: "Guard the transfer" }),
  ticket_id: "ticket-812",
  packet_path: "/frm/worktrees/w1/.foreman/handoff-1.md",
  phase_from: "build",
  phase_to: "build",
  packet_hash: "hash-1",
  tokens_est: 900,
  decisions_md: "- Keep the ledger lock",
  traps_md: "- The retry test is flaky",
  next_steps_md: "1. Add the guard\n2. Test it\n3. Open the PR",
  open_questions_md: null,
  pointers: ["src/transfer.ts:42"],
  facts: {},
});

test("each hand-off shows its reason, sessions, quality and acceptance, in order", () => {
  renderWithProviders(
    <HandoffChain
      handoffs={[
        handoffView({
          id: "h1",
          reason: "phase_change",
          from_session_id: "s1",
          to_session_id: "s2",
          accepted_at: T0,
          goal_line: "Guard the transfer",
        }),
        handoffView({
          id: "h2",
          reason: "context_ceiling",
          from_session_id: "s2",
          quality: "degraded",
        }),
        handoffView({
          id: "h3",
          reason: "operator",
          from_session_id: "s3",
          quality: "writing",
        }),
      ]}
    />,
  );
  const chain = screen.getByRole("region", { name: "hand-offs" });
  const [first, second, third] = within(chain).getAllByRole("listitem");
  expect(first?.textContent).toMatch(/^#1 Phase changes1→s2Full/);
  expect(first?.textContent).toContain("Guard the transfer");
  expect(first?.textContent).not.toContain("not accepted");
  expect(
    within(first ?? chain)
      .getByRole("link", { name: "s2" })
      .getAttribute("href"),
  ).toBe("#/sessions/s2");
  expect(second?.textContent).toMatch(
    /^#2 Context ceilings2→no successorDegradednot accepted/,
  );
  expect(third?.textContent).toMatch(
    /^#3 Operators3→no successorWritingbeing written/,
  );
  // Quality reads by the status map: a degraded packet wants a look, a full one is the good end.
  expect(within(second ?? chain).getByText("Degraded").dataset.tone).toBe(
    "warning",
  );
  expect(within(first ?? chain).getByText("Full").dataset.tone).toBe("success");
});

test("no hand-offs says so", () => {
  renderWithProviders(<HandoffChain handoffs={[]} />);
  expect(screen.getByText("No hand-offs yet.")).toBeTruthy();
});

test("opening a packet reads GET /handoffs/:id and shows its judgement", async () => {
  stubFetch({ "/api/v1/handoffs/h1": packet("h1") });
  const user = userEvent.setup();
  renderWithProviders(<HandoffChain handoffs={[handoffView({ id: "h1" })]} />);
  await user.click(screen.getByRole("button", { name: "packet" }));
  const shown = await screen.findByLabelText("packet h1");
  for (const text of [
    "/frm/worktrees/w1/.foreman/handoff-1.md · ~900 tokens · build → build",
    "Keep the ledger lock",
    "The retry test is flaky",
    "Open the PR",
    "src/transfer.ts:42",
  ])
    expect(shown.textContent).toContain(text);
});

test("a packet that cannot be read says why", async () => {
  stubFetch({});
  const user = userEvent.setup();
  renderWithProviders(<HandoffChain handoffs={[handoffView({ id: "h1" })]} />);
  await user.click(screen.getByRole("button", { name: "packet" }));
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("The packet is unavailable")).toBeTruthy();
  expect(alert.textContent).toMatch(/not_found/);
});
