import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { RunnersScreen } from "@/runners/runners-screen";
import { executorView, executorsView } from "@/test/executor-fixtures";
import {
  apiError,
  bodyOf,
  callsTo,
  renderWithProviders,
  stubFetch,
} from "@/test/render";
import {
  certification,
  commandView,
  runnerView,
  runnersView,
  summary,
} from "@/test/runner-fixtures";

const RUNNERS = "/api/v1/runners";
const EXECUTORS = "/api/v1/executors";
const CONFORMANCE = "/api/v1/runners/runner-a/conformance";
const COMMAND = "/api/v1/commands/cmd-1";

const EXECUTOR_ROWS = executorsView([
  executorView({ id: "ctr-lab", kind: "container", trust: "untrusted" }),
  executorView({ id: "local" }),
]);

const certified = runnerView({
  id: "runner-a",
  certifications: [
    certification(),
    certification({
      executor_id: "ctr-1",
      runner_version: "1.1.0",
      gate_eligible: false,
      passed_at: null,
      decertified_at: 1_800_000_060_000,
      decertified_reason: "runner_version 1.1.0 → 1.2.0",
      summary: summary({
        failed: [9],
        passed: [1, 2],
        na: [],
        certifiable: false,
      }),
    }),
  ],
});

const uncertified = runnerView({
  id: "runner-b",
  kind: "cli",
  version_detected: null,
  enabled: false,
  gate_eligible: false,
  conformance_passed_at: null,
  caps: null,
  certifications: [],
});

test("each runner shows its version, certification, caps and per-test conformance per executor", async () => {
  stubFetch({
    [RUNNERS]: runnersView([certified, uncertified]),
    [EXECUTORS]: EXECUTOR_ROWS,
  });
  renderWithProviders(<RunnersScreen />);
  expect(screen.getByRole("status").textContent).toBe("Loading the runners…");

  const a = await screen.findByRole("region", { name: "runner-a" });
  const aStatus = within(a).getByRole("group", { name: "runner status" });
  expect(within(aStatus).getByText("Certified").dataset.tone).toBe("success");
  expect(within(aStatus).getByText("Gate-eligible")).toBeTruthy();
  expect(within(aStatus).getByText("sdk · adapter-a")).toBeTruthy();
  expect(within(aStatus).getByText("version 1.2.0")).toBeTruthy();
  expect(
    within(aStatus).getByText("unattended allowed since 2027-01-15 08:00 UTC"),
  ).toBeTruthy();
  const capsList = within(a).getByRole("list", { name: "capabilities" });
  expect(within(capsList).getByText("structuredEvents: yes")).toBeTruthy();
  expect(within(capsList).getByText("outputSchema: no")).toBeTruthy();

  const rows = within(
    within(a).getByRole("table", { name: "certifications" }),
  ).getAllByRole("row");
  const local = rows.find((row) => row.textContent?.startsWith("local"));
  const ctr = rows.find((row) => row.textContent?.startsWith("ctr-1"));
  if (local === undefined || ctr === undefined) throw new Error("no rows");
  // Each certificate is for one model: the row names it.
  expect(within(local).getByText("model-small")).toBeTruthy();
  expect(within(local).getByText("runner-a.cheap")).toBeTruthy();
  expect(within(local).getByText("9 no_terminal_event*: pass")).toBeTruthy();
  expect(within(local).getByText("12 permission_mapping: n/a")).toBeTruthy();
  expect(
    within(local).getByText(/declared, unverified: hooks, pty/),
  ).toBeTruthy();
  expect(
    within(local).getByText("/frm/docs/conformance/runner-a@local.md"),
  ).toBeTruthy();
  expect(within(ctr).getByText("Decertified").dataset.tone).toBe("danger");
  expect(
    within(ctr).getByText(/runner_version 1\.1\.0 → 1\.2\.0/),
  ).toBeTruthy();
  expect(within(ctr).getByText("9 no_terminal_event*: fail")).toBeTruthy();
  expect(within(ctr).getByText("3 multi_turn: not run")).toBeTruthy();
  expect(within(ctr).getByText(/not a certifiable run/)).toBeTruthy();

  const b = screen.getByRole("region", { name: "runner-b" });
  const bStatus = within(b).getByRole("group", { name: "runner status" });
  expect(within(bStatus).getByText("Uncertified").dataset.tone).toBe("warning");
  expect(within(bStatus).getByText("Not gate-eligible")).toBeTruthy();
  expect(within(bStatus).getByText("Disabled")).toBeTruthy();
  expect(within(bStatus).getByText("version not detected")).toBeTruthy();
  expect(within(b).getByText(/do not parse: none are assumed/)).toBeTruthy();
  expect(within(b).getByText(/uncertified everywhere/)).toBeTruthy();
});

test("an open runner update shows current → latest, its release notes, and Dismiss clears it", async () => {
  const withUpdate = runnerView({
    id: "runner-a",
    update: {
      runner_id: "runner-a",
      current: "0.3.283",
      latest: "0.3.290",
      notes_url: "https://example.com/changelog",
      found_at: 1_800_000_000_000,
    },
  });
  const fetchMock = stubFetch({
    [RUNNERS]: runnersView([withUpdate]),
    [EXECUTORS]: EXECUTOR_ROWS,
    "/api/v1/runners/runner-a/updates/0.3.290/dismiss": {
      runner_id: "runner-a",
      latest: "0.3.290",
    },
  });
  renderWithProviders(<RunnersScreen />);
  const a = await screen.findByRole("region", { name: "runner-a" });
  const banner = within(a).getByRole("group", { name: "update available" });
  expect(banner.textContent).toContain("0.3.283 → 0.3.290");
  expect(
    within(banner)
      .getByRole("link", { name: /Release notes/ })
      .getAttribute("href"),
  ).toBe("https://example.com/changelog");

  await userEvent.click(
    within(banner).getByRole("button", {
      name: "Dismiss the runner-a 0.3.290 update",
    }),
  );
  expect(
    callsTo(
      fetchMock,
      "/api/v1/runners/runner-a/updates/0.3.290/dismiss",
      "POST",
    ),
  ).toHaveLength(1);
});

test("no update: the runner card shows no update banner", async () => {
  stubFetch({
    [RUNNERS]: runnersView([uncertified]),
    [EXECUTORS]: EXECUTOR_ROWS,
  });
  renderWithProviders(<RunnersScreen />);
  const b = await screen.findByRole("region", { name: "runner-b" });
  expect(
    within(b).queryByRole("group", { name: "update available" }),
  ).toBeNull();
});

test("no runner says so; a failed read says why", async () => {
  stubFetch({ [RUNNERS]: runnersView([]), [EXECUTORS]: EXECUTOR_ROWS });
  const { unmount } = renderWithProviders(<RunnersScreen />);
  expect(await screen.findByText("No runner registered")).toBeTruthy();
  unmount();
  stubFetch({
    [RUNNERS]: () => apiError(500, "internal", "db down"),
    [EXECUTORS]: EXECUTOR_ROWS,
  });
  renderWithProviders(<RunnersScreen />);
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("The runners are unavailable")).toBeTruthy();
  expect(within(alert).getByText("internal: db down")).toBeTruthy();
});

test("a failed read retries on asking, and shows the runners once they answer", async () => {
  let fail = true;
  stubFetch({
    [RUNNERS]: () =>
      fail ? apiError(500, "internal", "db down") : runnersView([certified]),
    [EXECUTORS]: EXECUTOR_ROWS,
  });
  renderWithProviders(<RunnersScreen />);
  const alert = await screen.findByRole("alert");
  fail = false;
  await userEvent
    .setup()
    .click(within(alert).getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("region", { name: "runner-a" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBe(null);
});

test("the executor defaults to the last one this runner was certified on, not the first registered", async () => {
  // `ctr-lab` heads GET /executors, and defaulting to it is how a run lands on the
  // executor the operator never meant to use.
  stubFetch({
    [RUNNERS]: runnersView([certified, uncertified]),
    [EXECUTORS]: EXECUTOR_ROWS,
  });
  renderWithProviders(<RunnersScreen />);
  const a = await screen.findByRole("region", { name: "runner-a" });
  await waitFor(() =>
    expect(
      within(a).getByRole("combobox", { name: "Executor" }).textContent,
    ).toContain("local"),
  );
  // Never certified anywhere: a local executor, still not the head of the list.
  const b = screen.getByRole("region", { name: "runner-b" });
  expect(
    within(b).getByRole("combobox", { name: "Executor" }).textContent,
  ).toContain("local");
});

test("the executor is picked from GET /executors; run conformance posts it, follows its command and refreshes the runners", async () => {
  const fetchMock = stubFetch({
    [RUNNERS]: runnersView([certified]),
    [EXECUTORS]: EXECUTOR_ROWS,
    [CONFORMANCE]: { command_id: "cmd-1", created: true },
    [COMMAND]: commandView({
      id: "cmd-1",
      state: "done",
      result: {
        runner_id: "runner-a",
        executor_id: "ctr-lab",
        runner_version: "1.2.0",
        report_path: "/frm/docs/conformance/runner-a@ctr-lab.md",
        stored: true,
        summary: summary(),
      },
    }),
  });
  const user = userEvent.setup();
  renderWithProviders(<RunnersScreen />);
  const a = await screen.findByRole("region", { name: "runner-a" });
  const executor = within(a).getByRole("combobox", { name: "Executor" });
  await waitFor(() => expect(executor.textContent).toContain("local"));
  await user.click(executor);
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["ctr-lab", "local"]);
  await user.click(screen.getByRole("option", { name: "ctr-lab" }));
  await user.click(within(a).getByRole("button", { name: "Run conformance" }));
  await waitFor(() =>
    expect(bodyOf(fetchMock, CONFORMANCE, "POST")).toEqual({
      executor_id: "ctr-lab",
      // The model a role binding runs is offered first.
      model_id: "runner-a.cheap",
    }),
  );
  expect(
    await within(a).findByText(
      "Conformance done on ctr-lab: 12 passed, 0 failed, 2 n/a, 0 incomplete. Certification updated. Report: /frm/docs/conformance/runner-a@ctr-lab.md",
    ),
  ).toBeTruthy();
  await waitFor(() =>
    expect(callsTo(fetchMock, RUNNERS).length).toBeGreaterThanOrEqual(2),
  );
});

test("the model is picked from the runner's models: a bound one first; the pick is posted", async () => {
  const fetchMock = stubFetch({
    [RUNNERS]: runnersView([certified]),
    [EXECUTORS]: EXECUTOR_ROWS,
    [CONFORMANCE]: { command_id: "cmd-1", created: true },
    [COMMAND]: commandView({ id: "cmd-1", state: "claimed" }),
  });
  const user = userEvent.setup();
  renderWithProviders(<RunnersScreen />);
  const a = await screen.findByRole("region", { name: "runner-a" });
  const model = within(a).getByRole("combobox", { name: "Model" });
  await waitFor(() => expect(model.textContent).toContain("runner-a.cheap"));
  await user.click(model);
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["runner-a.cheap", "runner-a.complex"]);
  await user.click(screen.getByRole("option", { name: "runner-a.complex" }));
  await user.click(within(a).getByRole("button", { name: "Run conformance" }));
  await waitFor(() =>
    expect(bodyOf(fetchMock, CONFORMANCE, "POST")).toEqual({
      executor_id: "local",
      model_id: "runner-a.complex",
    }),
  );
});

test("a runner with no active model offers nothing to run", async () => {
  const fetchMock = stubFetch({
    [RUNNERS]: runnersView([{ ...certified, models: [] }]),
    [EXECUTORS]: EXECUTOR_ROWS,
  });
  renderWithProviders(<RunnersScreen />);
  const a = await screen.findByRole("region", { name: "runner-a" });
  expect(within(a).getByText(/registers no active model/)).toBeTruthy();
  expect(within(a).queryByRole("button", { name: "Run conformance" })).toBe(
    null,
  );
  expect(callsTo(fetchMock, CONFORMANCE, "POST")).toHaveLength(0);
});

test("a queued run says how long it has been going and what is ahead of it", async () => {
  // The reported bug: a run behind another looked exactly like a wedged one.
  stubFetch({
    [RUNNERS]: runnersView([certified]),
    [EXECUTORS]: EXECUTOR_ROWS,
    [CONFORMANCE]: { command_id: "cmd-1", created: true },
    [COMMAND]: commandView({
      id: "cmd-1",
      state: "claimed",
      ts: 1_800_000_000_000,
      claimed_at: 1_800_000_000_000,
      now: 1_800_000_030_000,
      ahead: [
        {
          id: "cmd-0",
          ts: 1_799_999_658_000,
          state: "claimed",
          claimed_at: 1_799_999_658_000,
          payload: { runner_id: "runner-a", executor_id: "ctr-lab" },
        },
      ],
    }),
  });
  const user = userEvent.setup();
  renderWithProviders(<RunnersScreen />);
  const a = await screen.findByRole("region", { name: "runner-a" });
  await waitFor(() =>
    expect(
      within(a).getByRole("combobox", { name: "Executor" }).textContent,
    ).toContain("local"),
  );
  await user.click(within(a).getByRole("button", { name: "Run conformance" }));
  expect(
    await within(a).findByText(
      "Conformance queued 30s ago, waiting behind 1 other conformance run, on ctr-lab, going 6m 12s (command cmd-1).",
    ),
  ).toBeTruthy();
});

test("a failed command and a refused executor each say so", async () => {
  let refuse = false;
  const fetchMock = stubFetch({
    [RUNNERS]: runnersView([certified]),
    [EXECUTORS]: EXECUTOR_ROWS,
    [CONFORMANCE]: () =>
      refuse
        ? apiError(404, "not_found", "executor local does not exist")
        : { command_id: "cmd-1", created: true },
    [COMMAND]: commandView({
      id: "cmd-1",
      state: "failed",
      error: {
        class: "internal",
        message: "the suite crashed",
        retryable: false,
      },
    }),
  });
  const user = userEvent.setup();
  renderWithProviders(<RunnersScreen />);
  const a = await screen.findByRole("region", { name: "runner-a" });
  await waitFor(() =>
    expect(
      within(a).getByRole("combobox", { name: "Executor" }).textContent,
    ).toContain("local"),
  );
  const run = within(a).getByRole("button", { name: "Run conformance" });

  await user.click(run);
  expect(
    await within(a).findByText("Conformance failed: the suite crashed."),
  ).toBeTruthy();

  refuse = true;
  await user.click(run);
  expect((await within(a).findByRole("alert")).textContent).toBe(
    "not_found: executor local does not exist",
  );
  expect(callsTo(fetchMock, CONFORMANCE, "POST")).toHaveLength(2);
});

const NO_EXECUTOR =
  "No enabled executor to run the suite on: add or enable one first (frm executor add | frm executor enable).";

test("with no executor to pick, nothing is posted; an executors read failure says so", async () => {
  const fetchMock = stubFetch({
    [RUNNERS]: runnersView([certified]),
    [EXECUTORS]: executorsView([]),
  });
  const { unmount } = renderWithProviders(<RunnersScreen />);
  const a = await screen.findByRole("region", { name: "runner-a" });
  // Nothing to run it on: the card says what to do rather than offering a button that only fails.
  expect(within(a).getByText(NO_EXECUTOR)).toBeTruthy();
  expect(within(a).queryByRole("button", { name: "Run conformance" })).toBe(
    null,
  );
  expect(callsTo(fetchMock, CONFORMANCE, "POST")).toHaveLength(0);
  unmount();

  stubFetch({
    [RUNNERS]: runnersView([certified]),
    [EXECUTORS]: () => apiError(500, "internal", "db down"),
  });
  renderWithProviders(<RunnersScreen />);
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("The executors are unavailable")).toBeTruthy();
  expect(within(alert).getByText("internal: db down")).toBeTruthy();
});

test("a disabled executor is not offered to run the suite on", async () => {
  // The server refuses a conformance run on a disabled executor, as admission refuses a spawn on
  // one. Listing it would offer the operator a choice the server takes back.
  stubFetch({
    [RUNNERS]: runnersView([certified]),
    [EXECUTORS]: executorsView([
      executorView({ id: "ctr-lab", kind: "container", enabled: false }),
      executorView({ id: "local" }),
    ]),
  });
  const user = userEvent.setup();
  const { unmount } = renderWithProviders(<RunnersScreen />);
  const a = await screen.findByRole("region", { name: "runner-a" });
  const executor = within(a).getByRole("combobox", { name: "Executor" });
  await waitFor(() => expect(executor.textContent).toContain("local"));
  await user.click(executor);
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["local"]);
  unmount();

  // Every executor disabled reads the same as none at all: there is nothing to certify on.
  stubFetch({
    [RUNNERS]: runnersView([certified]),
    [EXECUTORS]: executorsView([executorView({ id: "local", enabled: false })]),
  });
  renderWithProviders(<RunnersScreen />);
  const b = await screen.findByRole("region", { name: "runner-a" });
  expect(within(b).getByText(NO_EXECUTOR)).toBeTruthy();
});

test("with no runner registered, Check again asks the server again", async () => {
  let reads = 0;
  stubFetch({
    [RUNNERS]: () => {
      reads += 1;
      return { runners: [] };
    },
    [EXECUTORS]: EXECUTOR_ROWS,
  });
  renderWithProviders(<RunnersScreen />);
  expect(await screen.findByText("No runner registered")).toBeTruthy();
  const before = reads;
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(reads).toBe(before + 1));
});
