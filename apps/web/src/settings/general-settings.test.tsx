import {
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_KEYS,
  type OperatorSettingKey,
} from "@bayon/core";
import type { OperatorSettingsView } from "@bayon/proto";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { SettingsScreen } from "@/settings/settings-screen";
import {
  apiError,
  bodyOf,
  callsTo,
  renderWithProviders,
  stubFetch,
} from "@/test/render";

const SETTINGS = "/api/v1/settings";

/** GET /settings with every key at its default, or at `over`'s value. */
const view = (
  over: Partial<Record<OperatorSettingKey, number>> = {},
): OperatorSettingsView => ({
  require_certified: true,
  settings: OPERATOR_SETTING_KEYS.map((key) => ({
    key,
    value: over[key] ?? OPERATOR_SETTINGS[key].default,
    valid: true,
    default: OPERATOR_SETTINGS[key].default,
    updated_at: 1,
  })),
});

/** GET answers `get`; PUT answers `put`. */
function stub(put: unknown = view(), get: OperatorSettingsView = view()) {
  return stubFetch({
    [SETTINGS]: (init: RequestInit | undefined) =>
      init?.method === "PUT" ? put : get,
    "/api/v1/executors": { executors: [], untrusted_roles: ["investigator"] },
  });
}

const input = (label: string) =>
  screen.getByLabelText(label) as HTMLInputElement;
const save = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Save changes" }));

afterEach(() => {
  window.location.hash = "";
});

test("each group shows its settings with the stored value and the default; the trust rule is read-only", async () => {
  stub(view(), view({ "admission.recheck_ms": 2_000 }));
  renderWithProviders(<SettingsScreen tab="general" />);
  expect(
    await screen.findByRole("heading", { name: "Settings · General" }),
  ).toBeTruthy();
  const recheck = await screen.findByLabelText("Queue recheck (ms)");
  expect((recheck as HTMLInputElement).value).toBe("2000");
  const hint = document.getElementById(
    recheck.getAttribute("aria-describedby") ?? "",
  );
  expect(hint?.textContent).toContain(
    "Now 2000 ms (2 s); default 5000 ms (5 s)",
  );
  for (const title of ["Admission", "Watchdog", "Reconciler", "Backups"])
    expect(screen.getByText(title)).toBeTruthy();
  expect(
    screen
      .getByRole("switch", { name: "Nightly backup" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  const trust = screen.getByRole("region", { name: "trust rule" });
  expect(trust.textContent).toContain(
    "Adding reviewer makes every review depend on the container host",
  );
  expect(
    await within(trust).findByRole("list", { name: "untrusted roles" }),
  ).toBeTruthy();
  expect(within(trust).queryByRole("textbox")).toBeNull();
  const certification = screen.getByRole("region", {
    name: "certification rule",
  });
  expect(
    within(certification).getByText("On: uncertified runners are refused")
      .dataset.tone,
  ).toBe("success");
  expect(within(certification).queryByRole("switch")).toBeNull();
  expect(
    screen.queryByRole("switch", { name: "Require certified runners" }),
  ).toBeNull();
  // "changes only from a shell" now names the command that does it.
  expect(certification.textContent).toContain(
    "frm settings set admission.require_certified 0|1 --yes",
  );
  expect(trust.textContent).toContain(
    "frm settings set executors.untrusted_roles <role,…> --yes",
  );
});

test("Save PUTs only the changed keys, zod-checked, and says how many", async () => {
  const fetchMock = stub(
    view({ "admission.recheck_ms": 2_000, "backup.enabled": 0 }),
  );
  renderWithProviders(<SettingsScreen tab="general" />);
  const user = userEvent.setup();
  const recheck = await screen.findByLabelText("Queue recheck (ms)");
  await user.clear(recheck);
  await user.type(recheck, "2000");
  await user.click(screen.getByRole("switch", { name: "Nightly backup" }));
  await save(user);
  // A save is an event: it is told in a toast, not left beside the buttons.
  expect(
    await screen.findByRole("status", { name: "Saved 2 settings" }),
  ).toBeTruthy();
  expect(callsTo(fetchMock, SETTINGS, "PUT")).toHaveLength(1);
  expect(bodyOf(fetchMock, SETTINGS, "PUT")).toEqual({
    settings: { "admission.recheck_ms": 2_000, "backup.enabled": 0 },
  });
  expect(input("Queue recheck (ms)").value).toBe("2000");
});

test("a value out of bounds is refused on the field, and nothing is sent", async () => {
  const fetchMock = stub();
  renderWithProviders(<SettingsScreen tab="general" />);
  const user = userEvent.setup();
  const keep = await screen.findByLabelText("Backups kept");
  await user.clear(keep);
  await user.type(keep, "0");
  await save(user);
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Enter a whole number from 1 to 1000.",
  );
  expect(keep.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByRole("status", { name: "" }).textContent).toBe(
    "Nothing saved: fix the marked settings.",
  );
  expect(callsTo(fetchMock, SETTINGS, "PUT")).toHaveLength(0);
});

test("with nothing changed, Save sends nothing and says so", async () => {
  const fetchMock = stub();
  renderWithProviders(<SettingsScreen tab="general" />);
  const user = userEvent.setup();
  await screen.findByLabelText("Queue recheck (ms)");
  await save(user);
  expect(await screen.findByText("Nothing changed.")).toBeTruthy();
  expect(callsTo(fetchMock, SETTINGS, "PUT")).toHaveLength(0);
});

test("the server's refusal is shown as it came", async () => {
  stub(apiError(400, "validation", "backup.keep: too big"));
  renderWithProviders(<SettingsScreen tab="general" />);
  const user = userEvent.setup();
  const keep = await screen.findByLabelText("Backups kept");
  await user.clear(keep);
  await user.type(keep, "30");
  await save(user);
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Not saved: backup.keep: too big",
  );
});

test("the Roles tab moves the hash to #/settings/roles", async () => {
  stub();
  renderWithProviders(<SettingsScreen tab="general" />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Roles" }));
  expect(window.location.hash).toBe("#/settings/roles");
});
