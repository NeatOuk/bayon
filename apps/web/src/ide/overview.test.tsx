import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { fleet, fleetRow, sessionView } from "@/test/fixtures";
import { inboxItem, inboxPage } from "@/test/inbox-fixtures";
import {
  proposalsUrl,
  renderIde,
  sessionsUrl,
  tabNames,
} from "@/test/ide-harness";
import { projectAgent, projectView } from "@/test/project-fixtures";
import { agentPulse } from "@/test/pulse-fixtures";
import { pushFeed } from "@/test/push-feed";
import { callsTo } from "@/test/render";

// The Overview's orchestrator card and live roster. Runner ids are data, shown as given.

const ORCH = projectAgent({ id: "bayon-orchestrator", kind: "orchestrator" });
const BUILDER = projectAgent({ id: "bayon-builder", runner_id: "runner-a" });
const REVIEWER = projectAgent({
  id: "bayon-reviewer",
  kind: "reviewer",
  runner_id: "runner-b",
  enabled: false,
});
const BAYON = projectView({ agents: [ORCH, BUILDER, REVIEWER] });

const BUILD_SESSION = "01JBUILDSESSION000000001";

const building = fleetRow({
  id: BUILD_SESSION,
  agent: "bayon-builder",
  state: "running",
  run_class: "build",
  ticket: 812,
  ticket_key: "FRM-812",
  title: "transfer idempotency",
  turns: 2,
  cost_usd: 0.5,
  idle_ms: 5_000,
  workspace_id: "ws-bayon",
});

const orchestrator = () =>
  screen.findByRole("region", { name: "orchestrator" });
const roster = () => screen.findByRole("region", { name: "agent roster" });
const rosterRow = async (name: string) => {
  const link = within(await roster()).getByRole("link", { name });
  const row = link.closest("li");
  if (row === null) throw new Error(`no roster row for ${name}`);
  return row;
};

afterEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
});

test("the orchestrator card: enabled and awake, its pulse mode and next pulse, the project's hold and its open proposals", async () => {
  const project = projectView({
    agents: [ORCH, BUILDER],
    paused: true,
    staff_approval: true,
  });
  renderIde("#/p/ws-bayon/overview", project, {
    "/api/v1/fleet": fleet([
      fleetRow({
        id: "01JPULSESESSION000000001",
        agent: "bayon-orchestrator",
        state: "running",
        workspace_id: "ws-bayon",
      }),
    ]),
    "/api/v1/agents/pulse-policies": {
      items: [
        agentPulse({
          agent_id: "bayon-orchestrator",
          mode: "interval",
          next_pulse_at: Date.now() + 10 * 60_000,
        }),
      ],
    },
    [proposalsUrl("ws-bayon")]: inboxPage([
      inboxItem({ id: "r1", kind: "staff_approval" }),
      inboxItem({ id: "r2", kind: "staff_approval" }),
    ]),
  });
  const card = await orchestrator();
  expect(
    within(card)
      .getByRole("link", { name: "bayon-orchestrator" })
      .getAttribute("href"),
  ).toBe("#/p/ws-bayon/overview?open=agent:bayon-orchestrator");
  expect(within(card).getByText("Enabled").dataset.tone).toBe("info");
  expect(await within(card).findByText("Awake")).toBeTruthy();
  // Awake, and what its live session is doing.
  expect(within(card).getByText("Running").dataset.state).toBe("running");
  expect(await within(card).findByText("Interval")).toBeTruthy();
  expect(within(card).getByText(/^next pulse in \d+m/)).toBeTruthy();
  expect(
    within(card).getByText(
      "paused: nothing new starts, and its orchestrator does not pulse",
    ),
  ).toBeTruthy();
  expect(
    within(card).getByText("each proposal waits for the operator's approval"),
  ).toBeTruthy();
  const proposals = await within(card).findByRole("link", { name: "2 open" });
  expect(proposals.getAttribute("href")).toBe("#/p/ws-bayon/orchestrator");
});

test("a disabled orchestrator is asleep and does not pulse; a running project with no proposals says so", async () => {
  const project = projectView({
    agents: [{ ...ORCH, enabled: false }, BUILDER],
  });
  renderIde("#/p/ws-bayon/overview", project);
  const card = await orchestrator();
  expect(within(card).getByText("Disabled").dataset.tone).toBe("neutral");
  expect(within(card).getByText("Asleep")).toBeTruthy();
  expect(within(card).getByText("does not pulse while disabled")).toBeTruthy();
  expect(within(card).getByText("running")).toBeTruthy();
  expect(within(card).getByText("starts without asking")).toBeTruthy();
  expect(
    await within(card).findByRole("link", { name: "none open" }),
  ).toBeTruthy();
});

test("an inbox frame refetches the proposal count: a proposal opened or was answered", async () => {
  const { feed, pushInbox } = pushFeed();
  let open = 1;
  const fetchMock = renderIde(
    "#/p/ws-bayon/overview",
    BAYON,
    {
      [proposalsUrl("ws-bayon")]: () =>
        inboxPage(
          Array.from({ length: open }, (_, i) =>
            inboxItem({ id: `r${i}`, kind: "staff_approval" }),
          ),
        ),
    },
    feed,
  );
  const card = await orchestrator();
  expect(
    await within(card).findByRole("link", { name: "1 open" }),
  ).toBeTruthy();
  open = 3;
  pushInbox(inboxPage([]));
  expect(
    await within(card).findByRole("link", { name: "3 open" }),
  ).toBeTruthy();
  expect(callsTo(fetchMock, proposalsUrl("ws-bayon"))).toHaveLength(2);
});

test("a project with no orchestrator says only the operator staffs it", async () => {
  renderIde("#/p/ws-bayon/overview", projectView({ agents: [BUILDER] }));
  expect(
    within(await orchestrator()).getByText(
      "No orchestrator: only the operator staffs this project's tickets.",
    ),
  ).toBeTruthy();
});

test("the roster shows each agent's live session, or idle, or disabled; another project's session is not this one's", async () => {
  renderIde("#/p/ws-bayon/overview", BAYON, {
    "/api/v1/fleet": fleet([
      building,
      // The same agent's session placed in another project: that project's roster, not this one's.
      fleetRow({
        id: "01JELSEWHERE000000000001",
        agent: "bayon-builder",
        workspace_id: "kite",
        turns: 99,
      }),
    ]),
  });
  const builder = await rosterRow("bayon-builder");
  expect(
    within(builder).getByText("builder · runner-a · model-mid"),
  ).toBeTruthy();
  await waitFor(() =>
    expect(
      within(builder).getByRole("list", {
        name: "bayon-builder live sessions",
      }),
    ).toBeTruthy(),
  );
  const live = within(builder).getAllByRole("listitem");
  expect(live).toHaveLength(1);
  // The session's state as a status, then its facts; its id shortened, then whole for a screen reader.
  expect(live[0]?.textContent).toBe(
    `RunningbuildFRM-812t2$0.50idle 5ssession 01JB…000001${BUILD_SESSION}`,
  );
  expect(
    within(builder).getByRole("link", { name: "FRM-812" }).getAttribute("href"),
  ).toBe("#/p/ws-bayon/overview?open=ticket:812");
  expect(
    within(builder)
      .getByRole("link", { name: `session ${BUILD_SESSION}` })
      .getAttribute("href"),
  ).toBe(`#/p/ws-bayon/overview?open=session:${BUILD_SESSION}`);
  expect(
    within(await rosterRow("bayon-orchestrator")).getByText("Idle"),
  ).toBeTruthy();
  expect(
    within(await rosterRow("bayon-reviewer")).getByText("Disabled"),
  ).toBeTruthy();
});

test("a fleet frame updates a roster row live, and the session's end returns the agent to idle", async () => {
  const { feed, pushFleet } = pushFeed();
  renderIde(
    "#/p/ws-bayon/overview",
    BAYON,
    { "/api/v1/fleet": fleet([building]) },
    feed,
  );
  const builder = await rosterRow("bayon-builder");
  await within(builder).findByText("t2");

  pushFleet(fleet([{ ...building, state: "idle", turns: 5, cost_usd: 1.25 }]));
  await waitFor(() => expect(within(builder).getByText("t5")).toBeTruthy());
  expect(within(builder).getByText("$1.25")).toBeTruthy();
  expect(within(builder).getByText("Idle").dataset.state).toBe("idle");

  pushFleet(fleet([]));
  await waitFor(() =>
    expect(
      within(builder).queryByRole("list", {
        name: "bayon-builder live sessions",
      }),
    ).toBe(null),
  );
  expect(within(builder).getByText("Idle")).toBeTruthy();
});

test("a roster row opens its agent's tab; its session link opens the session's", async () => {
  const fetchMock = renderIde("#/p/ws-bayon/overview", BAYON, {
    "/api/v1/fleet": fleet([building]),
    [`/api/v1/sessions/${BUILD_SESSION}`]: sessionView({
      id: BUILD_SESSION,
      state: "running",
    }),
  });
  const user = userEvent.setup();
  await user.click(
    within(await roster()).getByRole("link", { name: "bayon-builder" }),
  );
  expect(window.location.hash).toBe(
    "#/p/ws-bayon/overview?open=agent:bayon-builder",
  );
  expect(
    await screen.findByRole("heading", { name: "bayon-builder" }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(callsTo(fetchMock, sessionsUrl("bayon-builder"))).toHaveLength(1),
  );

  await user.click(screen.getByRole("tab", { name: "Overview" }));
  await user.click(
    within(await rosterRow("bayon-builder")).getByRole("link", {
      name: `session ${BUILD_SESSION}`,
    }),
  );
  expect(await screen.findByRole("tab", { name: "Timeline" })).toBeTruthy();
  expect(tabNames()).toEqual(["Overview", "bayon-builder", "session …000001"]);
});
