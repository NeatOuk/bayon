import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { RadioChoices } from "@/components/radio-choices";

// RadioChoices over base-ui's RadioGroup: a named group, each radio named by its label and
// described by its hint, the arrow keys moving the choice.

type Mode = "none" | "push" | "pull_request";
const LABELS: Record<Mode, string> = {
  none: "Keep the work here",
  push: "Push the branch",
  pull_request: "Push and open a pull request",
};
const HINTS: Record<Mode, string> = {
  none: "Nothing leaves.",
  push: "The branch is pushed.",
  pull_request: "And a pull request.",
};

function Harness({ onChange }: { readonly onChange: (m: Mode) => void }) {
  const [value, setValue] = useState<Mode>("none");
  return (
    <RadioChoices
      legend="What leaves"
      values={["none", "push", "pull_request"]}
      labels={LABELS}
      hints={HINTS}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

test("a named group of radios, each named by its label and described by its hint", () => {
  render(<Harness onChange={() => undefined} />);
  expect(screen.getByRole("radiogroup", { name: "What leaves" })).toBeTruthy();
  const none = screen.getByRole("radio", { name: "Keep the work here" });
  expect(none.getAttribute("aria-checked")).toBe("true");
  expect(
    document.getElementById(none.getAttribute("aria-describedby") ?? "")
      ?.textContent,
  ).toBe("Nothing leaves.");
  expect(
    screen
      .getByRole("radio", { name: "Push the branch" })
      .getAttribute("aria-checked"),
  ).toBe("false");
});

test("a click chooses; the arrow keys move the choice", async () => {
  const onChange = vi.fn<(m: Mode) => void>();
  render(<Harness onChange={onChange} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("radio", { name: "Push the branch" }));
  expect(onChange).toHaveBeenLastCalledWith("push");
  expect(
    screen
      .getByRole("radio", { name: "Push the branch" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  await user.keyboard("{ArrowDown}");
  expect(onChange).toHaveBeenLastCalledWith("pull_request");
  expect(
    screen
      .getByRole("radio", { name: "Push and open a pull request" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("a label click chooses its radio", async () => {
  const onChange = vi.fn<(m: Mode) => void>();
  render(<Harness onChange={onChange} />);
  await userEvent
    .setup()
    .click(screen.getByText("Push and open a pull request"));
  expect(onChange).toHaveBeenLastCalledWith("pull_request");
});
