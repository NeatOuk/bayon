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
  modelView,
  runnerView,
  runnersView,
} from "@/test/runner-fixtures";

// Runners → Models: the list, add, edit, turn off and on, the server's refusals shown
// inline, and settings read-only with the frm command that changes them.

const RUNNERS = "/api/v1/runners";
const EXECUTORS = "/api/v1/executors";
const MODELS = "/api/v1/runners/runner-a/models";
const CHEAP = `${MODELS}/runner-a.cheap`;
const LOCAL_URL = "http://10.0.0.7:11434/v1";

const own = modelView({
  id: "runner-a.local",
  tier: "standard",
  model: "provider/own-model",
  source: "operator",
  price_in_per_mtok: 0,
  price_out_per_mtok: 0,
  context_tokens: 32_768,
  settings: { provider_url: LOCAL_URL },
});

const runner = runnerView({
  id: "runner-a",
  certifications: [
    certification(),
    certification({ executor_id: "ctr-1", model_id: "runner-a.cheap" }),
    certification({
      executor_id: "ctr-2",
      model_id: "runner-a.cheap",
      passed_at: null,
    }),
  ],
  models: [
    modelView({
      id: "runner-a.cheap",
      tier: "cheap",
      model: "model-small",
      bound_roles: ["builder"],
      price_in_per_mtok: 0.25,
      price_out_per_mtok: 1.25,
      price_cache_read_per_mtok: 0.03,
      price_cache_write_per_mtok: 0.3,
    }),
    own,
  ],
  inactive_models: [
    modelView({
      id: "runner-a.complex",
      tier: "complex",
      model: "model-large",
      active: false,
    }),
  ],
});

const reply = (model = own, replaced: string[] = []) => ({
  model,
  changed: true,
  replaced,
});

const EXECUTOR_ROWS = executorsView([executorView({ id: "local" })]);

async function modelsOf() {
  const card = await screen.findByRole("region", { name: "runner-a" });
  return within(card).getByRole("table", { name: "models" });
}

const rowOf = (table: HTMLElement, id: string) => {
  const row = within(table)
    .getAllByRole("row")
    .find((r) => r.textContent?.startsWith(id));
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
};

test("each model shows its tier, prices, context, source, status, the executors it is certified on, and its settings read-only", async () => {
  stubFetch({ [RUNNERS]: runnersView([runner]), [EXECUTORS]: EXECUTOR_ROWS });
  renderWithProviders(<RunnersScreen />);
  const table = await modelsOf();
  const cheap = rowOf(table, "runner-a.cheap");
  expect(within(cheap).getByText("model-small")).toBeTruthy();
  expect(within(cheap).getByText(/in \$0\.25 · out \$1\.25/)).toBeTruthy();
  expect(within(cheap).getByText("cache $0.03 / $0.3")).toBeTruthy();
  expect(within(cheap).getByText("adapter")).toBeTruthy();
  expect(within(cheap).getByText("Active")).toBeTruthy();
  // Certified (live) on local and ctr-1; ctr-2's run did not pass.
  expect(within(cheap).getByText("local, ctr-1")).toBeTruthy();

  const mine = rowOf(table, "runner-a.local");
  expect(within(mine).getByText("operator")).toBeTruthy();
  expect(within(mine).getByText("32768")).toBeTruthy();
  expect(
    within(mine).getByText(JSON.stringify({ provider_url: LOCAL_URL })),
  ).toBeTruthy();

  const off = rowOf(table, "runner-a.complex");
  expect(within(off).getByText("Inactive")).toBeTruthy();
  expect(within(off).getByRole("button", { name: "Turn on" })).toBeTruthy();
  expect(
    screen.getByText(
      /read-only here\. Change them with frm config apply <file\.json> --yes/,
    ),
  ).toBeTruthy();
});

test("add posts the model with its prices, never settings, and refreshes the runners", async () => {
  const fetchMock = stubFetch({
    [RUNNERS]: runnersView([runner]),
    [EXECUTORS]: EXECUTOR_ROWS,
    [MODELS]: reply(own, ["runner-a.standard"]),
  });
  const user = userEvent.setup();
  renderWithProviders(<RunnersScreen />);
  await modelsOf();
  await user.click(screen.getByRole("button", { name: "Add model" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByRole("textbox", { name: /settings/i })).toBe(
    null,
  );
  await user.type(
    within(dialog).getByRole("textbox", { name: "Id" }),
    "runner-a.local",
  );
  await user.type(
    within(dialog).getByRole("textbox", { name: "Model" }),
    "provider/own-model",
  );
  await user.type(
    within(dialog).getByRole("textbox", { name: "Input price" }),
    "0",
  );
  await user.type(
    within(dialog).getByRole("textbox", { name: "Output price" }),
    "0",
  );
  await user.type(
    within(dialog).getByRole("textbox", { name: "Context (tokens, optional)" }),
    "32768",
  );
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(bodyOf(fetchMock, MODELS, "POST")).toEqual({
      id: "runner-a.local",
      model: "provider/own-model",
      tier: "standard",
      price_in_per_mtok: 0,
      price_out_per_mtok: 0,
      context_tokens: 32_768,
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
  await waitFor(() =>
    expect(callsTo(fetchMock, RUNNERS).length).toBeGreaterThanOrEqual(2),
  );
});

test("the one-active-per-tier refusal is shown in the dialog, which stays open; a missing price is caught before sending", async () => {
  const fetchMock = stubFetch({
    [RUNNERS]: runnersView([runner]),
    [EXECUTORS]: EXECUTOR_ROWS,
    [MODELS]: () =>
      apiError(
        409,
        "conflict",
        "runner runner-a already runs operator model runner-a.local in tier standard: one active model per runner and tier — deactivate runner-a.local first",
      ),
  });
  const user = userEvent.setup();
  renderWithProviders(<RunnersScreen />);
  await modelsOf();
  await user.click(screen.getByRole("button", { name: "Add model" }));
  const dialog = await screen.findByRole("dialog");
  await user.type(
    within(dialog).getByRole("textbox", { name: "Id" }),
    "runner-a.two",
  );
  await user.type(
    within(dialog).getByRole("textbox", { name: "Model" }),
    "provider/x",
  );
  await user.type(
    within(dialog).getByRole("textbox", { name: "Input price" }),
    "0",
  );
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "Not saved: Give both the input and the output price (0 is allowed)",
  );
  expect(callsTo(fetchMock, MODELS, "POST")).toHaveLength(0);

  await user.type(
    within(dialog).getByRole("textbox", { name: "Output price" }),
    "0",
  );
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "already runs operator model runner-a.local in tier standard",
    ),
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("edit sends only what changed; the model string is not editable", async () => {
  const fetchMock = stubFetch({
    [RUNNERS]: runnersView([runner]),
    [EXECUTORS]: EXECUTOR_ROWS,
    [CHEAP]: reply(),
  });
  const user = userEvent.setup();
  renderWithProviders(<RunnersScreen />);
  const table = await modelsOf();
  await user.click(
    within(rowOf(table, "runner-a.cheap")).getByRole("button", {
      name: "Edit",
    }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByRole("textbox", { name: "Model" })).toBe(null);
  const input = within(dialog).getByRole("textbox", { name: "Input price" });
  await user.clear(input);
  await user.type(input, "0.5");
  await user.type(
    within(dialog).getByRole("textbox", { name: "Effort (optional)" }),
    "high",
  );
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(bodyOf(fetchMock, CHEAP, "PATCH")).toEqual({
      effort: "high",
      price_in_per_mtok: 0.5,
    }),
  );
});

test("turn off deletes (deactivates); turn on patches active; a refusal is shown inline", async () => {
  const fetchMock = stubFetch({
    [RUNNERS]: runnersView([runner]),
    [EXECUTORS]: EXECUTOR_ROWS,
    [CHEAP]: reply(),
    [`${MODELS}/runner-a.complex`]: () =>
      apiError(
        409,
        "conflict",
        "runner runner-a already runs operator model runner-a.big in tier complex",
      ),
  });
  const user = userEvent.setup();
  renderWithProviders(<RunnersScreen />);
  const table = await modelsOf();
  await user.click(
    within(rowOf(table, "runner-a.cheap")).getByRole("button", {
      name: "Turn off",
    }),
  );
  await waitFor(() =>
    expect(callsTo(fetchMock, CHEAP, "DELETE")).toHaveLength(1),
  );
  await user.click(
    within(rowOf(table, "runner-a.complex")).getByRole("button", {
      name: "Turn on",
    }),
  );
  await waitFor(() =>
    expect(bodyOf(fetchMock, `${MODELS}/runner-a.complex`, "PATCH")).toEqual({
      active: true,
    }),
  );
  const card = screen.getByRole("region", { name: "runner-a" });
  expect((await within(card).findByRole("alert")).textContent).toContain(
    "already runs operator model runner-a.big in tier complex",
  );
});
