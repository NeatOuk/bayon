import type { MissionDiff } from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { MissionScreen } from "@/missions/mission-screen";
import { missionVersion, missionView } from "@/test/fixtures";
import { renderWithProviders, stubFetch } from "@/test/render";

const BASE = "/api/v1/missions/builder-1";

type FetchMock = ReturnType<typeof stubFetch>;

const calls = (fetchMock: FetchMock, method: string, url = BASE) =>
  fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input) === url && (init?.method ?? "GET") === method,
  );

const postBody = (fetchMock: FetchMock, index = 0): unknown => {
  const [, init] = calls(fetchMock, "POST")[index] ?? [];
  return JSON.parse((init?.body as string | undefined) ?? "null") as unknown;
};

const saveButton = () =>
  screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const lawsEditor = () => screen.getByLabelText("Laws") as HTMLTextAreaElement;

const V1 = missionVersion({ version: 1, laws_md: "- tests first" });
const V2 = missionVersion({
  version: 2,
  laws_md: "- tests first\n- theirs",
  note: "saved elsewhere",
});

test("save is blocked until the changelog has a line, then posts the draft on its base", async () => {
  const fetchMock = stubFetch({
    [BASE]: (init: RequestInit | undefined) =>
      init?.method === "POST"
        ? Response.json(missionVersion({ version: 2 }), { status: 201 })
        : missionView([V1]),
  });
  renderWithProviders(<MissionScreen agent="builder-1" />);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Laws"), "\n- no force-push");

  expect(saveButton().disabled).toBe(true);
  expect(screen.getByText(/needs a changelog line/i)).toBeTruthy();
  await user.click(saveButton());
  const changelog = screen.getByLabelText("Changelog");
  await user.type(changelog, "   ");
  expect(saveButton().disabled).toBe(true);
  expect(calls(fetchMock, "POST")).toHaveLength(0);

  await user.clear(changelog);
  await user.type(changelog, "no force-push");
  expect(saveButton().disabled).toBe(false);
  await user.click(saveButton());
  await waitFor(() => expect(calls(fetchMock, "POST")).toHaveLength(1));
  expect(postBody(fetchMock)).toEqual({
    who_md: V1.who_md,
    what_md: V1.what_md,
    how_md: V1.how_md,
    laws_md: "- tests first\n- no force-push",
    note: "no force-push",
    base_version: 1,
  });
  // A save that lands is a toast, not a line left under the form.
  expect(await screen.findByRole("status", { name: "Saved v2" })).toBeTruthy();
});

test("the first save of an agent without a mission starts from base 0", async () => {
  const fetchMock = stubFetch({
    [BASE]: (init: RequestInit | undefined) =>
      init?.method === "POST"
        ? Response.json(missionVersion({ version: 1 }), { status: 201 })
        : missionView([]),
  });
  renderWithProviders(<MissionScreen agent="builder-1" />);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Who"), "A builder.");
  await user.type(screen.getByLabelText("Changelog"), "first");
  await user.click(saveButton());
  await waitFor(() => expect(calls(fetchMock, "POST")).toHaveLength(1));
  expect(postBody(fetchMock)).toMatchObject({
    who_md: "A builder.",
    base_version: 0,
  });
});

test("the changelog is locked while a save is in flight, so nothing typed is lost", async () => {
  const { promise, resolve } = Promise.withResolvers<Response>();
  stubFetch({
    [BASE]: (init: RequestInit | undefined) =>
      init?.method === "POST" ? promise : missionView([V1]),
  });
  renderWithProviders(<MissionScreen agent="builder-1" />);
  const user = userEvent.setup();
  const changelog = (await screen.findByLabelText(
    "Changelog",
  )) as HTMLInputElement;
  await user.type(changelog, "tighten laws");
  await user.click(saveButton());
  await waitFor(() => expect(changelog.disabled).toBe(true));
  resolve(Response.json(missionVersion({ version: 2 }), { status: 201 }));
  await waitFor(() => expect(changelog.disabled).toBe(false));
  expect(changelog.value).toBe("");
});

test("a 409 refetches, shows the newer version and keeps the draft until the operator picks", async () => {
  let saved = false;
  const fetchMock = stubFetch({
    [BASE]: (init: RequestInit | undefined) => {
      if (init?.method !== "POST") return missionView(saved ? [V2, V1] : [V1]);
      if (!saved) {
        saved = true; // someone else saved v2 while this editor held v1
        return Response.json(
          {
            error: {
              class: "conflict",
              message: "mission builder-1 is at v2",
              retryable: false,
              current_version: 2,
            },
          },
          { status: 409 },
        );
      }
      return Response.json(missionVersion({ version: 3 }), { status: 201 });
    },
  });
  renderWithProviders(<MissionScreen agent="builder-1" />);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Laws"), "\n- mine");
  await user.type(screen.getByLabelText("Changelog"), "add mine");
  await user.click(saveButton());

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/v2 was saved/);
  expect(calls(fetchMock, "GET").length).toBeGreaterThanOrEqual(2);
  expect(within(alert).getByText("saved elsewhere")).toBeTruthy();
  expect(within(alert).getByText("theirs")).toBeTruthy();
  expect(lawsEditor().value).toBe("- tests first\n- mine");
  expect(saveButton().disabled).toBe(true);

  await user.click(
    within(alert).getByRole("button", { name: "Keep my draft" }),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(saveButton());
  await waitFor(() => expect(calls(fetchMock, "POST")).toHaveLength(2));
  expect(postBody(fetchMock, 1)).toMatchObject({
    laws_md: "- tests first\n- mine",
    base_version: 2,
  });
});

test("after a 409, Load replaces the draft with the newer version", async () => {
  let saved = false;
  stubFetch({
    [BASE]: (init: RequestInit | undefined) => {
      if (init?.method !== "POST") return missionView(saved ? [V2, V1] : [V1]);
      saved = true;
      return Response.json(
        {
          error: {
            class: "conflict",
            message: "stale",
            retryable: false,
            current_version: 2,
          },
        },
        { status: 409 },
      );
    },
  });
  renderWithProviders(<MissionScreen agent="builder-1" />);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Laws"), "\n- mine");
  await user.type(screen.getByLabelText("Changelog"), "add mine");
  await user.click(saveButton());
  const alert = await screen.findByRole("alert");
  await user.click(within(alert).getByRole("button", { name: "Load v2" }));
  expect(lawsEditor().value).toBe(V2.laws_md);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("the version list diffs an older version against the latest, section by section", async () => {
  const diff: MissionDiff = {
    agent: "builder-1",
    from: 1,
    to: 2,
    sections: [
      {
        section: "who",
        changed: false,
        changes: [{ op: "same", text: "A builder." }],
      },
      {
        section: "laws",
        changed: true,
        changes: [
          { op: "same", text: "- tests first" },
          { op: "remove", text: "- old rule" },
          { op: "add", text: "- theirs" },
        ],
      },
    ],
  };
  stubFetch({
    [BASE]: missionView([V2, V1]),
    [`${BASE}/diff/1/2`]: diff,
  });
  renderWithProviders(<MissionScreen agent="builder-1" />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "History" }));
  expect(screen.getByText("saved elsewhere")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "diff v1 → v2" }));

  const view = await screen.findByRole("region", { name: "diff v1 → v2" });
  // On its own page the diff is an h2 under the mission's h1, each section an h3.
  expect(
    within(view).getByRole("heading", { level: 2, name: "diff v1 → v2" }),
  ).toBeTruthy();
  expect(
    within(view).getByRole("heading", { level: 3, name: "laws" }),
  ).toBeTruthy();
  const added = (await within(view).findByText("- theirs")).closest(
    "[data-op]",
  );
  expect(added?.getAttribute("data-op")).toBe("add");
  // The one diff recipe (diff-tones.ts): success's soft surface added, danger's removed.
  expect(added?.className).toContain("bg-success-subtle");
  const removed = within(view).getByText("- old rule").closest("[data-op]");
  expect(removed?.getAttribute("data-op")).toBe("remove");
  expect(removed?.className).toContain("bg-danger-subtle");
  expect(within(view).getByText(/who: unchanged/i)).toBeTruthy();
});

test("the preview renders the mission as agents receive it", async () => {
  stubFetch({ [BASE]: missionView([V1]) });
  renderWithProviders(<MissionScreen agent="builder-1" />);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Laws"), "\n- **bold law**");
  const preview = screen.getByRole("region", { name: "Preview" });
  expect(
    within(preview).getByRole("heading", { name: "Mission: builder-1" }),
  ).toBeTruthy();
  expect(within(preview).getByRole("heading", { name: "Laws" })).toBeTruthy();
  expect(within(preview).getByText("bold law").tagName).toBe("STRONG");
});

test("opened to add a law, the laws section has the focus", async () => {
  stubFetch({ [BASE]: missionView([V1]) });
  renderWithProviders(<MissionScreen agent="builder-1" section="laws" />);
  const laws = await screen.findByLabelText("Laws");
  await waitFor(() => expect(document.activeElement).toBe(laws));
});
