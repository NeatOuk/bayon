import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { PulsesScreen } from "@/pulses/pulses-screen";
import { T0, agentPulse, pulseView } from "@/test/pulse-fixtures";
import { pushFeed } from "@/test/push-feed";
import { commandView } from "@/test/runner-fixtures";
import {
  apiError,
  bodyOf,
  callsTo,
  renderWithProviders,
  stubFetch,
} from "@/test/render";

const LIST = "/api/v1/pulses";
const AGENTS = "/api/v1/agents/pulse-policies";
const RUN = "/api/v1/pulses/run-now";
const POLICY = "/api/v1/agents/orch-1/pulse-policy";
const COMMAND = "/api/v1/commands/C-1";
const MINUTE = 60_000;

// Half a minute past the whole, so the few ms before the read lands never change the rounding.
const lloyd = () =>
  agentPulse({
    agent_id: "orch-1",
    name: "Lloyd",
    next_pulse_at: Date.now() + 41.5 * MINUTE,
  });

const rowsOf = (region: HTMLElement) =>
  within(region).getAllByRole("row").slice(1);

test("every pulse is listed newest first, a rate-capped skip and a failure among them", async () => {
  stubFetch({
    [AGENTS]: { items: [lloyd()] },
    [LIST]: {
      items: [
        pulseView({ id: "P-3", scheduled_at: T0 + 3, state: "failed" }),
        pulseView({
          id: "P-2",
          scheduled_at: T0 + 2,
          state: "skipped",
          skip_reason: "rate_capped",
        }),
        pulseView({
          id: "P-1",
          scheduled_at: T0 + 1,
          summary_md: "Staffed #812.\nThen waited.",
          cost_usd: 0.12,
          context_tokens: 4_200,
        }),
      ],
    },
  });
  renderWithProviders(<PulsesScreen />);
  const list = await screen.findByRole("region", { name: "pulse list" });
  const rows = rowsOf(list);
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining("Failed"),
    expect.stringContaining("Skipped (rate capped)"),
    expect.stringContaining("Staffed #812."),
  ]);
  // A failure is danger, a rate-capped skip a warning, a done pulse the only green.
  expect(within(list).getByText("Failed").dataset.tone).toBe("danger");
  expect(within(list).getByText("Skipped (rate capped)").dataset.tone).toBe(
    "warning",
  );
  expect(within(list).getByText("Done").dataset.tone).toBe("success");
  expect(rows[2]?.textContent).toContain("4,200");
  expect(rows[2]?.textContent).toContain("$0.12");
  expect(rows[2]?.textContent).not.toContain("Then waited.");
  expect(
    within(rows[0] ?? list)
      .getByRole("link")
      .getAttribute("href"),
  ).toBe("#/pulses/P-3");
  await waitFor(() => expect(rows[0]?.textContent).toContain("Lloyd"));
});

test("no pulses yet, and a failed read, each say so", async () => {
  stubFetch({ [AGENTS]: { items: [] }, [LIST]: { items: [] } });
  const first = renderWithProviders(<PulsesScreen />);
  expect(await screen.findByText("No pulses yet")).toBeTruthy();
  expect(await screen.findByText(/No enabled orchestrator/)).toBeTruthy();
  first.unmount();

  stubFetch({
    [AGENTS]: { items: [] },
    [LIST]: () => apiError(500, "internal", "db down"),
  });
  renderWithProviders(<PulsesScreen />);
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("The pulses are unavailable")).toBeTruthy();
  expect(within(alert).getByText("internal: db down")).toBeTruthy();
  expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("an orchestrator shows its mode, next pulse and policy; run-now posts its id and follows its command", async () => {
  const fetchMock = stubFetch({
    [AGENTS]: { items: [lloyd()] },
    [LIST]: { items: [] },
    [RUN]: { command_id: "C-1", created: true },
    [COMMAND]: commandView({
      id: "C-1",
      type: "pulse.run",
      state: "done",
      result: { pulse_id: "P-9", outcome: "running" },
    }),
  });
  const user = userEvent.setup();
  renderWithProviders(<PulsesScreen />);
  const row = await screen.findByRole("group", { name: "orchestrator Lloyd" });
  expect(row.textContent).toContain("Hybrid");
  expect(row.textContent).toMatch(
    /next pulse in 41m \(.* UTC, sooner on a completion\)/,
  );
  expect(row.textContent).toContain("every 1h 30m · gap 5m · at most 8/h");

  await user.click(
    within(row).getByRole("button", { name: "Run a pulse of Lloyd now" }),
  );
  await waitFor(() => expect(callsTo(fetchMock, RUN, "POST")).toHaveLength(1));
  expect(bodyOf(fetchMock, RUN, "POST")).toEqual({ agent_id: "orch-1" });
  expect(await within(row).findByText("a pulse is running")).toBeTruthy();
});

test("run-now shows the supervisor's refusal once its command fails", async () => {
  stubFetch({
    [AGENTS]: { items: [lloyd()] },
    [LIST]: { items: [] },
    [RUN]: { command_id: "C-1", created: true },
    [COMMAND]: commandView({
      id: "C-1",
      type: "pulse.run",
      state: "failed",
      error: {
        class: "admission_refused",
        message:
          "refused (fleet_paused): the fleet is paused (fleet.paused=1): no pulse runs until it resumes",
        retryable: true,
      },
    }),
  });
  const user = userEvent.setup();
  renderWithProviders(<PulsesScreen />);
  const row = await screen.findByRole("group", { name: "orchestrator Lloyd" });
  await user.click(
    within(row).getByRole("button", { name: "Run a pulse of Lloyd now" }),
  );
  await waitFor(() =>
    expect(within(row).getByRole("status").textContent).toBe(
      "Not run: refused (fleet_paused): the fleet is paused (fleet.paused=1): no pulse runs until it resumes",
    ),
  );
});

test("a pulses frame updates rows in place and adds new ones, rate-capped skips included", async () => {
  stubFetch({
    [AGENTS]: { items: [] },
    [LIST]: { items: [pulseView({ id: "P-1", state: "running" })] },
  });
  const { feed, pushPulses } = pushFeed();
  renderWithProviders(<PulsesScreen />, { feed });
  const list = await screen.findByRole("region", { name: "pulse list" });
  expect(within(list).getByText("Running")).toBeTruthy();

  pushPulses({
    items: [
      pulseView({
        id: "P-2",
        scheduled_at: T0 + 1,
        state: "skipped",
        skip_reason: "rate_capped",
      }),
      pulseView({ id: "P-1", state: "done" }),
    ],
  });
  const capped = await within(list).findByText("Skipped (rate capped)");
  expect(capped.dataset.tone).toBe("warning");
  expect(rowsOf(list).map((row) => row.textContent)).toEqual([
    expect.stringContaining("Skipped (rate capped)"),
    expect.stringContaining("Done"),
  ]);
  expect(within(list).queryByText("Running")).toBeNull();
});

test("the policy editor sends only what changed, in stored units", async () => {
  const fetchMock = stubFetch({
    [AGENTS]: { items: [lloyd()] },
    [LIST]: { items: [] },
    [POLICY]: {
      ...lloyd(),
      mode: "interval",
      interval_ms: 3_600_000,
    },
  });
  const user = userEvent.setup();
  renderWithProviders(<PulsesScreen />);
  await user.click(await screen.findByRole("button", { name: "Edit policy" }));
  await user.click(screen.getByRole("button", { name: "Interval" }));
  const interval = screen.getByLabelText("Interval (minutes)");
  await user.clear(interval);
  await user.type(interval, "60");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(callsTo(fetchMock, POLICY, "PATCH")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, POLICY, "PATCH")).toEqual({
    mode: "interval",
    interval_ms: 3_600_000,
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    await screen.findByRole("status", {
      name: "Pulse policy saved for Lloyd",
    }),
  ).toBeTruthy();
});

test("the policy editor refuses no change, a blank field and an out-of-range value", async () => {
  const fetchMock = stubFetch({
    [AGENTS]: { items: [lloyd()] },
    [LIST]: { items: [] },
  });
  const user = userEvent.setup();
  renderWithProviders(<PulsesScreen />);
  await user.click(await screen.findByRole("button", { name: "Edit policy" }));
  const save = screen.getByRole("button", { name: "Save" });
  await user.click(save);
  expect(screen.getByRole("alert").textContent).toBe("Nothing changed.");

  const perHour = screen.getByLabelText("Most per hour");
  await user.clear(perHour);
  await user.click(save);
  expect(screen.getByRole("alert").textContent).toBe(
    "Most per hour: enter a number.",
  );

  await user.type(perHour, "0");
  await user.click(save);
  expect(screen.getByRole("alert").textContent).toContain("max_per_hour");
  expect(callsTo(fetchMock, POLICY, "PATCH")).toHaveLength(0);
});
