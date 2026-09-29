import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { ExecutorsScreen } from "@/executors/executors-screen";
import { executorView, executorsView } from "@/test/executor-fixtures";
import { fleet } from "@/test/fixtures";
import {
  apiError,
  callsTo,
  renderWithProviders,
  stubFetch,
} from "@/test/render";
import { commandView } from "@/test/runner-fixtures";

const EXECUTORS = "/api/v1/executors";
const FLEET = "/api/v1/fleet";
const HEALTH = "/api/v1/executors/ctr-lab/health";
const COMMAND = "/api/v1/commands/cmd-9";

const CTR = executorView({
  id: "ctr-lab",
  kind: "container",
  trust: "untrusted",
  egress_policy: "allowlist",
  slots: 2,
  health: "unhealthy",
  health_checked_at: 1_800_000_000_000,
  health_detail: { rtt_ms: 312, failures: ["disk: 12 % free"] },
  config: {
    ssh: { host: "10.0.0.2", user: "op" },
    remote_root: "/home/op/frm",
    network: "frm-internal",
  },
});
const LOCAL = executorView({ id: "local", health_checked_at: null });
const OFF = executorView({ id: "spare", enabled: false, slots: 1 });

const FLEET_ROWS = {
  ...fleet([]),
  slots: [
    { executor_id: "ctr-lab", busy: 1, capacity: 2 },
    { executor_id: "local", busy: 3, capacity: 4 },
  ],
};

test("each executor shows kind, trust, egress, slots in use, health with its detail, and config; the untrusted roles are listed", async () => {
  stubFetch({
    [EXECUTORS]: executorsView([CTR, LOCAL, OFF]),
    [FLEET]: FLEET_ROWS,
  });
  renderWithProviders(<ExecutorsScreen />);
  expect(screen.getByRole("status").textContent).toBe("Loading the executors…");

  const rule = await screen.findByRole("region", { name: "trust rule" });
  expect(
    within(
      within(rule).getByRole("list", { name: "untrusted roles" }),
    ).getByText("investigator"),
  ).toBeTruthy();

  const ctr = screen.getByRole("region", { name: "ctr-lab" });
  const status = within(ctr).getByRole("group", { name: "executor status" });
  expect(within(status).getByText("Unhealthy").dataset.tone).toBe("danger");
  expect(within(status).getByText("Untrusted")).toBeTruthy();
  expect(within(status).getByText("container")).toBeTruthy();
  expect(within(status).getByText("egress allowlist")).toBeTruthy();
  expect(await within(status).findByText("1 of 2 slots in use")).toBeTruthy();
  expect(
    within(ctr).getByText("Health checked 2027-01-15 08:00 UTC."),
  ).toBeTruthy();
  const detail = within(ctr).getByLabelText("Health detail");
  expect(detail.textContent).toBe("rtt_ms312failuresdisk: 12 % free");
  const config = within(ctr).getByLabelText("Config");
  expect(config.textContent).toBe(
    "ssh.host10.0.0.2ssh.useropremote_root/home/op/frmnetworkfrm-internal",
  );

  const local = screen.getByRole("region", { name: "local" });
  expect(within(local).getByText("3 of 4 slots in use")).toBeTruthy();
  expect(within(local).getByText("Trusted")).toBeTruthy();
  expect(within(local).getByText("Health never checked.")).toBeTruthy();
  expect(within(local).getByText("No health detail recorded.")).toBeTruthy();
  expect(
    within(local).getByText("No config, or it does not parse."),
  ).toBeTruthy();

  const off = screen.getByRole("region", { name: "spare" });
  expect(within(off).getByText("Disabled")).toBeTruthy();
  expect(within(off).getByText("0 of 1 slots in use")).toBeTruthy();
  // a disabled one says what that means and names the shell command that undoes it;
  // the GUI never writes a config row itself (§9.5).
  expect(within(off).getByText(/Out of service/).textContent).toContain(
    "frm executor enable spare",
  );
  expect(within(local).queryByText(/Out of service/)).toBeNull();
});

test("a missing untrusted-roles setting is flagged; an empty one says none; slots are unknown without the fleet", async () => {
  stubFetch({
    [EXECUTORS]: executorsView([CTR], null),
    [FLEET]: () => apiError(500, "internal", "fleet down"),
  });
  const { unmount } = renderWithProviders(<ExecutorsScreen />);
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /executors\.untrusted_roles setting is missing/,
  );
  expect(screen.getByText("? of 2 slots in use")).toBeTruthy();
  unmount();

  stubFetch({ [EXECUTORS]: executorsView([CTR], []), [FLEET]: FLEET_ROWS });
  renderWithProviders(<ExecutorsScreen />);
  expect(
    await screen.findByText("No role needs an untrusted executor."),
  ).toBeTruthy();
});

test("check health posts, follows the executor.health command and refreshes the executors when done", async () => {
  let checked = false;
  const fetchMock = stubFetch({
    [EXECUTORS]: () =>
      executorsView([checked ? { ...CTR, health: "healthy" } : CTR]),
    [FLEET]: FLEET_ROWS,
    [HEALTH]: () => {
      checked = true;
      return { command_id: "cmd-9", created: true };
    },
    [COMMAND]: commandView({
      id: "cmd-9",
      type: "executor.health",
      state: "done",
      result: { executor_id: "ctr-lab", health: "healthy" },
    }),
  });
  const user = userEvent.setup();
  renderWithProviders(<ExecutorsScreen />);
  const ctr = await screen.findByRole("region", { name: "ctr-lab" });
  await user.click(within(ctr).getByRole("button", { name: "Check health" }));
  expect(
    await within(ctr).findByText("Health check done: ctr-lab is healthy."),
  ).toBeTruthy();
  expect(callsTo(fetchMock, HEALTH, "POST")).toHaveLength(1);
  const status = within(ctr).getByRole("group", { name: "executor status" });
  expect((await within(status).findByText("Healthy")).dataset.tone).toBe(
    "success",
  );
  await waitFor(() =>
    expect(callsTo(fetchMock, EXECUTORS).length).toBeGreaterThanOrEqual(2),
  );
});

test("a failed health command and a refused one each say so", async () => {
  let refuse = false;
  stubFetch({
    [EXECUTORS]: executorsView([CTR]),
    [FLEET]: FLEET_ROWS,
    [HEALTH]: () =>
      refuse
        ? apiError(404, "not_found", "executor ctr-lab does not exist")
        : { command_id: "cmd-9", created: true },
    [COMMAND]: commandView({
      id: "cmd-9",
      type: "executor.health",
      state: "failed",
      error: { class: "internal", message: "ssh refused", retryable: true },
    }),
  });
  const user = userEvent.setup();
  renderWithProviders(<ExecutorsScreen />);
  const ctr = await screen.findByRole("region", { name: "ctr-lab" });
  const check = within(ctr).getByRole("button", { name: "Check health" });
  await user.click(check);
  expect(
    await within(ctr).findByText("Health check failed: ssh refused."),
  ).toBeTruthy();
  refuse = true;
  await user.click(check);
  expect(
    await within(ctr).findByText("not_found: executor ctr-lab does not exist"),
  ).toBeTruthy();
});

test("no executor says so; a failed read says why", async () => {
  stubFetch({ [EXECUTORS]: executorsView([]), [FLEET]: FLEET_ROWS });
  const { unmount } = renderWithProviders(<ExecutorsScreen />);
  expect(await screen.findByText("No executor registered")).toBeTruthy();
  unmount();
  stubFetch({
    [EXECUTORS]: () => apiError(500, "internal", "db down"),
    [FLEET]: FLEET_ROWS,
  });
  renderWithProviders(<ExecutorsScreen />);
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("The executors are unavailable")).toBeTruthy();
  expect(within(alert).getByText("internal: db down")).toBeTruthy();
});
