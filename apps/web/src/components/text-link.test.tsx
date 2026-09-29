import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { TextLink, isExternal, textLinkClass } from "@/components/text-link";

// One link recipe: the primary colour, underlined on hover and focus, the focus ring; an
// external one opens a new tab and says so.

test("an app link keeps this tab, in the one recipe", () => {
  render(<TextLink href="#/tickets">Tickets</TextLink>);
  const link = screen.getByRole("link", { name: "Tickets" });
  expect(link.getAttribute("href")).toBe("#/tickets");
  expect(link.getAttribute("target")).toBe(null);
  expect(link.getAttribute("rel")).toBe(null);
  for (const cls of [
    "text-primary",
    "hover:underline",
    "focus-visible:underline",
    "focus-visible:outline-ring",
  ])
    expect(link.className).toContain(cls);
  expect(link.querySelector("svg")).toBe(null);
});

test("an external link opens a new tab without the opener, with an icon and words for it", () => {
  render(
    <TextLink href="https://example.atlassian.net/browse/X-1">X-1</TextLink>,
  );
  const link = screen.getByRole("link", { name: "X-1 (opens in a new tab)" });
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noreferrer noopener");
  expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
});

test("`external` marks a link the URL alone does not", () => {
  render(
    <TextLink href="/files/report.html" external>
      report
    </TextLink>,
  );
  expect(
    screen
      .getByRole("link", { name: "report (opens in a new tab)" })
      .getAttribute("target"),
  ).toBe("_blank");
  expect(isExternal("http://host/x")).toBe(true);
  expect(isExternal("#/fleet")).toBe(false);
});

test("an inline link keeps a quiet underline, for prose", () => {
  expect(textLinkClass({ inline: true })).toContain("underline ");
  expect(textLinkClass()).not.toMatch(/(^| )underline( |$)/);
});
