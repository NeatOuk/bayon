import { NO_STEP_TIERS } from "@bayon/core";
import { NO_DELIVERY, NO_DOCS, NO_QA } from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { certifyCommand } from "@/ide/context-compression-section";
import { renderIde } from "@/test/ide-harness";
import { projectAgent, projectView } from "@/test/project-fixtures";
import { apiError, bodyOf, callsTo } from "@/test/render";
import {
  certification,
  modelView,
  runnerView,
  runnersView,
} from "@/test/runner-fixtures";

// Project settings → Context compression: a switch, off by default, that asks before it
// turns on and not before it turns off; beside it, each step model's certificate earned with
// compression on, or the command that earns it.

const HASH = "#/p/ws-bayon/settings";
const PROJECT = "/api/v1/projects/ws-bayon";
const RUNNER = "runner-a";
const STANDARD = `${RUNNER}.standard`;
const COMPLEX = `${RUNNER}.complex`;

/** standard: normal and compression-on certificates; complex: the normal one only. */
const RUNNERS = runnersView([
  runnerView({
    id: RUNNER,
    models: (["complex", "standard", "cheap"] as const).map((tier) =>
      modelView({ id: `${RUNNER}.${tier}`, tier, model: `model-${tier}` }),
    ),
    certifications: [
      certification({ model_id: STANDARD }),
      certification({ model_id: STANDARD, compression: true }),
      certification({ model_id: COMPLEX }),
    ],
  }),
]);

const project = (o: Parameters<typeof projectView>[0] = {}) =>
  projectView({
    agents: [
      projectAgent({
        id: "bayon-builder",
        runner_id: RUNNER,
        model: "model-standard",
        model_id: STANDARD,
      }),
      projectAgent({
        id: "bayon-reviewer",
        kind: "reviewer",
        runner_id: RUNNER,
        model: "model-standard",
        model_id: STANDARD,
      }),
    ],
    ...o,
  });

const answer = (on: boolean) => ({
  project: "ws-bayon",
  staff_approval: false,
  jira: null,
  qa: NO_QA,
  docs: NO_DOCS,
  delivery: NO_DELIVERY,
  step_tiers: NO_STEP_TIERS,
  context_compression: on,
  qa_ticket: null,
  changed: true,
});

const routes = (over: Record<string, unknown> = {}) => ({
  "/api/v1/runners": RUNNERS,
  "/api/v1/role-bindings": { items: [] },
  ...over,
});

const section = () =>
  screen.findByRole("region", { name: "Context compression" });
const toggle = async () =>
  within(await section()).getByRole("switch", {
    name: "Compress large tool output",
  });

afterEach(() => {
  window.location.hash = "";
});

test("off by default; every step model shows its compression-on certificate, eligible for review", async () => {
  renderIde(HASH, project(), routes());
  expect((await toggle()).getAttribute("aria-checked")).toBe("false");
  const region = await section();
  await waitFor(() =>
    expect(within(region).getAllByText("Certified")).toHaveLength(3),
  );
  expect(within(region).getAllByText("Gate-eligible")).toHaveLength(1);
  expect(within(region).queryByText(/frm runner conformance/)).toBeNull();
});

test("turning it on asks first: Cancel writes nothing, Turn on PATCHes it", async () => {
  const fetchMock = renderIde(
    HASH,
    project(),
    routes({ [PROJECT]: () => answer(true) }),
  );
  const user = userEvent.setup();
  await user.click(await toggle());
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Turn on context compression?")).toBeTruthy();
  expect(
    within(dialog).getByText(/certificate earned with compression on/),
  ).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(0);
  expect((await toggle()).getAttribute("aria-checked")).toBe("false");

  await user.click(await toggle());
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Turn on",
    }),
  );
  await waitFor(() =>
    expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, PROJECT, "PATCH")).toEqual({
    context_compression: true,
  });
  expect(await screen.findByText("Context compression is on")).toBeTruthy();
  await waitFor(async () =>
    expect((await toggle()).getAttribute("aria-checked")).toBe("true"),
  );
});

test("turning it off does not ask", async () => {
  const fetchMock = renderIde(
    HASH,
    project({ context_compression: true }),
    routes({ [PROJECT]: () => answer(false) }),
  );
  const user = userEvent.setup();
  expect((await toggle()).getAttribute("aria-checked")).toBe("true");
  await user.click(await toggle());
  await waitFor(() =>
    expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(1),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(bodyOf(fetchMock, PROJECT, "PATCH")).toEqual({
    context_compression: false,
  });
});

test("a step model without a compression-on certificate shows the exact command that earns it", async () => {
  renderIde(
    HASH,
    project({
      context_compression: true,
      step_tiers: { plan: "complex", build: null, review: null },
    }),
    routes(),
  );
  const region = await section();
  const command = certifyCommand(RUNNER, COMPLEX);
  expect(command).toBe(
    `frm runner conformance ${RUNNER} --model ${COMPLEX} --executor local --compression`,
  );
  expect(await within(region).findByText(command)).toBeTruthy();
  expect(within(region).getByText("Never run")).toBeTruthy();
  // Build and review run the standard model, certified with compression on.
  expect(within(region).getAllByText("Certified")).toHaveLength(2);
});

test("a refused write says so, and the switch stays where it was", async () => {
  renderIde(
    HASH,
    project(),
    routes({
      [PROJECT]: () => apiError(400, "validation", "not today"),
    }),
  );
  const user = userEvent.setup();
  await user.click(await toggle());
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Turn on" }));
  expect(
    await within(dialog).findByText("Not saved: validation: not today"),
  ).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect((await toggle()).getAttribute("aria-checked")).toBe("false");
});
