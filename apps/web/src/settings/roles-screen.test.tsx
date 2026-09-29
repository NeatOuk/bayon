import type { RoleBindingView } from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { bindingRequest, formOf } from "@/settings/role-binding-dialog";
import { RolesScreen } from "@/settings/roles-screen";
import { executorView, executorsView } from "@/test/executor-fixtures";
import {
  apiError,
  bodyOf,
  callsTo,
  renderWithProviders,
  stubFetch,
} from "@/test/render";
import { certification, runnerView, runnersView } from "@/test/runner-fixtures";

const BINDINGS = "/api/v1/role-bindings";
const RUNNERS = "/api/v1/runners";
const EXECUTORS = "/api/v1/executors";

const binding = (
  o: Partial<RoleBindingView> & Pick<RoleBindingView, "role" | "runner_id">,
): RoleBindingView => ({
  model_tier: null,
  executor_id: null,
  profile_id: null,
  fallback_runner_id: null,
  require_distinct_from: null,
  updated_by: "operator",
  updated_at: 1_800_000_000_000,
  model_id: null,
  model: null,
  ...o,
});

const RUNNER_ROWS = runnersView([
  runnerView({ id: "runner-a" }),
  runnerView({
    id: "runner-b",
    gate_eligible: false,
    conformance_passed_at: null,
    certifications: [],
  }),
]);

const EXECUTOR_ROWS = executorsView([
  executorView({ id: "ctr-lab", kind: "container", trust: "untrusted" }),
  executorView({ id: "local" }),
]);

const row = (role: string) => screen.getByRole("row", { name: role });

test("every role is listed: bound ones with their runner's certification, unbound ones as such", async () => {
  stubFetch({
    [BINDINGS]: {
      items: [
        binding({
          role: "builder",
          runner_id: "runner-a",
          model_tier: "cheap",
          model_id: "runner-a.cheap",
          model: "model-small",
        }),
        binding({
          role: "code_reviewer",
          runner_id: "runner-b",
          executor_id: "ctr-1",
          fallback_runner_id: "runner-a",
          require_distinct_from: "builder",
        }),
        binding({ role: "plan_reviewer", runner_id: "gone-runner" }),
      ],
    },
    [RUNNERS]: RUNNER_ROWS,
    [EXECUTORS]: EXECUTOR_ROWS,
  });
  renderWithProviders(<RolesScreen />);
  expect(screen.getByRole("status").textContent).toBe(
    "Loading the role bindings…",
  );
  await screen.findByRole("table", { name: "role bindings" });

  const builder = row("builder");
  expect(within(builder).getByText("runner-a")).toBeTruthy();
  expect(await within(builder).findByText("Certified")).toBeTruthy();
  expect(within(builder).getByText("cheap")).toBeTruthy();
  expect(within(builder).getByText("model-small")).toBeTruthy();
  expect(
    within(builder).getByText("2027-01-15 08:00 UTC by operator"),
  ).toBeTruthy();
  expect(
    within(builder).getByRole("button", { name: "Bind builder" }).textContent,
  ).toBe("Edit");

  const reviewer = row("code_reviewer");
  expect(within(reviewer).getByText("Uncertified")).toBeTruthy();
  // No tier and no profile of its own: each agent's profile decides the model.
  expect(within(reviewer).getByText("each agent's profile")).toBeTruthy();
  expect(within(reviewer).getByText("ctr-1")).toBeTruthy();
  expect(within(reviewer).getByText("builder")).toBeTruthy();

  expect(
    within(row("plan_reviewer")).getByText("Unknown runner").dataset.tone,
  ).toBe("danger");
  const qa = row("qa");
  expect(within(qa).getByText("unbound")).toBeTruthy();
  expect(within(qa).getByRole("button", { name: "Bind qa" }).textContent).toBe(
    "Bind",
  );
  for (const role of ["orchestrator", "investigator", "util"])
    expect(row(role)).toBeTruthy();
});

test("the badge is the certificate of the binding's own model: another model's does not count", async () => {
  stubFetch({
    [BINDINGS]: {
      items: [
        // runner-a is certified on its cheap model alone (the fixture's certificate).
        binding({
          role: "code_reviewer",
          runner_id: "runner-a",
          model_tier: "complex",
          model_id: "runner-a.complex",
          model: "model-large",
        }),
        binding({
          role: "builder",
          runner_id: "runner-a",
          executor_id: "ctr-lab",
          model_tier: "cheap",
          model_id: "runner-a.cheap",
          model: "model-small",
        }),
      ],
    },
    [RUNNERS]: RUNNER_ROWS,
    [EXECUTORS]: EXECUTOR_ROWS,
  });
  renderWithProviders(<RolesScreen />);
  await screen.findByRole("table", { name: "role bindings" });
  const reviewer = row("code_reviewer");
  expect(await within(reviewer).findByText("Uncertified")).toBeTruthy();
  expect(within(reviewer).getByText("model-large")).toBeTruthy();
  // The right model, but certified on local, not on the executor the binding names.
  expect(within(row("builder")).getByText("Uncertified")).toBeTruthy();
});

test("rebinding a role puts the whole binding, then the list refetches", async () => {
  let saved = false;
  const fetchMock = stubFetch({
    [BINDINGS]: (init: RequestInit | undefined) =>
      init?.method === "PUT"
        ? ((saved = true),
          binding({ role: "code_reviewer", runner_id: "runner-a" }))
        : {
            items: [
              binding({
                role: "code_reviewer",
                runner_id: saved ? "runner-a" : "runner-b",
                model_tier: "complex",
                executor_id: "ctr-lab",
                fallback_runner_id: "runner-a",
                require_distinct_from: "builder",
                model_id: saved ? "runner-a.complex" : "runner-b.complex",
                model: "model-large",
              }),
            ],
          },
    // runner-a is certified on its complex model on ctr-lab: the binding's own triple.
    [RUNNERS]: runnersView([
      runnerView({
        id: "runner-a",
        certifications: [
          certification({
            executor_id: "ctr-lab",
            model_id: "runner-a.complex",
            model: "model-large",
          }),
        ],
      }),
      ...RUNNER_ROWS.runners.slice(1),
    ]),
    [EXECUTORS]: EXECUTOR_ROWS,
  });
  const user = userEvent.setup();
  renderWithProviders(<RolesScreen />);
  await screen.findByRole("table", { name: "role bindings" });
  expect(
    await within(row("code_reviewer")).findByText("Uncertified"),
  ).toBeTruthy();
  await user.click(
    within(row("code_reviewer")).getByRole("button", {
      name: "Bind code_reviewer",
    }),
  );
  const dialog = await screen.findByRole("dialog");
  // runner-a is the fallback too: picking it as the runner clears the fallback.
  await user.click(within(dialog).getByRole("combobox", { name: "Runner" }));
  await user.click(await screen.findByRole("option", { name: "runner-a" }));
  await user.click(
    within(dialog).getByRole("button", { name: "Save binding" }),
  );

  await waitFor(() =>
    expect(bodyOf(fetchMock, BINDINGS, "PUT")).toEqual({
      role: "code_reviewer",
      runner_id: "runner-a",
      model_tier: "complex",
      executor_id: "ctr-lab",
      profile_id: null,
      fallback_runner_id: null,
      require_distinct_from: "builder",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    await screen.findByRole("status", {
      name: "code_reviewer bound to runner-a",
    }),
  ).toBeTruthy();
  expect(
    await within(row("code_reviewer")).findByText("Certified"),
  ).toBeTruthy();
  expect(callsTo(fetchMock, BINDINGS).length).toBeGreaterThanOrEqual(2);
});

test("the executor is picked from GET /executors, or left to its default", async () => {
  const fetchMock = stubFetch({
    [BINDINGS]: (init: RequestInit | undefined) =>
      init?.method === "PUT"
        ? binding({ role: "builder", runner_id: "runner-a" })
        : { items: [binding({ role: "builder", runner_id: "runner-a" })] },
    [RUNNERS]: RUNNER_ROWS,
    [EXECUTORS]: EXECUTOR_ROWS,
  });
  const user = userEvent.setup();
  renderWithProviders(<RolesScreen />);
  await screen.findByRole("table", { name: "role bindings" });
  await user.click(
    within(row("builder")).getByRole("button", { name: "Bind builder" }),
  );
  const dialog = await screen.findByRole("dialog");
  const executor = within(dialog).getByRole("combobox", { name: "Executor" });
  expect(executor.textContent).toContain("default");
  await user.click(executor);
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["default", "ctr-lab", "local"]);
  await user.click(screen.getByRole("option", { name: "local" }));
  await user.click(
    within(dialog).getByRole("button", { name: "Save binding" }),
  );
  await waitFor(() =>
    expect(bodyOf(fetchMock, BINDINGS, "PUT")).toMatchObject({
      role: "builder",
      runner_id: "runner-a",
      executor_id: "local",
    }),
  );
});

test("a refused binding stays in the dialog with the server's reason; no runner is not sent", async () => {
  const fetchMock = stubFetch({
    [BINDINGS]: (init: RequestInit | undefined) =>
      init?.method === "PUT"
        ? apiError(404, "not_found", "profile nope does not exist")
        : { items: [] },
    [RUNNERS]: RUNNER_ROWS,
    [EXECUTORS]: EXECUTOR_ROWS,
  });
  const user = userEvent.setup();
  renderWithProviders(<RolesScreen />);
  await screen.findByRole("table", { name: "role bindings" });
  await user.click(within(row("qa")).getByRole("button", { name: "Bind qa" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(
    within(dialog).getByRole("button", { name: "Save binding" }),
  );
  expect(within(dialog).getByRole("alert").textContent).toBe(
    "Pick a runner; typed ids are 1 to 64 characters.",
  );
  expect(callsTo(fetchMock, BINDINGS, "PUT")).toHaveLength(0);

  await user.click(within(dialog).getByRole("combobox", { name: "Runner" }));
  await user.click(await screen.findByRole("option", { name: "runner-b" }));
  await user.type(within(dialog).getByLabelText("Profile"), "nope");
  await user.click(
    within(dialog).getByRole("button", { name: "Save binding" }),
  );
  expect(
    await within(dialog).findByText("not_found: profile nope does not exist"),
  ).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("a failed read of the bindings or of the executors says so", async () => {
  stubFetch({
    [BINDINGS]: () => apiError(500, "internal", "db down"),
    [RUNNERS]: RUNNER_ROWS,
    [EXECUTORS]: () => apiError(500, "internal", "no executors"),
  });
  renderWithProviders(<RolesScreen />);
  expect(
    await screen.findByText("The role bindings are unavailable"),
  ).toBeTruthy();
  expect(await screen.findByText("The executors are unavailable")).toBeTruthy();
  expect(screen.getByText("internal: db down")).toBeTruthy();
  expect(screen.getByText("internal: no executors")).toBeTruthy();
});

test("the request trims the typed profile to null when blank and refuses a missing runner", () => {
  const form = formOf(binding({ role: "builder", runner_id: "runner-a" }));
  expect(bindingRequest("builder", { ...form, profile_id: "  " })).toEqual({
    role: "builder",
    runner_id: "runner-a",
    model_tier: null,
    executor_id: null,
    profile_id: null,
    fallback_runner_id: null,
    require_distinct_from: null,
  });
  expect(bindingRequest("builder", { ...form, runner_id: null })).toBeNull();
  expect(
    bindingRequest("builder", { ...form, profile_id: "x".repeat(65) }),
  ).toBeNull();
});
