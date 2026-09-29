import {
  NO_DELIVERY,
  NO_DOCS,
  NO_QA,
  type DeliveryConfigView,
} from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { renderIde } from "@/test/ide-harness";
import { projectView } from "@/test/project-fixtures";
import { bodyOf, callsTo } from "@/test/render";
import { CLOSE_ON_MERGE_LABEL, DELIVERY_SINCE_HINT } from "./delivery-fields";

// The project IDE's Delivery section. Two choices, one PATCH, and — this is the part
// worth testing rather than the radios — the section says out loud that switching it on is the
// permission for Bayon to write to the project's remote.

const HASH = "#/p/ws-bayon/settings";
const PROJECT = "/api/v1/projects/ws-bayon";
const JIRA = "/api/v1/projects/ws-bayon/jira";
const TOKEN = "/api/v1/jira";

const settings = (delivery: DeliveryConfigView) => ({
  project: "ws-bayon",
  staff_approval: false,
  jira: null,
  qa: NO_QA,
  docs: NO_DOCS,
  delivery,
  qa_ticket: null,
  changed: true,
});

const routes = (over: Record<string, unknown> = {}) => ({
  [JIRA]: { source: null, last_sync: null },
  [TOKEN]: {
    secret: "JIRA_API_TOKEN",
    store: "keychain",
    keychain: { service: "foreman", owner: true },
    present: true,
  },
  ...over,
});

const section = () => screen.findByRole("region", { name: "Delivery" });

afterEach(() => {
  window.location.hash = "";
});

test("a project that delivers nothing shows the switch off and hides when and the warning", async () => {
  renderIde(HASH, projectView({ delivery: NO_DELIVERY }), routes());
  const delivery = await section();
  expect(
    within(delivery)
      .getByRole("radio", { name: /^Keep the work here/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    within(delivery).queryByRole("radio", { name: /^Only when the ticket/ }),
  ).toBeNull();
  expect(within(delivery).queryByText(/standing permission/i)).toBeNull();
  expect(within(delivery).queryByText(DELIVERY_SINCE_HINT)).toBeNull();
});

// switching delivery on never delivers the project's history, and there is no "deliver
// now" for it — so the section says so the moment delivery is chosen.
test("turning delivery on says it applies from then on, not to work already done", async () => {
  renderIde(HASH, projectView({ delivery: NO_DELIVERY }), routes());
  const user = userEvent.setup();
  const delivery = await section();
  await user.click(
    within(delivery).getByRole("radio", { name: /^Push the branch/ }),
  );
  expect(within(delivery).getByText(DELIVERY_SINCE_HINT)).toBeTruthy();
  await user.click(
    within(delivery).getByRole("radio", { name: /^Keep the work here/ }),
  );
  expect(within(delivery).queryByText(DELIVERY_SINCE_HINT)).toBeNull();
});

test("choosing pull requests and a moment PATCHes both, and says what it permits", async () => {
  const fetchMock = renderIde(
    HASH,
    projectView({ delivery: NO_DELIVERY }),
    routes({
      [PROJECT]: () =>
        settings({ mode: "pull_request", when: "done", close_on_merge: true }),
    }),
  );
  const user = userEvent.setup();
  const delivery = await section();
  await user.click(
    within(delivery).getByRole("radio", { name: /^Push and open a pull/ }),
  );
  // Only once a mode is chosen does the moment — or the warning — appear at all.
  expect(within(delivery).getByText(/standing permission/i)).toBeTruthy();
  await user.click(
    within(delivery).getByRole("radio", {
      name: /^Only when the ticket is done/,
    }),
  );
  await user.click(
    within(delivery).getByRole("button", { name: "Save delivery settings" }),
  );

  await waitFor(() =>
    expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, PROJECT, "PATCH")).toEqual({
    delivery: { mode: "pull_request", when: "done", close_on_merge: true },
  });
  expect(
    await screen.findByRole("status", { name: "Delivery settings saved" }),
  ).toBeTruthy();
});

test("turning delivery off PATCHes none, and the form shows the server's answer", async () => {
  const fetchMock = renderIde(
    HASH,
    projectView({
      delivery: { mode: "push", when: "review_passed", close_on_merge: true },
    }),
    routes({ [PROJECT]: () => settings(NO_DELIVERY) }),
  );
  const user = userEvent.setup();
  const delivery = await section();
  await user.click(
    within(delivery).getByRole("radio", { name: /^Keep the work here/ }),
  );
  await user.click(
    within(delivery).getByRole("button", { name: "Save delivery settings" }),
  );

  await waitFor(() =>
    expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, PROJECT, "PATCH")).toEqual({
    delivery: { mode: "none", when: "review_passed", close_on_merge: true },
  });
  expect(
    within(delivery)
      .getByRole("radio", { name: /^Keep the work here/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("the close-on-merge switch shows for pull requests only, and turning it off PATCHes it", async () => {
  const fetchMock = renderIde(
    HASH,
    projectView({
      delivery: { mode: "push", when: "review_passed", close_on_merge: true },
    }),
    routes({
      [PROJECT]: () =>
        settings({
          mode: "pull_request",
          when: "review_passed",
          close_on_merge: false,
        }),
    }),
  );
  const user = userEvent.setup();
  const delivery = await section();
  // A plain push opens no request, so there is nothing to merge.
  expect(
    within(delivery).queryByRole("switch", { name: CLOSE_ON_MERGE_LABEL }),
  ).toBeNull();
  await user.click(
    within(delivery).getByRole("radio", { name: /^Push and open a pull/ }),
  );
  const toggle = within(delivery).getByRole("switch", {
    name: CLOSE_ON_MERGE_LABEL,
  });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await user.click(toggle);
  await user.click(
    within(delivery).getByRole("button", { name: "Save delivery settings" }),
  );
  await waitFor(() =>
    expect(callsTo(fetchMock, PROJECT, "PATCH")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, PROJECT, "PATCH")).toEqual({
    delivery: {
      mode: "pull_request",
      when: "review_passed",
      close_on_merge: false,
    },
  });
  expect(
    within(delivery)
      .getByRole("switch", { name: CLOSE_ON_MERGE_LABEL })
      .getAttribute("aria-checked"),
  ).toBe("false");
});
