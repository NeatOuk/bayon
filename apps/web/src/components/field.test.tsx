import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  DescriptionItem,
  DescriptionList,
} from "@/components/description-list";
import { Field } from "@/components/field";
import { Input } from "@/components/ui/input";

// The one Field: label, hint and problem wired by id; and the one DescriptionList.

test("a field labels its control and describes it by its hint", () => {
  render(
    <Field label="Command" hint="Runs on the reviewed commit.">
      {({ id, describedBy, invalid }) => (
        <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} />
      )}
    </Field>,
  );
  const input = screen.getByLabelText("Command");
  expect(input.getAttribute("aria-invalid")).toBe("false");
  const hint = document.getElementById(
    input.getAttribute("aria-describedby") ?? "",
  );
  expect(hint?.textContent).toBe("Runs on the reviewed commit.");
});

test("a problem makes it invalid and is read first; announced only when asked", () => {
  const { rerender } = render(
    <Field label="Site" hint="Like name.atlassian.net." error="Use https.">
      {({ id, describedBy, invalid }) => (
        <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} />
      )}
    </Field>,
  );
  const input = screen.getByLabelText("Site");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  const [first, second] = (input.getAttribute("aria-describedby") ?? "").split(
    " ",
  );
  expect(document.getElementById(first ?? "")?.textContent).toBe("Use https.");
  expect(document.getElementById(second ?? "")?.textContent).toBe(
    "Like name.atlassian.net.",
  );
  expect(screen.queryByRole("alert")).toBe(null);
  rerender(
    <Field label="Site" error="Use https." announce>
      {({ id }) => <Input id={id} />}
    </Field>,
  );
  expect(screen.getByRole("alert").textContent).toBe("Use https.");
});

test("an inline field puts the control before its label, and takes a node wired by id", () => {
  const { container } = render(
    <Field label="Enabled" layout="inline" id="on">
      <input id="on" type="checkbox" />
    </Field>,
  );
  expect(screen.getByLabelText("Enabled").id).toBe("on");
  const row = container.querySelector("[data-slot=field] > div");
  expect(row?.firstElementChild?.tagName).toBe("INPUT");
});

test("a description list pairs each term with its value, from items and children", () => {
  render(
    <DescriptionList aria-label="facts" items={[["Trigger", "cron"]]}>
      <DescriptionItem term="Cost">$0.12</DescriptionItem>
    </DescriptionList>,
  );
  const terms = screen.getAllByRole("term").map((t) => t.textContent);
  const values = screen.getAllByRole("definition").map((d) => d.textContent);
  expect(terms).toEqual(["Trigger", "Cost"]);
  expect(values).toEqual(["cron", "$0.12"]);
  expect(screen.getByLabelText("facts").className).toContain(
    "grid-cols-[max-content_minmax(0,1fr)]",
  );
});

test("a mono list sets its keys and values in monospace", () => {
  render(<DescriptionList mono items={[["disk.free_pct", "42"]]} />);
  expect(screen.getByRole("term").className).toContain("font-mono");
  expect(screen.getByRole("definition").className).toContain("font-mono");
});
