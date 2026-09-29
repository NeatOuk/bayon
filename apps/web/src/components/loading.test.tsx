import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { Loading } from "@/components/loading";
import { QueryError } from "@/components/query-error";
import { Alert } from "@/components/ui/alert";

// Loading and failed queries: one polite status line while a query loads, and an alert with
// the server's words and a Retry that asks again.

test("loading is one status line with a hidden spinner, and skeleton lines when asked", () => {
  const { container } = render(
    <Loading label="Loading the board…" lines={3} />,
  );
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("Loading the board…");
  expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  const skeletons = container.querySelectorAll("[data-slot=skeleton]");
  expect(skeletons).toHaveLength(3);
  for (const s of skeletons) expect(s.getAttribute("aria-hidden")).toBe("true");
});

test("a failed query says what is unavailable, why, and retries on asking", async () => {
  const onRetry = vi.fn();
  render(
    <QueryError
      title="The inbox is unavailable"
      error={new Error("internal: db down")}
      onRetry={onRetry}
    />,
  );
  const alert = screen.getByRole("alert");
  expect(alert.className).toContain("bg-danger-subtle");
  expect(alert.textContent).toContain("The inbox is unavailable");
  expect(alert.textContent).toContain("internal: db down");
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test("without onRetry there is nothing to press", () => {
  render(<QueryError title="Spend is unavailable" error={new Error("x")} />);
  expect(screen.queryByRole("button")).toBe(null);
});

test("an alert is an alert unless the caller says it is a note", () => {
  render(
    <>
      <Alert status="warning">interrupts</Alert>
      <Alert status="warning" role="note">
        stands
      </Alert>
    </>,
  );
  expect(screen.getByRole("alert").textContent).toBe("interrupts");
  expect(screen.getByRole("note").textContent).toBe("stands");
});
