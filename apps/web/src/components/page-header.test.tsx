import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Card, CardTitle } from "@/components/ui/card";
import { Panel } from "@/tickets/panel";

// Headings: one h1 per screen at one size, section titles at their level, and a panel's
// or a card's title a real heading rather than a div.

test("a page header is the screen's one h1, with its meta and its actions", () => {
  render(
    <PageHeader
      title="Tickets"
      meta={<span>12 open</span>}
      actions={<button type="button">New ticket</button>}
    />,
  );
  const h1 = screen.getByRole("heading", { level: 1, name: "Tickets" });
  expect(h1.className).toContain("text-xl");
  expect(h1.className).toContain("font-semibold");
  expect(screen.getByText("12 open").closest("[data-slot=page-meta]")).not.toBe(
    null,
  );
  expect(
    screen
      .getByRole("button", { name: "New ticket" })
      .closest("[data-slot=page-actions]"),
  ).not.toBe(null);
});

test("a page header without meta or actions renders neither slot", () => {
  const { container } = render(<PageHeader title="Spend" />);
  expect(container.querySelector("[data-slot=page-meta]")).toBe(null);
  expect(container.querySelector("[data-slot=page-actions]")).toBe(null);
});

test("a section title renders the level it is given, h2 by default", () => {
  render(
    <>
      <SectionTitle>Repos</SectionTitle>
      <SectionTitle as="h3">Declared capabilities</SectionTitle>
      <SectionTitle as="h4">Push targets</SectionTitle>
    </>,
  );
  expect(screen.getByRole("heading", { level: 2, name: "Repos" })).toBeTruthy();
  expect(
    screen.getByRole("heading", { level: 3, name: "Declared capabilities" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("heading", { level: 4, name: "Push targets" }),
  ).toBeTruthy();
});

test("a panel is a named region whose title is an h2, or the level it is given", () => {
  render(
    <>
      <Panel label="gates" title="Gates">
        <p>body</p>
      </Panel>
      <Panel label="config" title="Config" level={3}>
        <p>body</p>
      </Panel>
    </>,
  );
  expect(screen.getByRole("region", { name: "gates" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 2, name: "Gates" })).toBeTruthy();
  expect(
    screen.getByRole("heading", { level: 3, name: "Config" }),
  ).toBeTruthy();
});

test("a card title is an h2 unless its place says otherwise", () => {
  render(
    <Card>
      <CardTitle>Question</CardTitle>
      <CardTitle as="h3">FRM-7</CardTitle>
    </Card>,
  );
  expect(
    screen.getByRole("heading", { level: 2, name: "Question" }),
  ).toBeTruthy();
  expect(screen.getByRole("heading", { level: 3, name: "FRM-7" })).toBeTruthy();
});
