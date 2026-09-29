import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { Id, shortenId } from "@/components/id";
import { renderWithProviders } from "@/test/render";

// Ids: monospace, a ULID shortened in the middle with the whole value kept for the title
// and a screen reader, and a copy button that writes the clipboard and says so.

const ULID = "01J9ZK8Q4M3N7P2R5T6V8W9XYZ";

afterEach(() => {
  vi.restoreAllMocks();
});

test("a ULID reads shortened in the middle; the whole id is the title and the spoken text", () => {
  renderWithProviders(<Id value={ULID} />);
  expect(shortenId(ULID)).toBe("01J9…W9XYZ".replace("W9XYZ", ULID.slice(-6)));
  const shown = screen.getByText(shortenId(ULID));
  expect(shown.getAttribute("aria-hidden")).toBe("true");
  expect(shown.parentElement?.getAttribute("title")).toBe(ULID);
  expect(shown.parentElement?.className).toContain("font-mono");
  expect(screen.getByText(ULID).className).toContain("sr-only");
});

test("a short id reads whole, and `short` can be turned off", () => {
  renderWithProviders(
    <>
      <Id value="local" />
      <Id value={ULID} short={false} />
    </>,
  );
  expect(screen.getByText("local").getAttribute("title")).toBe("local");
  expect(screen.getByText(ULID).getAttribute("title")).toBe(ULID);
  expect(shortenId("fixture-run")).toBe("fixture-run");
});

test("copy writes the whole id to the clipboard and says so", async () => {
  const user = userEvent.setup();
  const writeText = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValue(undefined);
  renderWithProviders(<Id value={ULID} copy label="session id" />);
  await user.click(screen.getByRole("button", { name: "Copy the session id" }));
  expect(writeText).toHaveBeenCalledWith(ULID);
  // Said beside the button, politely: a tick, and a line for a screen reader; not a toast.
  const said = await screen.findByText("Copied the session id.");
  expect(said.getAttribute("aria-live")).toBe("polite");
  expect(screen.queryByRole("status", { name: /Copied/ })).toBe(null);
});

test("a clipboard that refuses is said, not swallowed", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new Error("denied"),
  );
  renderWithProviders(<Id value={ULID} copy label="pulse id" />);
  await user.click(screen.getByRole("button", { name: "Copy the pulse id" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Could not copy the pulse id",
  );
});
