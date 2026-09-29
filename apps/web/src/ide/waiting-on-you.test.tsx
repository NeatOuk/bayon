import { screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { projectTicketsUrl, renderIde } from "@/test/ide-harness";
import { projectView } from "@/test/project-fixtures";
import { ticketSummary, ticketsPage } from "@/test/ticket-fixtures";

// The Overview's "Waiting on you": the project's tickets whose next step waits on the
// operator, each with the server's reason and a way on; many that share one reason are one row.

const PROJECT = projectView({ id: "ws-shop", name: "shop" });
const PAUSED = "Project is paused: nothing new starts until you resume it";

afterEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
});

const panel = () => screen.findByRole("region", { name: "waiting on you" });

test("each ticket that waits on you, its reason and its action; the rest are not listed", async () => {
  renderIde("#/p/ws-shop/overview", PROJECT, {
    [projectTicketsUrl("ws-shop")]: ticketsPage([
      ticketSummary(
        {
          num: 3,
          title: "store choice",
          open_questions: 1,
          workspace_id: "ws-shop",
        },
        0,
        "Waiting on your answer to 1 question",
      ),
      ticketSummary(
        {
          num: 4,
          title: "flaky review",
          status: "code_review",
          workspace_id: "ws-shop",
        },
        0,
        "Review can't run: no eligible reviewer",
      ),
      ticketSummary({
        num: 5,
        title: "in hand",
        status: "building",
        workspace_id: "ws-shop",
      }),
    ]),
  });
  const list = await within(await panel()).findByRole("list", {
    name: "tickets waiting on you",
  });
  const rows = within(list).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  const [questions, review] = rows;
  expect(
    within(questions ?? list).getByText("Waiting on your answer to 1 question"),
  ).toBeTruthy();
  expect(
    within(questions ?? list)
      .getByRole("link", { name: "Answer" })
      .getAttribute("href"),
  ).toBe("#/p/ws-shop/inbox?ticket=3");
  expect(
    within(review ?? list)
      .getByRole("link", { name: /FRM-4 · flaky review/ })
      .getAttribute("href"),
  ).toBe("#/p/ws-shop/overview?open=ticket:4");
  expect(
    within(review ?? list)
      .getByRole("link", { name: "Open" })
      .getAttribute("href"),
  ).toBe("#/p/ws-shop/overview?open=ticket:4");
  expect(within(list).queryByText(/in hand/)).toBeNull();
});

test("tickets that share one reason are one row, to the board", async () => {
  renderIde("#/p/ws-shop/overview", PROJECT, {
    [projectTicketsUrl("ws-shop")]: ticketsPage(
      [1, 2, 3, 4].map((num) =>
        ticketSummary({ num, workspace_id: "ws-shop" }, 0, PAUSED),
      ),
    ),
  });
  const list = await within(await panel()).findByRole("list", {
    name: "tickets waiting on you",
  });
  const [row, ...rest] = within(list).getAllByRole("listitem");
  expect(rest).toEqual([]);
  expect(row?.textContent).toContain(`4 tickets${PAUSED}`);
  expect(
    within(row ?? list)
      .getByRole("link", { name: "See them on the board" })
      .getAttribute("href"),
  ).toBe("#/p/ws-shop/tickets");
});

test("nothing waiting says so", async () => {
  renderIde("#/p/ws-shop/overview", PROJECT);
  expect(
    await within(await panel()).findByText("Nothing waits on you."),
  ).toBeTruthy();
});
