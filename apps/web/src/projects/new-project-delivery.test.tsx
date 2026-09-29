import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { DELIVERY_CREATE_LABEL } from "@/delivery/delivery-create-section";
import { DELIVERY_SINCE_HINT } from "@/delivery/delivery-fields";
import { NewProjectScreen } from "@/projects/new-project-screen";
import { executorView, executorsView } from "@/test/executor-fixtures";
import { bodyOf, renderWithProviders, stubFetch } from "@/test/render";
import { runnerView, runnersView } from "@/test/runner-fixtures";

// New project's Delivery section: off by default — a project nobody asked to deliver
// makes no network write at all — and, when it is on, the request carries the same two fields
// `PATCH /projects/:id` would take.

const RUNNERS = "/api/v1/runners";
const EXECUTORS = "/api/v1/executors";
const CREATE = "/api/v1/projects";

const CREATED = {
  repo_id: "demo",
  workspace_id: "demo",
  builder_agent_id: "demo-builder",
  orchestrator_agent_id: "demo-orchestrator",
  reviewer_agent_id: "demo-reviewer",
  submodule_repo_ids: [],
};

const routes = () => ({
  [RUNNERS]: runnersView([runnerView({ id: "fixture" })]),
  [EXECUTORS]: executorsView([executorView({ id: "local" })]),
  [CREATE]: CREATED,
});

type User = ReturnType<typeof userEvent.setup>;

const fillRequired = async (user: User) => {
  await user.type(screen.getByLabelText("Name"), "demo");
  await user.type(
    screen.getByLabelText("Repo URL"),
    "https://example.com/demo.git",
  );
  await user.click(screen.getByRole("combobox", { name: "Runner" }));
  await user.click(await screen.findByRole("option", { name: "fixture" }));
};

const deliverySection = () =>
  screen.getByRole("group", { name: DELIVERY_CREATE_LABEL });

test("delivery is off by default, and the request carries none", async () => {
  const fetchMock = stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  const delivery = deliverySection();
  expect(
    within(delivery)
      .getByRole("radio", { name: /^Keep the work here/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  await fillRequired(user);
  await user.click(screen.getByRole("button", { name: "Create" }));
  await screen.findByText(/is ready/);
  expect(bodyOf(fetchMock, CREATE, "POST")).not.toHaveProperty("delivery");
});

test("chosen, both fields reach the create request", async () => {
  const fetchMock = stubFetch(routes());
  renderWithProviders(<NewProjectScreen />);
  const user = userEvent.setup();
  const delivery = deliverySection();
  await user.click(
    within(delivery).getByRole("radio", { name: /^Push the branch/ }),
  );
  // A new project has no finished work, so the Settings line about it is not here.
  expect(within(delivery).queryByText(DELIVERY_SINCE_HINT)).toBeNull();
  await user.click(
    within(delivery).getByRole("radio", {
      name: /^Only when the ticket is done/,
    }),
  );
  await fillRequired(user);
  await user.click(screen.getByRole("button", { name: "Create" }));
  await screen.findByText(/is ready/);
  expect(bodyOf(fetchMock, CREATE, "POST")).toMatchObject({
    delivery: { mode: "push", when: "done" },
  });
});
