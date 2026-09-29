import { NO_DELIVERY, NO_DOCS, NO_QA } from "@bayon/proto";
import type { ProjectView } from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { fleet, fleetRow, missionVersion, missionView } from "@/test/fixtures";
import {
  agentPulsesUrl,
  missionUrl,
  navigate,
  renderIde,
  tabNames,
} from "@/test/ide-harness";
import {
  projectAgent,
  projectView,
  projectsView,
} from "@/test/project-fixtures";
import { agentPulse } from "@/test/pulse-fixtures";
import { apiError, bodyOf, callsTo } from "@/test/render";
import { commandView, runnerView, runnersView } from "@/test/runner-fixtures";

// The IDE's Orchestrator view: who the orchestrator is, and the controls — the project's
// pause, the staffing approval, a pulse now and the schedule — then the embedded mission; with none,
// the empty state adds one. Runner ids are data, shown as given. Proposals and pulses
// are in their own files.

const ORCH = projectAgent({
  id: "bayon-orchestrator",
  kind: "orchestrator",
  runner_id: "runner-o",
});
const BUILDER = projectAgent({ id: "bayon-builder", runner_id: "runner-a" });
const BAYON = projectView({ agents: [ORCH, BUILDER] });
const HASH = "#/p/ws-bayon/orchestrator";
const PROJECTS = "/api/v1/projects";
const PAUSE = "/api/v1/projects/ws-bayon/pause";
const RESUME = "/api/v1/projects/ws-bayon/resume";
const PROJECT = "/api/v1/projects/ws-bayon";
const POLICIES = "/api/v1/agents/pulse-policies";
const RUN = "/api/v1/pulses/run-now";
const RUNNERS = "/api/v1/runners";
const AGENTS = "/api/v1/projects/ws-bayon/agents";
const MINUTE = 60_000;

const region = (name: string) => screen.findByRole("region", { name });
const control = async (name: string) =>
  within(await region("controls")).getByRole("group", { name });

afterEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
});

test("the header names the orchestrator, its runner, enabled and awake, and opens its agent tab", async () => {
  renderIde(HASH, BAYON, {
    "/api/v1/fleet": fleet([
      fleetRow({
        id: "01JPULSESESSION000000001",
        agent: "bayon-orchestrator",
        state: "running",
        workspace_id: "ws-bayon",
      }),
    ]),
  });
  const title = await screen.findByRole("heading", {
    level: 1,
    name: "Orchestrator",
  });
  const header = title.closest("header");
  if (header === null) throw new Error("no header");
  expect(
    within(header)
      .getByRole("link", { name: "bayon-orchestrator" })
      .getAttribute("href"),
  ).toBe("#/p/ws-bayon/orchestrator?open=agent:bayon-orchestrator");
  expect(within(header).getByText("runner-o")).toBeTruthy();
  expect(within(header).getByText("Enabled")).toBeTruthy();
  // Awake, and what its live session is doing, each a status of its own.
  expect(await within(header).findByText("Awake")).toBeTruthy();
  expect(within(header).getByText("Running").dataset.tone).toBe("info");
});

test("no orchestrator: the view says so, offers Add orchestrator and only the project's pause", async () => {
  renderIde(HASH, projectView({ agents: [BUILDER] }), {
    [RUNNERS]: runnersView([runnerView({ id: "runner-o" })]),
  });
  expect(
    await screen.findByText("This project has no orchestrator"),
  ).toBeTruthy();
  expect(screen.getByText(/it pulses this project alone/)).toBeTruthy();
  const form = await screen.findByRole("form", { name: "add orchestrator" });
  expect(
    within(form)
      .getByRole("button", { name: "Add orchestrator" })
      .hasAttribute("disabled"),
  ).toBe(true);
  const controls = await region("controls");
  expect(
    within(controls)
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-labelledby") ?? "")
      .map((id) => document.getElementById(id)?.textContent),
  ).toEqual(["Pause project"]);
  expect(within(controls).queryByRole("button", { name: "Wake now" })).toBe(
    null,
  );
  for (const name of ["proposals", "mission", "recent pulses"])
    expect(screen.queryByRole("region", { name })).toBe(null);
});

/** Picks `runner` in the add orchestrator form's Select. */
async function pickRunner(
  user: ReturnType<typeof userEvent.setup>,
  form: HTMLElement,
  runner: string,
) {
  const select = within(form).getByRole("combobox", { name: "Runner" });
  await waitFor(() => expect(select.hasAttribute("disabled")).toBe(false));
  await user.click(select);
  await user.click(
    await screen.findByRole("option", { name: new RegExp(`^${runner}`) }),
  );
}

test("Add orchestrator posts an orchestrator on the runner picked, then the view shows its controls, mission and pulses", async () => {
  const ADDED = projectAgent({
    id: "ws-bayon-orchestrator-1",
    kind: "orchestrator",
    runner_id: "runner-b",
  });
  let project = projectView({ agents: [BUILDER] });
  const fetchMock = renderIde(HASH, project, {
    [PROJECTS]: () => projectsView(project),
    [RUNNERS]: runnersView([
      runnerView({ id: "runner-o" }),
      runnerView({ id: "runner-b", certifications: [] }),
    ]),
    [AGENTS]: () => {
      project = { ...project, agents: [...project.agents, ADDED] };
      return Response.json(
        {
          ...ADDED,
          profile_id: "ws-bayon-orchestrate-runner-b",
          workspace_id: "ws-bayon",
          executor_id: "local",
        },
        { status: 201 },
      );
    },
    [POLICIES]: () => ({
      items: project.agents.includes(ADDED)
        ? [
            agentPulse({
              agent_id: ADDED.id,
              name: ADDED.name,
              next_pulse_at: Date.now() + 90 * MINUTE,
            }),
          ]
        : [],
    }),
    [agentPulsesUrl(ADDED.id)]: { items: [] },
    [missionUrl(ADDED.name)]: missionView([], ADDED.name),
  });
  const user = userEvent.setup();
  const form = await screen.findByRole("form", { name: "add orchestrator" });
  await pickRunner(user, form, "runner-b");
  expect(
    within(form).getByText(
      "warning: runner-b is not certified on local (never run): the agent is still added, but unattended work needs it certified.",
    ),
  ).toBeTruthy();
  const policyReads = callsTo(fetchMock, POLICIES).length;
  await user.click(
    within(form).getByRole("button", { name: "Add orchestrator" }),
  );

  await waitFor(() =>
    expect(bodyOf(fetchMock, AGENTS, "POST")).toEqual({
      kind: "orchestrator",
      runner_id: "runner-b",
    }),
  );
  const header = (
    await screen.findByRole("heading", { level: 1, name: "Orchestrator" })
  ).closest("header");
  if (header === null) throw new Error("no header");
  expect(
    await within(header).findByRole("link", {
      name: "ws-bayon-orchestrator-1",
    }),
  ).toBeTruthy();
  expect(screen.queryByText("This project has no orchestrator")).toBe(null);
  expect(await control("Wake now")).toBeTruthy();
  const schedule = await control("Pulse schedule");
  expect(await within(schedule).findByText("Hybrid")).toBeTruthy();
  expect(callsTo(fetchMock, POLICIES).length).toBeGreaterThan(policyReads);
  expect(
    await within(await region("mission")).findByText("no mission yet"),
  ).toBeTruthy();
  expect(await region("recent pulses")).toBeTruthy();
});

test("a refused Add orchestrator shows the server's reason and keeps the form", async () => {
  const fetchMock = renderIde(HASH, projectView({ agents: [BUILDER] }), {
    [RUNNERS]: runnersView([runnerView({ id: "runner-o" })]),
    [AGENTS]: apiError(
      409,
      "conflict",
      "project ws-bayon already has an enabled orchestrator, ws-bayon-orchestrator-1: disable it before adding another",
    ),
  });
  const user = userEvent.setup();
  const form = await screen.findByRole("form", { name: "add orchestrator" });
  await pickRunner(user, form, "runner-o");
  await user.click(
    within(form).getByRole("button", { name: "Add orchestrator" }),
  );
  expect((await within(form).findByRole("alert")).textContent).toBe(
    "Not added: project ws-bayon already has an enabled orchestrator, ws-bayon-orchestrator-1: disable it before adding another",
  );
  expect(callsTo(fetchMock, AGENTS, "POST")).toHaveLength(1);
  expect(screen.getByText("This project has no orchestrator")).toBeTruthy();
});

test("with a disabled orchestrator beside an enabled one, the view is the enabled one's", async () => {
  renderIde(
    HASH,
    projectView({
      agents: [
        { ...ORCH, enabled: false },
        projectAgent({
          id: "ws-bayon-orchestrator-1",
          kind: "orchestrator",
          runner_id: "runner-b",
        }),
      ],
    }),
  );
  const header = (
    await screen.findByRole("heading", { level: 1, name: "Orchestrator" })
  ).closest("header");
  if (header === null) throw new Error("no header");
  expect(
    within(header).getByRole("link", { name: "ws-bayon-orchestrator-1" }),
  ).toBeTruthy();
  expect(within(header).getByText("Enabled")).toBeTruthy();
});

test("pausing asks first: cancel posts nothing; confirmed, it pauses the project and says running turns finish", async () => {
  let paused = false;
  const fetchMock = renderIde(HASH, BAYON, {
    [PROJECTS]: () => projectsView({ ...BAYON, paused }),
    [PAUSE]: () => {
      paused = true;
      return { project: "ws-bayon", paused: true, changed: true };
    },
  });
  const user = userEvent.setup();
  const pause = await control("Pause project");
  expect(within(pause).getByText(/Running turns finish\./)).toBeTruthy();
  const toggle = within(pause).getByRole("switch", { name: "Pause project" });

  await user.click(toggle);
  const ask = await screen.findByRole("alertdialog");
  expect(within(ask).getByText("Pause this project?")).toBeTruthy();
  expect(within(ask).getByText(/Running turns finish\./)).toBeTruthy();
  await user.click(within(ask).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBe(null));
  expect(callsTo(fetchMock, PAUSE, "POST")).toHaveLength(0);
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  await user.click(toggle);
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Pause project",
    }),
  );
  await waitFor(() =>
    expect(callsTo(fetchMock, PAUSE, "POST")).toHaveLength(1),
  );
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(within(pause).getByText("Paused").dataset.tone).toBe("warning");
  expect(await screen.findByText("Project paused")).toBeTruthy();
  expect(screen.queryByRole("alertdialog")).toBe(null);
});

test("resuming a paused project that the server refuses keeps the dialog open with its reason", async () => {
  const fetchMock = renderIde(HASH, projectView({ ...BAYON, paused: true }), {
    [RESUME]: () => apiError(404, "not_found", "project ws-bayon"),
  });
  const user = userEvent.setup();
  const pause = await control("Pause project");
  const toggle = within(pause).getByRole("switch", { name: "Pause project" });
  await user.click(toggle);
  const ask = await screen.findByRole("alertdialog");
  expect(within(ask).getByText("Resume this project?")).toBeTruthy();
  await user.click(within(ask).getByRole("button", { name: "Resume project" }));
  expect((await within(ask).findByRole("alert")).textContent).toBe(
    "Not resumed: project ws-bayon",
  );
  expect(callsTo(fetchMock, RESUME, "POST")).toHaveLength(1);
  // The server's state, never the one asked for: still paused.
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});

test("require approval PATCHes the switch and shows the server's state; a refusal says why", async () => {
  let approval = false;
  let refuse = false;
  const fetchMock = renderIde(HASH, BAYON, {
    [PROJECTS]: () => projectsView({ ...BAYON, staff_approval: approval }),
    [PROJECT]: (init: RequestInit | undefined) => {
      if (refuse) return apiError(409, "conflict", "the project is busy");
      approval = (JSON.parse(String(init?.body)) as ProjectView).staff_approval;
      return {
        project: "ws-bayon",
        staff_approval: approval,
        jira: null,
        qa: NO_QA,
        docs: NO_DOCS,
        delivery: NO_DELIVERY,
        qa_ticket: null,
        changed: true,
      };
    },
  });
  const user = userEvent.setup();
  const group = await control("Require approval");
  expect(
    within(group).getByText(/no session starts until you approve it/),
  ).toBeTruthy();
  const toggle = within(group).getByRole("switch", {
    name: "Require approval",
  });
  const reads = callsTo(fetchMock, PROJECTS).length;

  await user.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(bodyOf(fetchMock, PROJECT, "PATCH")).toEqual({ staff_approval: true });
  await waitFor(() =>
    expect(callsTo(fetchMock, PROJECTS).length).toBeGreaterThan(reads),
  );

  refuse = true;
  await user.click(toggle);
  expect((await within(group).findByRole("alert")).textContent).toBe(
    "Not changed: the project is busy",
  );
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});

test("wake now posts the orchestrator and follows its command to the supervisor's refusal", async () => {
  const fetchMock = renderIde(HASH, BAYON, {
    [RUN]: { command_id: "C-7", created: true },
    "/api/v1/commands/C-7": commandView({
      id: "C-7",
      type: "pulse.run",
      state: "failed",
      error: {
        class: "admission_refused",
        message:
          "refused (project_paused): project ws-bayon is paused (workspaces.paused=1): its orchestrator pulses once it resumes",
        retryable: true,
      },
    }),
  });
  const user = userEvent.setup();
  const wake = await control("Wake now");
  await user.click(within(wake).getByRole("button", { name: "Wake now" }));
  await waitFor(() => expect(callsTo(fetchMock, RUN, "POST")).toHaveLength(1));
  expect(bodyOf(fetchMock, RUN, "POST")).toEqual({
    agent_id: "bayon-orchestrator",
  });
  await waitFor(() =>
    expect(within(wake).getByRole("status").textContent).toBe(
      "Not run: refused (project_paused): project ws-bayon is paused (workspaces.paused=1): its orchestrator pulses once it resumes",
    ),
  );
});

test("the schedule shows the policy and next pulse; an edit PATCHes the change and shows the server's policy", async () => {
  let interval = 90 * MINUTE;
  const fetchMock = renderIde(HASH, BAYON, {
    [POLICIES]: () => ({
      items: [
        agentPulse({
          agent_id: "bayon-orchestrator",
          name: "bayon-orchestrator",
          interval_ms: interval,
          next_pulse_at: Date.now() + 41.5 * MINUTE,
        }),
      ],
    }),
    "/api/v1/agents/bayon-orchestrator/pulse-policy": (
      init: RequestInit | undefined,
    ) => {
      interval = (JSON.parse(String(init?.body)) as { interval_ms: number })
        .interval_ms;
      return {
        agent_id: "bayon-orchestrator",
        mode: "hybrid",
        interval_ms: interval,
        debounce_ms: 60_000,
        min_gap_ms: 300_000,
        max_per_hour: 8,
        jitter_pct: 5,
      };
    },
  });
  const user = userEvent.setup();
  const schedule = await control("Pulse schedule");
  await within(schedule).findByText("Hybrid");
  const facts = () =>
    Object.fromEntries(
      within(schedule)
        .getAllByRole("term")
        .map((term) => [term.textContent, term.nextSibling?.textContent]),
    );
  expect(facts()).toMatchObject({
    Interval: "1h 30m",
    Debounce: "1m",
    "Minimum gap": "5m",
    "Most per hour": "8",
    Jitter: "5%",
  });
  expect(facts()["Next"]).toMatch(
    /^next pulse in 41m \(.* UTC, sooner on a completion\)$/,
  );

  await user.click(
    within(schedule).getByRole("button", { name: "Edit policy" }),
  );
  const dialog = await screen.findByRole("dialog");
  const field = within(dialog).getByLabelText("Interval (minutes)");
  await user.clear(field);
  await user.type(field, "30");
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(
      bodyOf(
        fetchMock,
        "/api/v1/agents/bayon-orchestrator/pulse-policy",
        "PATCH",
      ),
    ).toEqual({ interval_ms: 30 * MINUTE }),
  );
  await waitFor(() => expect(facts()["Interval"]).toBe("30m"));
});

test("a disabled orchestrator has no schedule, and the view says where to enable it", async () => {
  renderIde(HASH, projectView({ agents: [{ ...ORCH, enabled: false }] }));
  const schedule = await control("Pulse schedule");
  expect(
    within(schedule).getByText(/Disabled: it does not pulse/),
  ).toBeTruthy();
  expect(
    within(schedule)
      .getByRole("link", { name: "Enable it in Agents." })
      .getAttribute("href"),
  ).toBe("#/p/ws-bayon/agents");
  expect(within(schedule).queryByRole("button", { name: "Edit policy" })).toBe(
    null,
  );
});

test("the mission editor is embedded without its page chrome; a save posts the orchestrator's mission", async () => {
  const v1 = missionVersion({
    version: 1,
    agent_name: "bayon-orchestrator",
    laws_md: "- staff one ticket at a time",
  });
  const fetchMock = renderIde(HASH, BAYON, {
    [missionUrl("bayon-orchestrator")]: (init: RequestInit | undefined) =>
      init?.method === "POST"
        ? Response.json(
            missionVersion({ version: 2, agent_name: "bayon-orchestrator" }),
            { status: 201 },
          )
        : missionView([v1], "bayon-orchestrator"),
  });
  const user = userEvent.setup();
  const mission = await region("mission");
  const laws = (await within(mission).findByLabelText(
    "Laws",
  )) as HTMLTextAreaElement;
  expect(laws.value).toBe("- staff one ticket at a time");
  expect(within(mission).getByText("v1")).toBeTruthy();
  expect(within(mission).queryByRole("link", { name: "← Fleet" })).toBe(null);
  expect(within(mission).getByRole("tab", { name: "History" })).toBeTruthy();

  await user.type(laws, "\n- never staff a paused project");
  await user.type(within(mission).getByLabelText("Changelog"), "one more law");
  await user.click(within(mission).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(
      callsTo(fetchMock, missionUrl("bayon-orchestrator"), "POST"),
    ).toHaveLength(1),
  );
  expect(
    bodyOf(fetchMock, missionUrl("bayon-orchestrator"), "POST"),
  ).toMatchObject({
    laws_md: "- staff one ticket at a time\n- never staff a paused project",
    note: "one more law",
    base_version: 1,
  });
});

test("the view reads the orchestrator's own pulses and mission", async () => {
  const fetchMock = renderIde(HASH, BAYON);
  await region("recent pulses");
  await waitFor(() =>
    expect(
      callsTo(fetchMock, agentPulsesUrl("bayon-orchestrator")),
    ).toHaveLength(1),
  );
  expect(callsTo(fetchMock, missionUrl("bayon-orchestrator"))).toHaveLength(1);
});

test("an unsaved mission draft survives opening a ticket tab and coming back: the view stays mounted", async () => {
  const fetchMock = renderIde(HASH, BAYON, {
    [missionUrl("bayon-orchestrator")]: missionView(
      [
        missionVersion({
          version: 1,
          agent_name: "bayon-orchestrator",
          laws_md: "- staff one ticket at a time",
        }),
      ],
      "bayon-orchestrator",
    ),
  });
  const user = userEvent.setup();
  const laws = (await within(await region("mission")).findByLabelText(
    "Laws",
  )) as HTMLTextAreaElement;
  await user.type(laws, "\n- a law not saved yet");

  await navigate(`${HASH}?open=ticket:12`);
  await waitFor(() => expect(tabNames()).toEqual(["Orchestrator", "#12"]));
  // Hidden while the ticket is on screen, and out of the tab order.
  expect(screen.queryByRole("region", { name: "mission" })).toBe(null);

  await user.click(screen.getByRole("tab", { name: "Orchestrator" }));
  const back = (await within(await region("mission")).findByLabelText(
    "Laws",
  )) as HTMLTextAreaElement;
  expect(back.value).toBe(
    "- staff one ticket at a time\n- a law not saved yet",
  );
  // Kept, not refetched and re-seeded: the mission was read once.
  expect(callsTo(fetchMock, missionUrl("bayon-orchestrator"))).toHaveLength(1);
});
