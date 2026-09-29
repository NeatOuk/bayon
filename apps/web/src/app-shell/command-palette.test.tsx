import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { RECENT_KEY } from "@/app-shell/palette-model";
import { renderIde } from "@/test/ide-harness";
import { projectView } from "@/test/project-fixtures";

// The command palette: ⌘K / Ctrl+K or Search; screens, the current project's views,
// projects, agents and a ticket by number; arrows and Enter; Esc; Recent.

const BAYON = projectView();

afterEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
});

const input = () =>
  screen.getByRole("combobox", {
    name: "Search screens, projects, agents and tickets",
  });
const optionNames = () =>
  screen.getAllByRole("option").map((option) => option.textContent);
const highlighted = () =>
  screen
    .getAllByRole("option")
    .find((option) => option.hasAttribute("data-highlighted"));

/** The app on `hash`, ready: the sidebar's projects (or the project's explorer) have arrived. */
async function ready(hash = "#/") {
  renderIde(hash, BAYON);
  if (hash.startsWith("#/p/"))
    await screen.findByRole("navigation", { name: "explorer" });
  else await screen.findByRole("link", { name: /^bayon/ });
}

test("⌘K opens it, Esc closes it; Ctrl+K and the Search button open it too", async () => {
  await ready();
  const user = userEvent.setup();
  await user.keyboard("{Meta>}k{/Meta}");
  const dialog = await screen.findByRole("dialog", { name: "Search" });
  await waitFor(() => expect(document.activeElement).toBe(input()));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(dialog.isConnected).toBe(false);

  await user.keyboard("{Control>}k{/Control}");
  expect(await screen.findByRole("dialog", { name: "Search" })).toBeTruthy();
  await user.keyboard("{Control>}k{/Control}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  const search = screen.getByRole("button", { name: "Search everywhere" });
  expect(search.getAttribute("aria-keyshortcuts")).toBe("Meta+K Control+K");
  await user.click(search);
  expect(await screen.findByRole("dialog", { name: "Search" })).toBeTruthy();
});

test("the list is grouped under headings, and typing narrows it", async () => {
  await ready();
  const user = userEvent.setup();
  await user.keyboard("{Meta>}k{/Meta}");
  const listbox = await screen.findByRole("listbox");
  const groups = within(listbox)
    .getAllByRole("group")
    .map((group) => group.getAttribute("aria-labelledby"))
    .map((id) => document.getElementById(id ?? "")?.textContent);
  expect(groups).toEqual(["Screens", "Projects", "Agents"]);

  await user.type(input(), "exec");
  await waitFor(() => expect(optionNames()).toEqual(["Executors"]));
  await user.clear(input());
  await user.type(input(), "builder");
  await waitFor(() =>
    expect(optionNames()).toEqual(["bayon-builderbayon · builder"]),
  );
  await user.clear(input());
  await user.type(input(), "nothing like this");
  expect(await screen.findByText("Nothing matches.")).toBeTruthy();
});

test("arrows move the highlight and Enter opens it, closing the palette", async () => {
  await ready();
  const user = userEvent.setup();
  await user.keyboard("{Meta>}k{/Meta}");
  await user.type(await screen.findByRole("combobox"), "set");
  await waitFor(() =>
    expect(optionNames()).toEqual([
      "Settings",
      "Settings · Notifications",
      "Settings · Roles",
    ]),
  );
  await waitFor(() => expect(highlighted()?.textContent).toBe("Settings"));
  await user.keyboard("{ArrowDown}");
  expect(highlighted()?.textContent).toBe("Settings · Notifications");
  await user.keyboard("{ArrowDown}{Enter}");
  await waitFor(() => expect(window.location.hash).toBe("#/settings/roles"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("#45, 45 or FRM-45 jumps to the ticket; inside a project it opens as a tab", async () => {
  await ready();
  const user = userEvent.setup();
  for (const query of ["#45", "FRM-45", "frm-45", "45"]) {
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(await screen.findByRole("combobox"), query);
    await waitFor(() =>
      expect(highlighted()?.textContent).toBe("Open ticket 45"),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }
  await user.keyboard("{Meta>}k{/Meta}");
  await user.type(await screen.findByRole("combobox"), "#45");
  await waitFor(() =>
    expect(highlighted()?.textContent).toBe("Open ticket 45"),
  );
  await user.keyboard("{Enter}");
  await waitFor(() => expect(window.location.hash).toBe("#/tickets/45"));
});

test("inside a project its views are a group, and a ticket opens beside the view", async () => {
  await ready("#/p/ws-bayon/history");
  const user = userEvent.setup();
  await user.keyboard("{Meta>}k{/Meta}");
  const listbox = await screen.findByRole("listbox");
  const bayon = within(listbox).getByRole("group", { name: "bayon" });
  expect(
    within(bayon)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toContain("Project settingsbayon");
  await user.type(input(), "#7");
  await waitFor(() => expect(highlighted()?.textContent).toBe("Open ticket 7"));
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(window.location.hash).toBe("#/p/ws-bayon/history?open=ticket:7"),
  );
});

test("a pick is remembered under Recent, first, the next time it opens", async () => {
  await ready();
  const user = userEvent.setup();
  await user.keyboard("{Meta>}k{/Meta}");
  await user.type(await screen.findByRole("combobox"), "audit");
  await waitFor(() => expect(highlighted()?.textContent).toBe("Audit"));
  await user.keyboard("{Enter}");
  await waitFor(() => expect(window.location.hash).toBe("#/audit"));
  expect(JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]")).toEqual([
    { id: "screen:audit", label: "Audit", href: "#/audit", hint: "Screens" },
  ]);

  await user.keyboard("{Meta>}k{/Meta}");
  const recent = await screen.findByRole("group", { name: "Recent" });
  expect(
    within(recent)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["AuditScreens"]);
});

test("Ctrl+K inside a terminal is the terminal's; ⌘K there still opens the palette", async () => {
  await ready();
  const terminal = document.createElement("div");
  terminal.className = "xterm";
  const helper = document.createElement("textarea");
  terminal.append(helper);
  document.body.append(terminal);
  helper.focus();
  fireEvent.keyDown(helper, { key: "k", ctrlKey: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.keyDown(helper, { key: "k", metaKey: true });
  expect(await screen.findByRole("dialog", { name: "Search" })).toBeTruthy();
  terminal.remove();
});
