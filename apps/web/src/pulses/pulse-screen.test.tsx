import type { PulseState } from "@bayon/proto";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { PulseScreen } from "@/pulses/pulse-screen";
import { T0, pulseCheck, pulseDetail, pulseView } from "@/test/pulse-fixtures";
import { pushFeed } from "@/test/push-feed";
import { renderWithProviders, stubFetch } from "@/test/render";

const DETAIL = "/api/v1/pulses/P-1";

test("the detail shows the context pack, the checks and their trust, the summary, the actions and the cost", async () => {
  stubFetch({
    [DETAIL]: pulseDetail(
      pulseView({
        id: "P-1",
        session_id: "s-9",
        context_pack_path: "/frm/runtime/pulses/P-1/context.md",
        context_tokens: 5_100,
        summary_md: "Staffed **#812**.",
        actions: ["staffed #812", "filed #813", "staffed #812"],
        cost_usd: 0.42,
        started_at: T0,
        ended_at: T0 + 60_000,
      }),
      [
        pulseCheck({ name: "stale_sessions" }),
        pulseCheck({
          name: "log_scan",
          result: { untrusted: true, lines: [] },
          result_path: "/frm/runtime/pulses/P-1/log_scan.json",
        }),
        pulseCheck({
          name: "merged_prs",
          state: "error",
          result: null,
          error: "gh: not logged in",
        }),
      ],
    ),
  });
  renderWithProviders(<PulseScreen pulseId="P-1" />);
  expect(await screen.findByRole("heading", { name: "Pulse" })).toBeTruthy();
  // Its id beside the title, copyable.
  expect(
    screen.getByRole("button", { name: "Copy the pulse id" }),
  ).toBeTruthy();
  expect(screen.getByText("Cron trigger")).toBeTruthy();

  const facts = screen.getByRole("region", { name: "facts" });
  expect(
    within(facts).getByText("/frm/runtime/pulses/P-1/context.md"),
  ).toBeTruthy();
  expect(within(facts).getByText("5,100")).toBeTruthy();
  expect(within(facts).getByText("$0.42")).toBeTruthy();
  expect(
    within(facts).getByRole("link", { name: "s-9" }).getAttribute("href"),
  ).toBe("#/sessions/s-9");
  expect(
    within(screen.getByRole("region", { name: "summary" })).getByText("#812"),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "actions" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual(["staffed #812", "filed #813", "staffed #812"]);

  const checksPanel = within(screen.getByRole("region", { name: "checks" }));
  expect(
    checksPanel.getAllByRole("columnheader").map((th) => th.textContent),
  ).toEqual(["probe", "state", "ms", "trust", "where"]);
  const checks = checksPanel.getAllByRole("row").slice(1);
  expect(checks.map((row) => row.textContent)).toEqual([
    expect.stringMatching(/^stale_sessionsOk3Trusted/),
    expect.stringMatching(/^log_scanOk3Untrusted.*log_scan\.json$/),
    expect.stringMatching(/^merged_prsError3—gh: not logged in$/),
  ]);
});

test("a rate-capped skip says why, and that no session ran", async () => {
  stubFetch({
    [DETAIL]: pulseDetail(
      pulseView({ id: "P-1", state: "skipped", skip_reason: "rate_capped" }),
    ),
  });
  renderWithProviders(<PulseScreen pulseId="P-1" />);
  const skipped = await screen.findByText("Skipped (rate capped)");
  // The per-hour guard firing wants a look.
  expect(skipped.dataset.tone).toBe("warning");
  expect(screen.getByText("Skipped: no session ran.")).toBeTruthy();
  expect(screen.getByText("No probe ran for this pulse.")).toBeTruthy();
  expect(screen.getByText("No actions.")).toBeTruthy();
});

test("an unknown pulse shows the server's error", async () => {
  stubFetch({});
  renderWithProviders(<PulseScreen pulseId="P-1" />);
  expect((await screen.findByRole("alert")).textContent).toContain("/api/v1/");
});

test("a pulses frame refetches the open pulse", async () => {
  let state: PulseState = "running";
  stubFetch({ [DETAIL]: () => pulseDetail(pulseView({ id: "P-1", state })) });
  const { feed, pushPulses } = pushFeed();
  renderWithProviders(<PulseScreen pulseId="P-1" />, { feed });
  expect(await screen.findByText("Running")).toBeTruthy();
  expect(screen.getByText("Not reported yet.")).toBeTruthy();
  state = "done";
  pushPulses({ items: [pulseView({ id: "P-1", state: "done" })] });
  expect((await screen.findByText("Done")).dataset.tone).toBe("success");
  expect(
    screen.getByText("No pulse_report: the pulse ended without one."),
  ).toBeTruthy();
});
