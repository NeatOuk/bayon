import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { projectView, projectsView } from "@/test/project-fixtures";
import { renderWithProviders, stubFetch } from "@/test/render";
import {
  ticketDetail,
  ticketSummary,
  ticketView,
  ticketsPage,
} from "@/test/ticket-fixtures";
import { TicketBoard } from "@/tickets/ticket-board";
import { TicketScreen } from "@/tickets/ticket-screen";

// A mirrored ticket's `KEY ↗` chip: on a board card and in the ticket view's header,
// linking `<site>/browse/<KEY>` — and never to anything but an https://<name>.atlassian.net site.

const SITE = "https://acme.atlassian.net";
const LIST = "/api/v1/tickets?limit=100";
const PROJECTS = "/api/v1/projects";
const DETAIL = "/api/v1/tickets/7";
const SOURCE = { url: SITE, email: "me@acme.co", jql: "project = KITE" };

const mirrored = (originRef: string, workspace = "ws-bayon") =>
  ticketSummary({
    num: 1,
    workspace_id: workspace,
    origin: "jira",
    origin_ref: originRef,
  });

const renderBoard = (
  ticket: ReturnType<typeof ticketSummary>,
  site: string | null = SITE,
) => {
  stubFetch({
    [LIST]: ticketsPage([ticket]),
    [PROJECTS]: projectsView(
      projectView({
        jira: site === null ? null : { ...SOURCE, url: site },
      }),
    ),
  });
  renderWithProviders(<TicketBoard project={null} />);
};

const renderTicket = (bodyMd: string, workspace: string | null) => {
  stubFetch({
    [DETAIL]: ticketDetail(
      ticketView({
        num: 7,
        workspace_id: workspace,
        origin: "jira",
        origin_ref: "KITE-7",
        body_md: bodyMd,
      }),
    ),
    [PROJECTS]: projectsView(projectView({ jira: SOURCE })),
  });
  renderWithProviders(<TicketScreen num={7} backHref={null} />);
};

test("a mirrored card links its issue on the project's site, beside the card's own link", async () => {
  renderBoard(mirrored("KITE-12"));
  const backlog = await screen.findByRole("region", { name: /^backlog$/i });
  const chip = await within(backlog).findByRole("link", {
    name: "KITE-12 in Jira (opens in a new tab)",
  });
  expect(chip.getAttribute("href")).toBe(`${SITE}/browse/KITE-12`);
  expect(chip.getAttribute("target")).toBe("_blank");
  expect(chip.getAttribute("rel")).toBe("noreferrer");
  const card = within(backlog).getByRole("link", { name: /FRM-1/ });
  expect(card.getAttribute("href")).toBe("#/tickets/1");
  // Never a link inside a link.
  expect(card.contains(chip)).toBe(false);
});

test("a ticket not mirrored from Jira has no chip", async () => {
  stubFetch({
    [LIST]: ticketsPage([ticketSummary({ num: 1, origin_ref: "KITE-1" })]),
    [PROJECTS]: projectsView(projectView({ jira: SOURCE })),
  });
  renderWithProviders(<TicketBoard project={null} />);
  const backlog = await screen.findByRole("region", { name: /^backlog$/i });
  expect(within(backlog).getAllByRole("link")).toHaveLength(1);
  expect(within(backlog).queryByText("KITE-1")).toBeNull();
});

test.each([
  "javascript:alert(1)",
  "KITE-1/../../secure/Dashboard.jspa",
  "//evil.example.com/KITE-1",
])("a hostile origin_ref %j is text, never a link", async (originRef) => {
  renderBoard(mirrored(originRef));
  const backlog = await screen.findByRole("region", { name: /^backlog$/i });
  await within(backlog).findByText(originRef);
  expect(within(backlog).getAllByRole("link")).toHaveLength(1);
  expect(document.querySelector('a[target="_blank"]')).toBeNull();
});

test("a project site that is not Atlassian's gives the chip no href", async () => {
  renderBoard(mirrored("KITE-12"), "https://evil.example.com");
  const backlog = await screen.findByRole("region", { name: /^backlog$/i });
  await within(backlog).findByText("KITE-12");
  expect(within(backlog).getAllByRole("link")).toHaveLength(1);
  expect(document.querySelector('a[href*="evil"]')).toBeNull();
});

test("the ticket view's header links the issue on its project's site", async () => {
  renderTicket("", "ws-bayon");
  const chip = await screen.findByRole("link", {
    name: "KITE-7 in Jira (opens in a new tab)",
  });
  expect(chip.getAttribute("href")).toBe(`${SITE}/browse/KITE-7`);
  expect(chip.closest("[data-slot=page-header], header")).not.toBeNull();
});

test("a project that no longer mirrors: the body's own Atlassian link gives the site", async () => {
  renderTicket(
    "Jira: [KITE-7](https://other.atlassian.net/browse/KITE-7)\n\nthe issue",
    "ws-gone",
  );
  const chip = await screen.findByRole("link", {
    name: "KITE-7 in Jira (opens in a new tab)",
  });
  expect(chip.getAttribute("href")).toBe(
    "https://other.atlassian.net/browse/KITE-7",
  );
});

test("a body link to a host that is not Atlassian's gives the chip no href", async () => {
  renderTicket(
    "Jira: [KITE-7](https://acme.atlassian.net.evil.com/browse/KITE-7)",
    "ws-gone",
  );
  const header = (
    await screen.findByRole("heading", { name: /FRM-7/ })
  ).closest<HTMLElement>("[data-slot=page-header], header");
  if (header === null) throw new Error("no header");
  expect(within(header).getByText("KITE-7")).toBeTruthy();
  expect(within(header).queryByRole("link")).toBeNull();
});
