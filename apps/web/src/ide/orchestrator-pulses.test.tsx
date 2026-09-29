import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { agentPulsesUrl, renderIde, tabNames } from "@/test/ide-harness";
import { projectAgent, projectView } from "@/test/project-fixtures";
import { T0, pulseCheck, pulseDetail, pulseView } from "@/test/pulse-fixtures";
import { pushFeed } from "@/test/push-feed";
import { callsTo } from "@/test/render";

// The Orchestrator view's recent pulses: the orchestrator's newest, each opening its
// report — summary, actions and probe checks — as an editor tab.

const ORCH = projectAgent({ id: "bayon-orchestrator", kind: "orchestrator" });
const BAYON = projectView({ agents: [ORCH] });
const HASH = "#/p/ws-bayon/orchestrator";
const PULSES = agentPulsesUrl("bayon-orchestrator");

const P2 = pulseView({
  id: "P-2",
  agent_id: "bayon-orchestrator",
  scheduled_at: T0 + 60_000,
  trigger: "completion",
  state: "done",
  session_id: "S-9",
  cost_usd: 0.12,
  summary_md: "**Staffed** FRM-12.\nThen waited.",
  actions: ["staffed FRM-12", "asked about FRM-13"],
});
const P1 = pulseView({
  id: "P-1",
  agent_id: "bayon-orchestrator",
  scheduled_at: T0,
  state: "skipped",
  skip_reason: "rate_capped",
});

const recent = () => screen.findByRole("region", { name: "recent pulses" });

afterEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
});

test("recent pulses list the orchestrator's newest: when, why, how it went, what it cost and its first line", async () => {
  renderIde(HASH, BAYON, { [PULSES]: { items: [P2, P1] } });
  const list = await recent();
  await within(list).findByText("Done");
  const rows = within(list).getAllByRole("row").slice(1);
  expect(rows.map((row) => row.textContent)).toEqual([
    "2027-01-15 08:01CompletionDone$0.12Staffed FRM-12.",
    "2027-01-15 08:00CronSkipped (rate capped)——",
  ]);
  // A rate-capped skip wants a look; a done pulse is the success tone.
  expect(within(list).getByText("Skipped (rate capped)").dataset.tone).toBe(
    "warning",
  );
  expect(within(list).getByText("Done").dataset.tone).toBe("success");
});

test("a pulse opens its report as a tab: summary, actions and checks, no way back, its session a tab", async () => {
  renderIde(HASH, BAYON, {
    [PULSES]: { items: [P2, P1] },
    "/api/v1/pulses/P-2": pulseDetail(P2, [
      pulseCheck({ name: "ci-status", duration_ms: 12 }),
    ]),
  });
  const user = userEvent.setup();
  await user.click(
    await within(await recent()).findByRole("link", {
      name: "2027-01-15 08:01",
    }),
  );
  expect(window.location.hash).toBe(`${HASH}?open=pulse:P-2`);
  expect(await screen.findByRole("heading", { name: "Pulse" })).toBeTruthy();
  // Its id in the header's meta row, copyable.
  const meta = document.querySelector<HTMLElement>("[data-slot=page-meta]");
  expect(within(meta as HTMLElement).getByTitle("P-2")).toBeTruthy();
  expect(tabNames()).toEqual(["Orchestrator", "pulse P-2"]);
  const summary = screen.getByRole("region", { name: "summary" });
  expect(within(summary).getByText("Staffed")).toBeTruthy();
  const actions = screen.getByRole("region", { name: "actions" });
  expect(
    within(actions)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["staffed FRM-12", "asked about FRM-13"]);
  expect(
    within(screen.getByRole("region", { name: "checks" })).getByText(
      "ci-status",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("link", { name: "← Pulses" })).toBe(null);
  expect(screen.getByRole("link", { name: "S-9" }).getAttribute("href")).toBe(
    `${HASH}?open=session:S-9`,
  );
});

test("a pulses frame refetches the orchestrator's list; none yet says so", async () => {
  const { feed, pushPulses } = pushFeed();
  let items: (typeof P1)[] = [];
  const fetchMock = renderIde(
    HASH,
    BAYON,
    { [PULSES]: () => ({ items }) },
    feed,
  );
  expect(
    await within(await recent()).findByText(/^No pulses yet/),
  ).toBeTruthy();
  items = [P1];
  pushPulses({ items: [P1] });
  expect(
    await within(await recent()).findByText("Skipped (rate capped)"),
  ).toBeTruthy();
  await waitFor(() => expect(callsTo(fetchMock, PULSES)).toHaveLength(2));
});
