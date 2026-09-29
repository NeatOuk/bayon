import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FleetScreen } from "@/fleet/fleet-screen";
import { fleet } from "@/test/fixtures";
import { projectView } from "@/test/project-fixtures";
import { agentPulse, pulseView } from "@/test/pulse-fixtures";
import { pushFeed } from "@/test/push-feed";
import { bodyOf, callsTo, renderWithProviders, stubFetch } from "@/test/render";

const FLEET = "/api/v1/fleet";
const AGENTS = "/api/v1/agents/pulse-policies";
const PROJECTS = "/api/v1/projects";
const RUN = "/api/v1/pulses/run-now";
const MINUTE = 60_000;

const rowOf = (name: string) =>
  screen.getByRole("row", { name: new RegExp(`^${name}`) });

test("the schedule shows each orchestrator's mode and next pulse, with a quiet Run now", async () => {
  const fetchMock = stubFetch({
    [FLEET]: fleet([]),
    [AGENTS]: {
      items: [
        agentPulse({
          agent_id: "orch-1",
          name: "Lloyd",
          next_pulse_at: Date.now() + 41.5 * MINUTE,
        }),
      ],
    },
    [RUN]: { command_id: "C-1", created: true },
  });
  const user = userEvent.setup();
  renderWithProviders(<FleetScreen />);
  const schedule = await screen.findByRole("region", { name: "pulses" });
  await within(schedule).findByRole("table");
  const row = rowOf("Lloyd");
  expect(row.textContent).toContain("Hybrid");
  // Relative in the cell, the absolute time (and what else wakes it) on hover.
  const next = within(row).getByTestId("next-pulse");
  expect(next.textContent).toBe("in 41m");
  expect(next.getAttribute("title")).toMatch(
    / UTC, or sooner on a completion$/,
  );
  expect(
    within(row).getByRole("link", { name: "Lloyd" }).getAttribute("href"),
  ).toBe("#/pulses");

  const run = within(row).getByRole("button", {
    name: "Run a pulse of Lloyd now",
  });
  // Demoted: a row's action, not the screen's.
  expect(run.dataset.variant).toBe("ghost");
  await user.click(run);
  await waitFor(() => expect(callsTo(fetchMock, RUN, "POST")).toHaveLength(1));
  expect(bodyOf(fetchMock, RUN, "POST")).toEqual({ agent_id: "orch-1" });
});

test("a manual and an on_idle orchestrator say what alone wakes them", async () => {
  stubFetch({
    [FLEET]: fleet([]),
    [AGENTS]: {
      items: [
        agentPulse({ agent_id: "a", mode: "manual" }),
        agentPulse({ agent_id: "b", mode: "on_idle" }),
      ],
    },
  });
  renderWithProviders(<FleetScreen />);
  const schedule = await screen.findByRole("region", { name: "pulses" });
  await within(schedule).findByRole("table");
  expect(rowOf("a").textContent).toContain("Only when run");
  expect(rowOf("b").textContent).toContain("On a completion");
});

test("while the fleet is paused, each row says so and Run now is disabled with the reason", async () => {
  const fetchMock = stubFetch({
    [FLEET]: fleet([], { paused: true }),
    [AGENTS]: { items: [agentPulse({ agent_id: "orch-1", name: "Lloyd" })] },
  });
  renderWithProviders(<FleetScreen />);
  const schedule = await screen.findByRole("region", { name: "pulses" });
  await within(schedule).findByRole("table");
  const row = rowOf("Lloyd");
  expect(within(row).getByText("Fleet paused").dataset.tone).toBe("warning");
  const run = within(row).getByRole("button", {
    name: "Run a pulse of Lloyd now",
  }) as HTMLButtonElement;
  expect(run.disabled).toBe(true);
  expect(run.getAttribute("title")).toBe(
    "The fleet is paused: resume it to run a pulse.",
  );
  expect(
    document.getElementById(run.getAttribute("aria-describedby") ?? "")
      ?.textContent,
  ).toBe("The fleet is paused: resume it to run a pulse.");
  expect(callsTo(fetchMock, RUN, "POST")).toHaveLength(0);
});

test("an orchestrator whose project is paused says so; another project's runs on", async () => {
  stubFetch({
    [FLEET]: fleet([]),
    [AGENTS]: {
      items: [
        agentPulse({ agent_id: "orch-docs", name: "docs-orch" }),
        agentPulse({ agent_id: "orch-shop", name: "shop-orch" }),
      ],
    },
    [PROJECTS]: {
      projects: [
        projectView({
          id: "docs",
          name: "docs-site",
          paused: true,
          agents: [
            {
              id: "orch-docs",
              name: "docs-orch",
              kind: "orchestrator",
              runner_id: "runner-a",
              model: null,
              model_id: null,
              enabled: true,
              max_concurrency: 1,
            },
          ],
        }),
      ],
    },
  });
  renderWithProviders(<FleetScreen />);
  const schedule = await screen.findByRole("region", { name: "pulses" });
  await within(schedule).findByRole("table");
  await waitFor(() =>
    expect(within(rowOf("docs-orch")).getByText("Project paused")).toBeTruthy(),
  );
  expect(
    within(rowOf("docs-orch"))
      .getByRole("button", { name: "Run a pulse of docs-orch now" })
      .getAttribute("title"),
  ).toBe("docs-site is paused: resume it to run a pulse.");
  const shop = within(rowOf("shop-orch")).getByRole("button", {
    name: "Run a pulse of shop-orch now",
  }) as HTMLButtonElement;
  expect(shop.disabled).toBe(false);
});

test("a pulses frame refetches the next pulse", async () => {
  let reads = 0;
  stubFetch({
    [FLEET]: fleet([]),
    [AGENTS]: () => {
      reads += 1;
      return { items: [agentPulse({ agent_id: "orch-1" })] };
    },
  });
  const { feed, pushPulses } = pushFeed();
  renderWithProviders(<FleetScreen />, { feed });
  const schedule = await screen.findByRole("region", { name: "pulses" });
  await within(schedule).findByRole("table");
  const before = reads;
  pushPulses({ items: [pulseView({ id: "P-1" })] });
  await waitFor(() => expect(reads).toBe(before + 1));
});

test("with no orchestrator, the schedule's empty state says what one does and where to add it", async () => {
  stubFetch({ [FLEET]: fleet([]), [AGENTS]: { items: [] } });
  renderWithProviders(<FleetScreen />);
  const schedule = await screen.findByRole("region", { name: "pulses" });
  expect(
    await within(schedule).findByText("No orchestrator pulses"),
  ).toBeTruthy();
  expect(
    within(schedule)
      .getByRole("link", { name: "Open the projects" })
      .getAttribute("href"),
  ).toBe("#/projects");
});

test("without a pulse schedule the Fleet still renders, and says why", async () => {
  stubFetch({ [FLEET]: fleet([]) });
  renderWithProviders(<FleetScreen />);
  const alert = await screen.findByRole("alert");
  expect(
    within(alert).getByText("The pulse schedule is unavailable"),
  ).toBeTruthy();
  expect(within(alert).getByText(/^not_found/)).toBeTruthy();
  expect(screen.getByText(/no live sessions/i)).toBeTruthy();
});
