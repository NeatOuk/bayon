import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { App } from "@/app";
import { BASE_TITLE } from "@/inbox/inbox-count";
import { fleet } from "@/test/fixtures";
import { inboxItem, inboxPage } from "@/test/inbox-fixtures";
import { silentFeed, stubFetch } from "@/test/render";

// The open count where the operator sees it without opening the Inbox: on the nav link,
// in the tab's title, and on the tab's icon.

const renderApp = () =>
  render(
    <App
      feed={silentFeed}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => inboxItem({ id: `R${i}` }));

const inboxLink = () => screen.getByRole("link", { name: /^Inbox/ });

afterEach(() => {
  window.location.hash = "";
  document.title = BASE_TITLE;
  for (const link of document.head.querySelectorAll('link[rel="icon"]'))
    link.remove();
});

test("the Inbox link carries the count, and the tab title and icon with it", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([]),
    "/api/v1/inbox?status=open": inboxPage(items(3)),
  });
  renderApp();
  await waitFor(() => expect(within(inboxLink()).getByText("3")).toBeTruthy());
  expect(
    within(inboxLink()).getByLabelText("3 open in the inbox"),
  ).toBeTruthy();
  await waitFor(() => expect(document.title).toBe(`(3) ${BASE_TITLE}`));
  const icon = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
  expect(decodeURIComponent(icon?.href ?? "")).toContain(">3</text>");
});

test("a full page counts as at least that many", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([]),
    "/api/v1/inbox?status=open": inboxPage(items(50), "next"),
  });
  renderApp();
  await waitFor(() =>
    expect(within(inboxLink()).getByText("50+")).toBeTruthy(),
  );
  await waitFor(() => expect(document.title).toBe(`(50+) ${BASE_TITLE}`));
});

test("nothing waiting: no badge, and the plain title", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([]),
    "/api/v1/inbox?status=open": inboxPage([]),
  });
  renderApp();
  expect(await screen.findByText(/no live sessions/i)).toBeTruthy();
  await waitFor(() => expect(document.title).toBe(BASE_TITLE));
  expect(within(inboxLink()).queryByText(/^\d/)).toBeNull();
});
