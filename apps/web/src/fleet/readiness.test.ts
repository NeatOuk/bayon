import type { RunnerView } from "@bayon/proto";
import { expect, test } from "vitest";
import { readiness } from "@/fleet/readiness";
import { projectAgent, projectView } from "@/test/project-fixtures";
import { certification, modelView, runnerView } from "@/test/runner-fixtures";

// The install's not-ready rows: a fresh install said "Nothing needs you" with every
// runner uncertified. Each row names one action.

// Who runs it, as GET /runners lists it: bindings, step tiers and agents' own models.
const USES = [
  "builder",
  "demo · plan step",
  "demo · demo-orchestrator agent",
  "demo · demo-reviewer agent",
];
const MODEL = modelView({
  id: "runner-a.cheap",
  tier: "cheap",
  model: "model-small",
  bound_roles: USES,
});

/** runner-a with one model, certified on local unless told otherwise. */
const runner = (o: Partial<RunnerView> = {}): RunnerView =>
  runnerView({
    id: "runner-a",
    models: [MODEL],
    certifications: [certification({ model_id: MODEL.id })],
    ...o,
  });

const agent = (id: string, kind: string, o = {}) =>
  projectAgent({
    id,
    name: id,
    kind,
    runner_id: "runner-a",
    model: MODEL.model,
    model_id: MODEL.id,
    ...o,
  });

const ready = projectView({
  id: "demo",
  name: "demo",
  agents: [
    agent("demo-builder", "builder"),
    agent("demo-reviewer", "reviewer"),
    agent("demo-orchestrator", "orchestrator", { has_mission: true }),
  ],
});

test("an install with no project names creating one", () => {
  expect(readiness([], [runner()], [])).toEqual([
    {
      id: "no-project",
      text: "No project yet: there is nothing to work on",
      action: { label: "Create a project", href: "#/projects/new" },
    },
  ]);
});

test("a project whose every step is certified, and whose orchestrator has a mission, is ready", () => {
  expect(readiness([ready], [runner()], [])).toEqual([]);
});

// Review M3: certification rows come from GET /runners' bound_roles — every model in use, the
// orchestrator's and a plan reviewer's too — once per model, whoever runs it.
test("an uncertified model in use is one row, naming who runs it", () => {
  const rows = readiness([ready], [runner({ certifications: [] })], []);
  expect(rows).toEqual([
    {
      id: "cert:runner-a:runner-a.cheap",
      text: "runner-a (model-small) is not certified on local, and builder, demo · plan step, demo · demo-orchestrator agent and 1 more run it",
      action: { label: "Certify runner-a", href: "#/runners" },
    },
  ]);
});

test("with admission.require_certified off, an uncertified model is no blocker", () => {
  expect(
    readiness([ready], [runner({ certifications: [] })], [], {
      requireCertified: false,
    }),
  ).toEqual([]);
});

test("the orchestrator's model counts, a model nobody runs does not, and no project lists them too", () => {
  const big = modelView({
    id: "runner-a.big",
    tier: "complex",
    model: "model-big",
    bound_roles: ["demo · demo-orchestrator agent"],
  });
  const idle = modelView({ id: "runner-a.idle", tier: "standard", model: "m" });
  const runners = [runner({ models: [MODEL, big, idle] })];
  const orchestrator = {
    id: "cert:runner-a:runner-a.big",
    text: "runner-a (model-big) is not certified on local, and demo · demo-orchestrator agent runs it",
    action: { label: "Certify runner-a", href: "#/runners" },
  };
  expect(readiness([ready], runners, [])).toEqual([orchestrator]);
  expect(readiness([], runners, []).map((r) => r.id)).toEqual([
    "no-project",
    orchestrator.id,
  ]);
});

test("no builder or reviewer in its pool, and a mission-less orchestrator, are a row each", () => {
  const project = projectView({
    id: "demo",
    name: "demo",
    has_builder: false,
    has_reviewer: false,
    agents: [
      agent("demo-builder", "builder", { enabled: false }),
      agent("demo-orchestrator", "orchestrator"),
      agent("old-orchestrator", "orchestrator", { enabled: false }),
    ],
  });
  expect(readiness([project], [runner()], [])).toEqual([
    {
      id: "demo:no-builder",
      text: "demo has no builder that can take work",
      action: { label: "Add a builder", href: "#/p/demo/agents" },
    },
    {
      id: "demo:no-reviewer",
      text: "demo has no reviewer: no review can run",
      action: { label: "Add a reviewer", href: "#/p/demo/agents" },
    },
    {
      id: "demo:mission:demo-orchestrator",
      text: "demo-orchestrator has no mission: it has nothing to steer demo by",
      action: { label: "Write its mission", href: "#/p/demo/orchestrator" },
    },
  ]);
});

// Review M2: the pool rule is the server's (has_builder, has_reviewer); a borrowed agent is ready.
test("a project that borrows the fleet's builder and reviewer is ready", () => {
  const project = projectView({
    id: "demo",
    name: "demo",
    has_builder: true,
    has_reviewer: true,
    agents: [agent("demo-orchestrator", "orchestrator", { has_mission: true })],
  });
  expect(readiness([project], [runner()], [])).toEqual([]);
});

test("a model the runner no longer offers, and a reviewer that may not review, open the runner", () => {
  const noModel = projectView({
    id: "a",
    name: "a",
    agents: [agent("a-builder", "builder", { model: null, model_id: null })],
  });
  const noGate = projectView({
    id: "b",
    name: "b",
    agents: [agent("b-builder", "builder"), agent("b-reviewer", "reviewer")],
  });
  const rows = readiness(
    [noModel, noGate],
    [
      runner({
        certifications: [
          certification({ model_id: MODEL.id, gate_eligible: false }),
        ],
      }),
    ],
    [],
  );
  expect(rows.map((r) => [r.id, r.text, r.action.label])).toEqual([
    [
      "a:model:runner-a",
      "a: runner-a has no active model for Plan and Build",
      "Open runner-a",
    ],
    ["b:gate:runner-a", "b: runner-a can't review on local", "Open runner-a"],
  ]);
});
