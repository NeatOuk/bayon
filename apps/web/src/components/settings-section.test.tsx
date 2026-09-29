import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { SectionSave, SettingsSection } from "@/components/settings-section";

test("a section is one card: its title an h2 naming it, its description beside the controls", () => {
  render(
    <SettingsSection title="QA harness" description="What has to pass.">
      <input aria-label="command" />
    </SettingsSection>,
  );
  const section = screen.getByRole("region", { name: "QA harness" });
  expect(
    within(section).getByRole("heading", { level: 2, name: "QA harness" }),
  ).toBeTruthy();
  expect(within(section).getByText("What has to pass.")).toBeTruthy();
  // Two columns once its own box is wide: a container query, so an IDE view reads the same.
  expect(section.className).toContain("@container");
});

test("with a form, the footer's Save submits it; a failure shows beside the button", async () => {
  const onSubmit = vi.fn();
  const { rerender } = render(
    <SettingsSection
      title="Docs"
      form={{ label: "Documentation source", onSubmit }}
      footer={<SectionSave label="Save docs settings" />}
    >
      <input aria-label="space" />
    </SettingsSection>,
  );
  const form = screen.getByRole("form", { name: "Documentation source" });
  const footer = form.querySelector("[data-slot=section-footer]");
  const save = screen.getByRole("button", { name: "Save docs settings" });
  expect(footer?.contains(save)).toBe(true);
  await userEvent.click(save);
  expect(onSubmit).toHaveBeenCalledTimes(1);

  rerender(
    <SettingsSection
      title="Docs"
      form={{ label: "Documentation source", onSubmit }}
      footer={
        <SectionSave label="Save docs settings" error="validation: bad key" />
      }
    >
      <input aria-label="space" />
    </SettingsSection>,
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "Not saved: validation: bad key",
  );
});

test("a pending save says so and cannot be pressed twice", () => {
  render(<SectionSave label="Save" pending />);
  const button = screen.getByRole("button", { name: "Saving…" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
});
