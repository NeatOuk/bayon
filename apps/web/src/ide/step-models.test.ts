import type { RoleBindingView, RunnerView } from "@bayon/proto";
import { expect, test } from "vitest";
import { stepModel } from "@/ide/step-models";
import { projectAgent, projectView } from "@/test/project-fixtures";
import { certification, modelView, runnerView } from "@/test/runner-fixtures";

// Which model a step runs, in core sessionTier's order — the role binding's tier, the
// project's for the step, the agent's own — and what would stop it: no active model of the tier, no
// certificate on local, or, for review, one that may not review a gate.

const RUNNER = "runner-a";

/** runner-a with a model per tier: cheap and complex certified on local, complex not gate-eligible. */
const runner = (o: Partial<RunnerView> = {}): RunnerView =>
  runnerView({
    id: RUNNER,
    models: (["complex", "standard", "cheap"] as const).map((tier) =>
      modelView({ id: `${RUNNER}.${tier}`, tier, model: `model-${tier}` }),
    ),
    certifications: [
      certification({ model_id: `${RUNNER}.cheap`, model: "model-cheap" }),
      certification({
        model_id: `${RUNNER}.complex`,
        model: "model-complex",
        gate_eligible: false,
      }),
      certification({
        model_id: `${RUNNER}.standard`,
        model: "model-standard",
        passed_at: null,
        decertified_at: 1_800_000_000_000,
      }),
    ],
    ...o,
  });

const project = projectView({
  agents: [
    projectAgent({
      id: "b",
      runner_id: RUNNER,
      model: "model-cheap",
      model_id: `${RUNNER}.cheap`,
    }),
    projectAgent({
      id: "r",
      kind: "reviewer",
      runner_id: RUNNER,
      model: "model-cheap",
      model_id: `${RUNNER}.cheap`,
    }),
  ],
});

const binding = (
  role: string,
  model_tier: string | null,
  o: Partial<RoleBindingView> = {},
): RoleBindingView => ({
  role,
  runner_id: RUNNER,
  model_tier,
  executor_id: null,
  profile_id: null,
  fallback_runner_id: null,
  require_distinct_from: null,
  updated_by: "operator",
  updated_at: 0,
  model_id: null,
  model: null,
  ...o,
});

test("inherit: the agent's own model, certified", () => {
  expect(stepModel("build", null, project, [runner()], [])).toEqual({
    runnerId: RUNNER,
    tier: "cheap",
    modelId: `${RUNNER}.cheap`,
    model: "model-cheap",
    boundBy: null,
    profileOf: null,
    certification: "certified",
    gateEligible: null,
    problem: null,
  });
});

test("a step tier: the runner's active model of it; decertified there is a problem", () => {
  expect(stepModel("plan", "standard", project, [runner()], [])).toMatchObject({
    tier: "standard",
    model: "model-standard",
    certification: "decertified",
    problem: "Not certified on local: admission refuses it until it is.",
  });
});

test("the role binding's tier wins over the step's, and says whose it is", () => {
  expect(
    stepModel(
      "plan",
      "complex",
      project,
      [runner()],
      [binding("builder", "cheap"), binding("code_reviewer", "complex")],
    ),
  ).toMatchObject({ tier: "cheap", model: "model-cheap", boundBy: "builder" });
  // A binding with no tier of its own decides nothing.
  expect(
    stepModel(
      "plan",
      "complex",
      project,
      [runner()],
      [binding("builder", null)],
    ),
  ).toMatchObject({ tier: "complex", boundBy: null });
});

test("review: the reviewer agent's runner; certified but not gate-eligible is a problem", () => {
  expect(stepModel("review", "complex", project, [runner()], [])).toEqual({
    runnerId: RUNNER,
    tier: "complex",
    modelId: `${RUNNER}.complex`,
    model: "model-complex",
    boundBy: null,
    profileOf: null,
    certification: "certified",
    gateEligible: false,
    problem: "Not gate-eligible on local: no gate review can run on it.",
  });
  expect(stepModel("review", "cheap", project, [runner()], [])).toMatchObject({
    gateEligible: true,
    problem: null,
  });
});

test("no certificate at all is `never run`; a failed one is `not certified`", () => {
  const bare = runner({ certifications: [] });
  expect(stepModel("build", "cheap", project, [bare], [])).toMatchObject({
    certification: "never run",
    problem: "Not certified on local: admission refuses it until it is.",
  });
  const failed = runner({
    certifications: [
      certification({ model_id: `${RUNNER}.cheap`, passed_at: null }),
      // Another executor's certificate never counts here.
      certification({ model_id: `${RUNNER}.cheap`, executor_id: "remote" }),
    ],
  });
  expect(stepModel("build", "cheap", project, [failed], [])).toMatchObject({
    certification: "not certified",
  });
});

test("no active model of the tier, or none inherited, is admission's no_model", () => {
  const cheapOnly = runner({
    models: [modelView({ id: `${RUNNER}.cheap`, tier: "cheap", model: "m" })],
  });
  expect(stepModel("plan", "complex", project, [cheapOnly], [])).toEqual({
    runnerId: RUNNER,
    tier: "complex",
    modelId: null,
    model: null,
    boundBy: null,
    profileOf: null,
    certification: null,
    gateEligible: null,
    problem:
      "Runner runner-a has no active complex model: a spawn is refused (no_model).",
  });
  const noModel = projectView({
    agents: [projectAgent({ id: "b", runner_id: RUNNER, model_id: null })],
  });
  expect(stepModel("build", null, noModel, [runner()], [])).toMatchObject({
    tier: null,
    model: null,
    problem:
      "Its agent resolves to no active model: a spawn is refused (no_model).",
  });
  // An unknown runner has no models to run.
  expect(stepModel("build", "cheap", project, [], [])).toMatchObject({
    runnerId: RUNNER,
    model: null,
    certification: null,
  });
});

test("the enabled agent of its kind runs the step; with none, nothing does", () => {
  const two = projectView({
    agents: [
      projectAgent({ id: "off", runner_id: "runner-z", enabled: false }),
      projectAgent({
        id: "on",
        runner_id: RUNNER,
        model_id: `${RUNNER}.cheap`,
      }),
    ],
  });
  expect(stepModel("build", null, two, [runner()], [])).toMatchObject({
    runnerId: RUNNER,
    model: "model-cheap",
  });
  expect(stepModel("review", null, two, [runner()], [])).toEqual({
    runnerId: null,
    tier: null,
    modelId: null,
    model: null,
    boundBy: null,
    profileOf: null,
    certification: null,
    gateEligible: null,
    problem: "This project has no reviewer agent: nothing runs this step.",
  });
});

test("review inherits the reviewer binding's profile on its runner, as the gate pick does", () => {
  // No tier on the binding; its profile (for runner-a) runs complex, which the server resolved.
  const profiled = binding("code_reviewer", null, {
    profile_id: "reviewer-deep",
    model_id: `${RUNNER}.complex`,
    model: "model-complex",
  });
  expect(stepModel("review", null, project, [runner()], [profiled])).toEqual({
    runnerId: RUNNER,
    tier: "complex",
    modelId: `${RUNNER}.complex`,
    model: "model-complex",
    boundBy: null,
    profileOf: "code_reviewer",
    certification: "certified",
    gateEligible: false,
    problem: "Not gate-eligible on local: no gate review can run on it.",
  });
  // A step tier still decides over the binding's profile.
  expect(
    stepModel("review", "cheap", project, [runner()], [profiled]),
  ).toMatchObject({ model: "model-cheap", profileOf: null });
  // On another runner the binding's profile is not that runner's: the reviewer agent's own.
  expect(
    stepModel(
      "review",
      null,
      project,
      [runner()],
      [{ ...profiled, runner_id: "runner-z" }],
    ),
  ).toMatchObject({ model: "model-cheap", profileOf: null });
});

test("a builder's step never takes the builder binding's profile: its spawn runs the agent's own", () => {
  const profiled = binding("builder", null, {
    profile_id: "builder-deep",
    model_id: `${RUNNER}.complex`,
    model: "model-complex",
  });
  expect(
    stepModel("build", null, project, [runner()], [profiled]),
  ).toMatchObject({ model: "model-cheap", profileOf: null, boundBy: null });
});

test("review takes the reviewer on the binding's runner first, as the pick orders them", () => {
  const two = projectView({
    agents: [
      projectAgent({ id: "b", runner_id: RUNNER, model_id: `${RUNNER}.cheap` }),
      projectAgent({
        id: "r-y",
        kind: "reviewer",
        runner_id: "runner-y",
        model_id: null,
      }),
      projectAgent({
        id: "r-a",
        kind: "reviewer",
        runner_id: RUNNER,
        model_id: `${RUNNER}.cheap`,
      }),
    ],
  });
  expect(
    stepModel(
      "review",
      null,
      two,
      [runner()],
      [binding("code_reviewer", null)],
    ),
  ).toMatchObject({ runnerId: RUNNER, model: "model-cheap" });
  expect(stepModel("review", null, two, [runner()], [])).toMatchObject({
    runnerId: "runner-y",
  });
});

test("asked for compression: the step's compression-on certificate, never its normal one", () => {
  // Only the normal certificates: never run with compression.
  expect(
    stepModel("build", null, project, [runner()], [], { compression: true }),
  ).toMatchObject({ modelId: `${RUNNER}.cheap`, certification: "never run" });
  const both = runner({
    certifications: [
      ...runner().certifications,
      certification({
        model_id: `${RUNNER}.cheap`,
        compression: true,
        gate_eligible: false,
      }),
    ],
  });
  expect(
    stepModel("review", null, project, [both], [], { compression: true }),
  ).toMatchObject({ certification: "certified", gateEligible: false });
  // The normal answer is unchanged by a compression-on row beside it.
  expect(stepModel("review", null, project, [both], [])).toMatchObject({
    certification: "certified",
    gateEligible: true,
  });
});
