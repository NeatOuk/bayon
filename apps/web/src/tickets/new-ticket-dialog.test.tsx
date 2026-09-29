import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderWithProviders, stubFetch } from "@/test/render";
import { ticketView } from "@/test/ticket-fixtures";
import { NewTicketDialog } from "@/tickets/new-ticket-dialog";

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
    [WORKSPACES]: workspaces([{ id: "w-a", name: "alpha" }]),
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
