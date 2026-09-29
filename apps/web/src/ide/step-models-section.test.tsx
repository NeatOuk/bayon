import { NO_STEP_TIERS } from "@bayon/core";
import { NO_DELIVERY, NO_DOCS, NO_QA } from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { renderIde } from "@/test/ide-harness";
import { projectAgent, projectView } from "@/test/project-fixtures";
import { apiError, bodyOf, callsTo } from "@/test/render";
import {
  certification,
  modelView,
  runnerView,
  runnersView,
} from "@/test/runner-fixtures";

// Project settings → Models: a tier per step, Inherit by default, the model each step
// will run beside it — from the project's agents, their runner's models and certifications, and the
// role bindings — and a Save that PATCHes the three.

const HASH = "#/p/ws-bayon/settings";
const PROJECT = "/api/v1/projects/ws-bayon";
const RUNNER = "runner-a";

const RUNNERS = runnersView([
  runnerView({
    id: RUNNER,
    models: (["complex", "standard", "cheap"] as const).map((tier) =>
      modelView({ id: `${RUNNER}.${tier}`, tier, model: `model-${tier}` }),
    ),
    certifications: [
      certification({ model_id: `${RUNNER}.standard` }),
      certification({ model_id: `${RUNNER}.complex`, gate_eligible: false }),
    ],
  }),
]);

const project = projectView({
  agents: [
    projectAgent({
      id: "bayon-builder",
      runner_id: RUNNER,
      model: "model-standard",
      model_id: `${RUNNER}.standard`,
    }),
    projectAgent({
      id: "bayon-reviewer",
      kind: "reviewer",
      runner_id: RUNNER,
      model: "model-standard",
      model_id: `${RUNNER}.standard`,
    }),
  ],
});

const saved = (step_tiers: typeof NO_STEP_TIERS) => ({
  project: "ws-bayon",
  staff_approval: false,
  jira: null,
  qa: NO_QA,
  docs: NO_DOCS,
  delivery: NO_DELIVERY,
  step_tiers,
  qa_ticket: null,
  changed: true,
});

const routes = (over: Record<string, unknown> = {}) => ({
  "/api/v1/runners": RUNNERS,
  "/api/v1/role-bindings": { items: [] },
  ...over,
});

const section = () => screen.findByRole("region", { name: "Models" });
const select = async (name: string) =>
  within(await section()).getByRole("combobox", { name });
const hintOf = async (name: string) => {
  const described = (await select(name)).getAttribute("aria-describedby");
  return document.getElementById(described ?? "")?.textContent ?? "";
};

afterEach(() => {
  window.location.hash = "";
});

test("each step inherits by default, beside the model its agent runs", async () => {
  renderIde(HASH, project, routes());
  for (const name of ["Plan", "Build", "Review"]) {
    expect((await select(name)).textContent, name).toContain("Inherit");
    await waitFor(async () =>
      expect(await hintOf(name)).toBe(
        `Runs model-standard (standard) on ${RUNNER}.`,
      ),
    );
  }
  const models = await section();
  expect(within(models).getAllByText("Certified")).toHaveLength(3);
  // Review says whether its model may review a gate; plan and build do not.
  expect(within(models).getAllByText("Gate-eligible")).toHaveLength(1);
});

test("choosing a tier previews its model, and Save PATCHes the three steps", async () => {
  const fetchMock = renderIde(
    HASH,
    project,
    routes({
      [PROJECT]: () =>
        saved({ plan: "complex", build: "standard", review: null }),
    }),
  );
  const user = userEvent.setup();
  await user.click(await select("Plan"));
  await user.click(await screen.findByRole("option", { name: "complex" }));
  await user.click(await select("Build"));
  await user.click(await screen.findByRole("option", { name: "standard" }));
  expect(await hintOf("Plan")).toBe(
    `Runs model-complex (complex) on ${RUNNER}.`,
  );

  await user.click(
    within(await section()).getByRole("button", {
      name: "Save model settings",
    }),
  );
  await waitFor(() =>
    expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, PROJECT, "PATCH")).toEqual({
    step_tiers: { plan: "complex", build: "standard", review: null },
  });
  expect(await screen.findByText("Model settings saved")).toBeTruthy();
});

test("a tier with no certificate, and a review model that may not review, say so", async () => {
  renderIde(
    HASH,
    projectView({
      ...project,
      step_tiers: { plan: "cheap", build: null, review: "complex" },
    }),
    routes(),
  );
  await waitFor(async () =>
    expect(await hintOf("Plan")).toBe(
      `Runs model-cheap (cheap) on ${RUNNER}. Not certified on local: admission refuses it until it is.`,
    ),
  );
  expect(await hintOf("Review")).toBe(
    `Runs model-complex (complex) on ${RUNNER}. Not gate-eligible on local: no gate review can run on it.`,
  );
  const models = await section();
  expect(within(models).getByText("Never run")).toBeTruthy();
  expect(within(models).getByText("Not gate-eligible")).toBeTruthy();
});

test("a role binding's own tier wins, and the hint names it", async () => {
  renderIde(
    HASH,
    projectView({
      ...project,
      step_tiers: { plan: "complex", build: null, review: null },
    }),
    routes({
      "/api/v1/role-bindings": {
        items: [
          {
            role: "builder",
            runner_id: RUNNER,
            model_tier: "standard",
            executor_id: null,
            profile_id: null,
            fallback_runner_id: null,
            require_distinct_from: null,
            updated_by: "operator",
            updated_at: 0,
            model_id: null,
            model: null,
          },
        ],
      },
    }),
  );
  await waitFor(async () =>
    expect(await hintOf("Plan")).toBe(
      `Runs model-standard (standard) on ${RUNNER}. The builder role binding's tier wins over this.`,
    ),
  );
});

test("when the runners cannot be read, the section says so and still takes a tier", async () => {
  renderIde(
    HASH,
    project,
    routes({
      "/api/v1/runners": () =>
        apiError(404, "not_found", "the runners are not there"),
    }),
  );
  expect(
    await within(await section()).findByText(
      "The models each step would run are unavailable",
    ),
  ).toBeTruthy();
  expect(await hintOf("Plan")).toBe("Resolving the model…");
});

test("an inheriting review step shows the model the reviewer binding's profile runs, and says so", async () => {
  renderIde(
    HASH,
    project,
    routes({
      "/api/v1/role-bindings": {
        items: [
          {
            role: "code_reviewer",
            runner_id: RUNNER,
            model_tier: null,
            executor_id: null,
            profile_id: "reviewer-deep",
            fallback_runner_id: null,
            require_distinct_from: null,
            updated_by: "operator",
            updated_at: 0,
            model_id: `${RUNNER}.complex`,
            model: "model-complex",
          },
        ],
      },
    }),
  );
  await waitFor(async () =>
    expect(await hintOf("Review")).toBe(
      `Runs model-complex (complex) on ${RUNNER}. Inherited from the code_reviewer role binding's profile. Not gate-eligible on local: no gate review can run on it.`,
    ),
  );
  // Plan and build run the builder's own profile.
  expect(await hintOf("Build")).toBe(
    `Runs model-standard (standard) on ${RUNNER}.`,
  );
});
