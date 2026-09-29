import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderWithProviders, stubFetch } from "@/test/render";
import { ticketView } from "@/test/ticket-fixtures";
import { defaultProjectOf, NewTicketDialog } from "@/tickets/new-ticket-dialog";

const WORKSPACES = "/api/v1/workspaces";
const CREATE = "/api/v1/tickets";

const workspaces = (rows: readonly { id: string; name: string }[]) => ({
  workspaces: rows.map((w) => ({ ...w, kind: "single" })),
});

const postCalls = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

const postBody = (fetchMock: ReturnType<typeof stubFetch>): unknown => {
  const [, init] = postCalls(fetchMock)[0] ?? [];
  return JSON.parse((init?.body as string | undefined) ?? "null") as unknown;
};

const openDialog = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New ticket" }));
  return user;
};

test("submits the typed fields, including a chosen workspace, and closes", async () => {
  const fetchMock = stubFetch({
    [WORKSPACES]: workspaces([{ id: "w-a", name: "alpha" }]),
    [CREATE]: ticketView({ num: 9, title: "fix the thing" }),
  });
  renderWithProviders(<NewTicketDialog />);
  const user = await openDialog();
  await user.type(screen.getByLabelText("Title"), "fix the thing");
  await user.click(screen.getByRole("combobox", { name: "Project" }));
  await user.click(await screen.findByRole("option", { name: "alpha" }));
  await user.type(screen.getByLabelText("Body"), "some body");
  await user.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // The dialog closes onto the new ticket; a toast names it.
  expect(
    await screen.findByRole("status", { name: "Created FRM-9" }),
  ).toBeTruthy();
  expect(postCalls(fetchMock)).toHaveLength(1);
  expect(postBody(fetchMock)).toMatchObject({
    title: "fix the thing",
    type: "feature",
    workspace_id: "w-a",
    body_md: "some body",
    priority: 3,
  });
});

test("leaving the workspace unset omits workspace_id", async () => {
  const fetchMock = stubFetch({
    [WORKSPACES]: workspaces([
      { id: "w-a", name: "alpha" },
      { id: "w-b", name: "beta" },
    ]),
    [CREATE]: ticketView({ num: 9 }),
  });
  renderWithProviders(<NewTicketDialog />);
  const user = await openDialog();
  await user.type(screen.getByLabelText("Title"), "no workspace");
  await user.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(postCalls(fetchMock)).toHaveLength(1));
  const body = postBody(fetchMock) as { workspace_id?: unknown };
  expect("workspace_id" in body).toBe(false);
});

test("a server refusal stays open and shows the message", async () => {
  stubFetch({
    [WORKSPACES]: workspaces([]),
    [CREATE]: () =>
      Response.json(
        {
          error: {
            class: "validation",
            message: "title: too long",
            retryable: false,
          },
        },
        { status: 422 },
      ),
  });
  renderWithProviders(<NewTicketDialog />);
  const user = await openDialog();
  await user.type(screen.getByLabelText("Title"), "a title");
  await user.click(screen.getByRole("button", { name: "Create" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("title: too long");
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("Create is disabled until a title is typed", async () => {
  stubFetch({ [WORKSPACES]: workspaces([]) });
  renderWithProviders(<NewTicketDialog />);
  await openDialog();
  expect(
    screen.getByRole("button", { name: "Create" }).hasAttribute("disabled"),
  ).toBe(true);
});

const TWO = [
  { id: "w-a", name: "alpha" },
  { id: "w-b", name: "beta" },
];

const projectField = () => screen.getByRole("combobox", { name: "Project" });

test("opened from a project's view, it defaults to that project", async () => {
  const fetchMock = stubFetch({
    [WORKSPACES]: workspaces(TWO),
    [CREATE]: ticketView({ num: 9 }),
  });
  renderWithProviders(<NewTicketDialog defaultProject="w-b" />);
  const user = await openDialog();
  await waitFor(() => expect(projectField().textContent).toContain("beta"));
  await user.type(screen.getByLabelText("Title"), "in beta");
  await user.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(postCalls(fetchMock)).toHaveLength(1));
  expect(postBody(fetchMock)).toMatchObject({ workspace_id: "w-b" });
});

test("with exactly one project, it defaults to that project", async () => {
  const fetchMock = stubFetch({
    [WORKSPACES]: workspaces([{ id: "w-a", name: "alpha" }]),
    [CREATE]: ticketView({ num: 9 }),
  });
  renderWithProviders(<NewTicketDialog />);
  const user = await openDialog();
  await waitFor(() => expect(projectField().textContent).toContain("alpha"));
  await user.type(screen.getByLabelText("Title"), "the only one");
  await user.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(postCalls(fetchMock)).toHaveLength(1));
  expect(postBody(fetchMock)).toMatchObject({ workspace_id: "w-a" });
});

test("with several projects and no view, it stays (none)", async () => {
  stubFetch({ [WORKSPACES]: workspaces(TWO) });
  renderWithProviders(<NewTicketDialog />);
  const user = await openDialog();
  await user.click(projectField());
  await screen.findByRole("option", { name: "beta" });
  await user.keyboard("{Escape}");
  expect(projectField().textContent).toContain("(none)");
});

test("the operator can clear the single-project default back to (none)", async () => {
  const fetchMock = stubFetch({
    [WORKSPACES]: workspaces([{ id: "w-a", name: "alpha" }]),
    [CREATE]: ticketView({ num: 9 }),
  });
  renderWithProviders(<NewTicketDialog />);
  const user = await openDialog();
  await waitFor(() => expect(projectField().textContent).toContain("alpha"));
  await user.click(projectField());
  await user.click(await screen.findByRole("option", { name: "(none)" }));
  await user.type(screen.getByLabelText("Title"), "no project");
  await user.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(postCalls(fetchMock)).toHaveLength(1));
  const body = postBody(fetchMock) as { workspace_id?: unknown };
  expect("workspace_id" in body).toBe(false);
});

test("defaultProjectOf: the view's project, else the only one, else none", () => {
  const one = [{ id: "w-a", name: "alpha", kind: "single" as const }];
  const two = [...one, { id: "w-b", name: "beta", kind: "single" as const }];
  expect(defaultProjectOf("w-b", two)).toBe("w-b");
  expect(defaultProjectOf("w-b", [])).toBe("w-b");
  expect(defaultProjectOf(null, one)).toBe("w-a");
  expect(defaultProjectOf(null, two)).toBeNull();
  expect(defaultProjectOf(null, [])).toBeNull();
});
