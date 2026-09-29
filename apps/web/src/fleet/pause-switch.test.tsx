import type { Fleet, OnFleet } from "@bayon/proto";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import type { Feed } from "@/feed/feed";
import { PauseSwitch } from "@/fleet/pause-switch";
import { fleet } from "@/test/fixtures";
import {
  apiError,
  callsTo,
  renderWithProviders,
  silentFeed,
  stubFetch,
} from "@/test/render";

/** `hidden`: while the modal dialog is open the page behind it is out of the accessibility tree. */
const toggle = (hidden = false) =>
  screen.getByRole("switch", { name: "Pause fleet", hidden });
const checked = (hidden = false) => toggle(hidden).getAttribute("aria-checked");
const status = () => screen.getByRole("status");
const PAUSED = { paused: true, changed: true, updated_at: 5 };
const RESUMED = { paused: false, changed: true, updated_at: 6 };

/** Waits until the fleet has loaded and the switch can be used. */
const ready = () =>
  waitFor(() => expect(toggle().hasAttribute("data-disabled")).toBe(false));

test("shows the fleet's state from GET /fleet: running, unchecked, announced in a live region", async () => {
  stubFetch({ "/api/v1/fleet": fleet([]) });
  renderWithProviders(<PauseSwitch />);
  await ready();
  expect(checked()).toBe("false");
  expect(status().getAttribute("aria-live")).toBe("polite");
  expect(status().textContent).toBe("Fleet running");
});

test("pausing asks first; Cancel sends nothing and leaves it running", async () => {
  const fetchMock = stubFetch({ "/api/v1/fleet": fleet([]) });
  renderWithProviders(<PauseSwitch />);
  await ready();
  const user = userEvent.setup();
  await user.click(toggle());
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Pause the fleet?")).toBeTruthy();
  expect(dialog.textContent).toContain(
    "turns in flight and hand-off packets finish",
  );
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(callsTo(fetchMock, "/api/v1/fleet/pause", "POST")).toHaveLength(0);
  expect(checked()).toBe("false");
});

test("confirmed, it POSTs /fleet/pause once; the switch and the live region say paused", async () => {
  const fetchMock = stubFetch({
    "/api/v1/fleet": fleet([]),
    "/api/v1/fleet/pause": PAUSED,
  });
  renderWithProviders(<PauseSwitch />);
  await ready();
  const user = userEvent.setup();
  await user.click(toggle());
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Pause fleet" }));
  await waitFor(() => expect(checked()).toBe("true"));
  expect(status().textContent).toBe("Fleet paused");
  expect(callsTo(fetchMock, "/api/v1/fleet/pause", "POST")).toHaveLength(1);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

test("paused, it offers Resume, which POSTs /fleet/resume", async () => {
  const fetchMock = stubFetch({
    "/api/v1/fleet": fleet([], { paused: true }),
    "/api/v1/fleet/resume": RESUMED,
  });
  renderWithProviders(<PauseSwitch />);
  await ready();
  expect(checked()).toBe("true");
  const user = userEvent.setup();
  await user.click(toggle());
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Resume the fleet?")).toBeTruthy();
  await user.click(
    within(dialog).getByRole("button", { name: "Resume fleet" }),
  );
  await waitFor(() => expect(checked()).toBe("false"));
  expect(callsTo(fetchMock, "/api/v1/fleet/resume", "POST")).toHaveLength(1);
  expect(status().textContent).toBe("Fleet running");
});

test("a fleet frame flips it live: a pause from frm or another tab shows at once", async () => {
  let push: OnFleet | undefined;
  const feed: Feed = {
    ...silentFeed,
    subscribeFleet: (on) => {
      push = on;
      return () => {
        push = undefined;
      };
    },
  };
  stubFetch({ "/api/v1/fleet": fleet([]) });
  renderWithProviders(<PauseSwitch />, { feed });
  await ready();
  const paused: Fleet = fleet([], { paused: true });
  act(() => {
    if (push === undefined)
      throw new Error("the fleet topic is not subscribed");
    push(paused, 1);
  });
  // The query cache tells its observers on a later tick.
  await waitFor(() => expect(checked()).toBe("true"));
  expect(status().textContent).toBe("Fleet paused");
});

test("a refused POST keeps the dialog open with the server's reason; the state is unchanged", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([]),
    "/api/v1/fleet/pause": apiError(503, "db_busy", "the database is busy"),
  });
  renderWithProviders(<PauseSwitch />);
  await ready();
  const user = userEvent.setup();
  await user.click(toggle());
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Pause fleet" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "Not paused: the database is busy",
  );
  expect(screen.getByRole("alertdialog")).toBe(dialog);
  // Behind the open modal its label is hidden too, so it has no name there: the one switch.
  expect(
    screen.getByRole("switch", { hidden: true }).getAttribute("aria-checked"),
  ).toBe("false");
});
