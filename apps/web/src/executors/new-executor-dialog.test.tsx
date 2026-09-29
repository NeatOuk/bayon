import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  apiError,
  bodyOf,
  renderWithProviders,
  stubFetch,
} from "@/test/render";
import { NewExecutorDialog } from "@/executors/new-executor-dialog";

const CREATE = "/api/v1/executors";

const openDialog = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Add executor" }));
  return user;
};

const fillRequired = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText("Executor id"), "ctr-new");
  await user.type(screen.getByLabelText("Host"), "192.0.2.10");
  await user.type(screen.getByLabelText("User"), "ops");
  await user.type(screen.getByLabelText(/^Identity/), "file:/keys/id_ed25519");
  await user.type(screen.getByLabelText("Remote root"), "/home/ops/frm");
};

test("the SSH trust notice is always shown, before any refusal", async () => {
  stubFetch({});
  renderWithProviders(<NewExecutorDialog />);
  await openDialog();
  expect(screen.getByText(/trust its SSH key first/)).toBeTruthy();
  expect(screen.getByText(/ssh-copy-id/)).toBeTruthy();
});

test("the dialog is the large size, its twelve fields in two columns", async () => {
  stubFetch({});
  renderWithProviders(<NewExecutorDialog />);
  await openDialog();
  const dialog = screen.getByRole("dialog");
  expect(dialog.dataset.size).toBe("lg");
  const grid = screen.getByLabelText("Executor id").closest(".grid");
  expect(grid?.className).toContain("sm:grid-cols-2");
  expect(grid?.querySelectorAll("input")).toHaveLength(12);
});

test("Create is disabled until id, host, user, identity and remote root are all set", async () => {
  stubFetch({});
  renderWithProviders(<NewExecutorDialog />);
  const user = await openDialog();
  expect(
    screen.getByRole("button", { name: "Create" }).hasAttribute("disabled"),
  ).toBe(true);
  await fillRequired(user);
  expect(
    screen.getByRole("button", { name: "Create" }).hasAttribute("disabled"),
  ).toBe(false);
});

test("submits the typed fields and closes on success", async () => {
  const fetchMock = stubFetch({
    [CREATE]: {
      id: "ctr-new",
      host: "192.0.2.10",
      known_hosts_entries_copied: 1,
    },
  });
  renderWithProviders(<NewExecutorDialog />);
  const user = await openDialog();
  await fillRequired(user);
  await user.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // The dialog no longer closes silently: a toast says what was added.
  const toast = await screen.findByRole("status", { name: "Executor added" });
  expect(toast.textContent).toContain("ctr-new is registered");
  expect(bodyOf(fetchMock, CREATE, "POST")).toMatchObject({
    id: "ctr-new",
    host: "192.0.2.10",
    user: "ops",
    identity_ref: "file:/keys/id_ed25519",
    remote_root: "/home/ops/frm",
    slots: 2,
  });
});

test("the known-hosts refusal keeps the dialog open and shows the server's message", async () => {
  stubFetch({
    [CREATE]: () =>
      apiError(
        400,
        "validation",
        "192.0.2.10 is not in /home/op/.ssh/known_hosts: connect once with ssh and check its fingerprint first (frm never scans host keys)",
      ),
  });
  renderWithProviders(<NewExecutorDialog />);
  const user = await openDialog();
  await fillRequired(user);
  await user.click(screen.getByRole("button", { name: "Create" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("frm never scans host keys");
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("a blank optional field is omitted so the server's default applies", async () => {
  const fetchMock = stubFetch({
    [CREATE]: {
      id: "ctr-new",
      host: "192.0.2.10",
      known_hosts_entries_copied: 1,
    },
  });
  renderWithProviders(<NewExecutorDialog />);
  const user = await openDialog();
  await fillRequired(user);
  await user.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const body = bodyOf(fetchMock, CREATE, "POST") as Record<string, unknown>;
  expect("network" in body).toBe(false);
  expect("base_image" in body).toBe(false);
  expect("min_free_pct" in body).toBe(false);
  expect("quota_gb" in body).toBe(false);
});
