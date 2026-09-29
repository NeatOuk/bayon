import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PulsePolicy } from "@bayon/core";
import {
  CreateTicketRequest,
  MCP_INPUTS,
  ROLE_MATRIX,
  SHIPPED_ALLOWLISTS,
} from "@bayon/proto";
import { FIXTURE_RUNNER_ID, FixtureScript } from "@bayon/runners/fixture";
import { afterAll, expect, test } from "vitest";
import { createFixtureRepo } from "./fixture-repo.js";
import {
  BUILDER_MISSION,
  BUILDER_SCRIPT,
  M2,
  M2_MISSIONS,
  ORCH_MISSION,
  ORCH_SCRIPT,
  m2Config,
  m2Settings,
  m2Ticket,
  packetPath,
  staffedClass,
} from "./m2-config.js";

const T0 = 1_700_000_000_000;

// the fixture repo once lived at /tmp/frm-m2-config-<pid> and was never removed, so a
// reused pid met the last run's commit there and the new commit had nothing to commit. Each run now
// makes its own directory, and every directory this file made is gone once it ends, pass or fail.
const LEGACY_DIR = `/tmp/frm-m2-config-${process.pid}`;
let made: readonly string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "frm-m2-config-"));
  made = [...made, dir];
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  expect(made.filter((dir) => existsSync(dir))).toEqual([]);
});

const toolsOf = (script: FixtureScript) =>
  [...script.runs, ...script.variants.flatMap((v) => v.runs)].flatMap((r) =>
    r.mcp.map((s) => s.tool),
  );
const turnEnds = (events: readonly { kind: string }[]) =>
  events.filter((e) => e.kind === "turn_end").length;

test("the orchestrator's pulse: search, staff (a refusal tolerated), report; its tools only", () => {
  const script = FixtureScript.parse(ORCH_SCRIPT);
  const steps = script.runs[0]?.mcp ?? [];
  expect(steps.map((s) => s.tool)).toEqual([
    "ticket_search",
    "ticket_staff",
    "pulse_report",
  ]);
  expect(steps[1]?.expect.refusal_ok).toBe(true);
  // T by the form a model reads in its pulse pack; the search checks T is ticket 1.
  expect(steps[0]?.expect.fields).toMatchObject({ "rows.0.num": 1 });
  expect(steps[1]?.args).toEqual({ ticket: "#1", role: "builder" });
  expect(MCP_INPUTS.pulse_report.safeParse(steps[2]?.args).success).toBe(true);
  for (const tool of toolsOf(script)) {
    expect(SHIPPED_ALLOWLISTS.orchestrator).toContain(tool);
    expect(ROLE_MATRIX.orchestrator).toContain(tool);
  }
});

test("the builder: S1 by default, S2–S4 by the packets their worktree holds, newest first", () => {
  const script = FixtureScript.parse(BUILDER_SCRIPT);
  expect(script.crash_on_resume).toBe(true);
  expect(script.variants.map((v) => v.exists)).toEqual([
    packetPath(3),
    packetPath(2),
    packetPath(1),
  ]);
  const [s1, handoff] = script.runs;
  // S1 accepts first, then reaches the fixture ceiling at its gate.
  expect(s1?.mcp.map((s) => s.tool)).toEqual(["handoff_accept"]);
  expect(turnEnds(s1?.events_after ?? [])).toBe(M2.handoffAtTurns.fixture);
  expect(s1?.gate).toBe("release");
  expect(handoff?.mcp.map((s) => s.tool)).toEqual(["handoff_write"]);
  expect(
    MCP_INPUTS.handoff_write.safeParse(handoff?.mcp[0]?.args).success,
  ).toBe(true);
  const [s4, s3, s2] = script.variants.map((v) => v.runs);
  expect(s2?.[0]?.mcp.map((s) => s.tool)).toEqual([
    "handoff_accept",
    "handoff_request",
  ]);
  // S2 names its hand-off by the label its packet header shows.
  expect(s2?.[0]?.mcp[0]?.args).toEqual({ id: "handoff-1" });
  expect(s2?.[1]?.mcp.map((s) => s.tool)).toEqual(["handoff_write"]);
  expect(s3?.[0]?.gate).toBe("release");
  expect(s4?.[0]?.mcp.map((s) => s.tool)).toEqual([
    "handoff_accept",
    "ticket_get",
    "ticket_update",
  ]);
  expect(s4?.[0]?.mcp[2]?.args).toMatchObject({ status: "blocked" });
  for (const tool of toolsOf(script)) {
    expect(SHIPPED_ALLOWLISTS.builder).toContain(tool);
    expect(ROLE_MATRIX.builder).toContain(tool);
  }
});

test("the staffed class hands off at 3 turns on the fixture and 2 with a real model", () => {
  expect(staffedClass(false)).toMatchObject([
    { name: "spike", handoff_at_turns: 3 },
  ]);
  expect(staffedClass(true)).toMatchObject([
    { name: "spike", handoff_at_turns: 2 },
  ]);
  expect(m2Settings(false)).toMatchObject({
    "budget.daily_cap_usd": 2,
    "lifecycle.adopt_max": 1,
  });
  expect(m2Settings(true)).toMatchObject({
    "lifecycle.interrupt_grace_ms": 10_000,
  });
});

test("m2Config: the M0 repo and workspace, M2's agents only, a valid 20 s hybrid policy", async () => {
  // The old path's leftover, fixture commit and all, as a reused pid met it: it must not matter.
  if (!existsSync(LEGACY_DIR)) {
    made = [...made, LEGACY_DIR];
    const legacy = createFixtureRepo(LEGACY_DIR);
    if (!legacy.ok) throw new Error(legacy.error.message);
  }
  const repo = createFixtureRepo(scratch());
  if (!repo.ok) throw new Error(repo.error.message);
  for (const runnerId of [FIXTURE_RUNNER_ID, "a-real-runner"]) {
    const config = await m2Config({ now: T0, repo: repo.value, runnerId });
    const agents = config.afterBoot.agents ?? [];
    expect(agents.map((a) => a.id)).toEqual(M2_MISSIONS.map((m) => m.name));
    expect(agents.every((a) => a.runner_id === runnerId)).toBe(true);
    const orch = agents[0];
    expect(
      PulsePolicy.safeParse({
        mode: orch?.pulse_mode,
        intervalMs: orch?.pulse_interval_ms,
        debounceMs: orch?.pulse_debounce_ms,
        minGapMs: orch?.pulse_min_gap_ms,
        maxPerHour: orch?.pulse_max_per_hour,
        jitterPct: orch?.pulse_jitter_pct,
        createdAt: orch?.created_at,
      }).data,
    ).toMatchObject({ mode: "hybrid", intervalMs: 20_000, jitterPct: 0 });
    expect(config.afterBoot.workspaces?.length).toBe(1);
    expect(config.beforeBoot.run_classes?.map((c) => c.name)).toContain(
      "spike",
    );
    const scripted = (config.afterBoot.profiles ?? []).map((p) =>
      JSON.parse(p.sandbox_json ?? "{}"),
    );
    expect(scripted.every((s) => "script" in s)).toBe(
      runnerId === FIXTURE_RUNNER_ID,
    );
  }
});

test("smoke-orch's mission is the orchestrator's: route, staff, escalate, never the ticket's work", () => {
  expect(M2_MISSIONS.find((m) => m.name === M2.orch)?.text).toBe(ORCH_MISSION);
  expect(ORCH_MISSION.how_md).toContain("ticket_staff");
  expect(ORCH_MISSION.laws_md).toContain("Never do ticket work yourself");
  expect(Object.values(ORCH_MISSION).join(" ")).not.toContain("README");
});

test("smoke-m2-builder's mission matches T's real body: one line to the notes file, no other file", () => {
  expect(M2_MISSIONS.find((m) => m.name === M2.builder)?.text).toBe(
    BUILDER_MISSION,
  );
  expect(BUILDER_MISSION.what_md).toContain(`append one line to ${M2.notes}`);
  expect(BUILDER_MISSION.laws_md).toContain("Change no other file");
  for (const m of M2_MISSIONS) {
    expect(Object.values(m.text).join(" ")).not.toContain("README");
  }
  expect(m2Ticket(true).body_md).toContain(`append one line to ${M2.notes}`);
});

test("T: a docs ticket the operator files; the real one asks the third session to block it", () => {
  expect(CreateTicketRequest.safeParse(m2Ticket(false)).success).toBe(true);
  expect(m2Ticket(true).body_md).toContain("handoff-2");
  expect(m2Ticket(true).title).toContain(M2.searchWord);
});
