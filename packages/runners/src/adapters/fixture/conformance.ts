// The fixture runner's conformance kit: each scenario is a fixture script, so
// the fixture meets the same drives a real runner meets and passes every applicable test.
import type {
  ConformanceKit,
  Scenario,
  ScenarioName,
  ScenarioVars,
} from "../../conformance/types.js";
import { FIXTURE_RUNNER_ID } from "./adapter.js";
import type { FixtureScriptInput } from "./program.js";

type Run = FixtureScriptInput["runs"][number];

const TURN_START = {
  kind: "turn_start",
  runner_type: "fixture.step",
  payload: {},
};
const TURN_END = {
  kind: "turn_end",
  runner_type: "fixture.step",
  payload: {
    usage: {
      tokens_in: 100,
      tokens_out: 20,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
    },
    stop_reason: "end_turn",
  },
};
const say = (text: string) => ({
  kind: "assistant_text",
  runner_type: "fixture.text",
  text,
  payload: {},
});
const toolCall = (tool: string, callId: string, input: object) => ({
  kind: "tool_call",
  runner_type: "fixture.tool",
  tool_name: tool,
  payload: { call_id: callId, input },
});
const toolResult = (tool: string, callId: string) => ({
  kind: "tool_result",
  runner_type: "fixture.tool",
  tool_name: tool,
  status: "ok",
  payload: { call_id: callId },
});

/** The tool `deny` asks for, denied through `flags.deny`. */
export const FIXTURE_DENIED_TOOL = "shell";

const PLAIN: Run = { events: [TURN_START, say("OK"), TURN_END] };
const SLOW: Run = {
  events: [TURN_START, toolCall("shell", "call-slow", { command: "sleep 30" })],
  then: "hang",
};
const EDIT: Run = {
  appends: [{ path: "NOTES.md", text: "conformance\n" }],
  events: [
    TURN_START,
    toolCall("write", "call-edit", { path: "NOTES.md" }),
    toolResult("write", "call-edit"),
    {
      kind: "file_change",
      runner_type: "fixture.tool",
      payload: {
        path: "NOTES.md",
        change: "add",
        lines_added: 1,
        lines_removed: 0,
      },
    },
    TURN_END,
  ],
};
const denied = (marker: string): Run => ({
  appends: [{ path: marker, text: "denied\n", tool: FIXTURE_DENIED_TOOL }],
  events: [
    TURN_START,
    toolCall(FIXTURE_DENIED_TOOL, "call-deny", { command: `touch ${marker}` }),
    toolResult(FIXTURE_DENIED_TOOL, "call-deny"),
    TURN_END,
  ],
});

/**
 * Test 16. The fixture's appends are the one runner-side check of the boundary there is: each one
 * must land in the cwd or a declared extra root, judged by real paths, or the whole run fails
 * (program.ts `appendAll`). So turn 1 writes the marker in each granted root — proof the grant
 * arrived — and turn 2 attempts it in a directory outside every root, which the program refuses.
 */
const inRoots = (vars: ScenarioVars): Run => ({
  appends: vars.roots.map((root) => ({
    path: `${root}/${vars.rootMarker}`,
    text: "in-root\n",
  })),
  events: [TURN_START, say("ROOTS"), TURN_END],
});
const outsideRoots = (vars: ScenarioVars): Run => ({
  appends: [{ path: `${vars.outside}/${vars.rootMarker}`, text: "outside\n" }],
  events: [TURN_START, say("OUTSIDE"), TURN_END],
});

/** A severity-tagged finding line the heuristic parser reads (test 13's fallback). */
const REVIEW = "[major] add.js:3 — add() subtracts b instead of adding it";

const TURNS: Readonly<Record<ScenarioName, readonly string[]>> = {
  plain: ["plain"],
  edit: ["edit", "plain"],
  interrupt: ["slow", "plain"],
  resume: ["remember", "slow", "recall"],
  mcp: ["mcp"],
  deny: ["deny"],
  approval: ["deny"],
  review: ["review"],
  roots: ["roots", "outside"],
};

function runs(name: ScenarioName, vars: ScenarioVars): Run[] {
  switch (name) {
    case "plain":
      return [PLAIN];
    case "edit":
      return [EDIT, PLAIN];
    case "interrupt":
      return [SLOW, PLAIN];
    case "resume":
      return [PLAIN, SLOW, { events: [TURN_START, say(vars.nonce), TURN_END] }];
    case "mcp":
      return [
        {
          events: [TURN_START],
          mcp: [
            {
              tool: vars.mcpTool,
              args: { nonce: vars.nonce },
              expect: { fields: { nonce: vars.nonce } },
            },
          ],
        },
      ];
    case "deny":
    case "approval":
      return [denied(vars.marker)];
    case "review":
      return [{ events: [TURN_START, say(REVIEW), TURN_END] }];
    case "roots":
      return [inRoots(vars), outsideRoots(vars)];
  }
}

export const FIXTURE_KIT: ConformanceKit = {
  runnerId: FIXTURE_RUNNER_ID,
  // The program takes SpawnSpec.extraRoots and refuses any write outside them (test 16).
  grantsExtraRoots: () => true,
  scenario(name, vars): Scenario {
    const denies = name === "deny" || name === "approval";
    return {
      flags: {
        script: { runs: runs(name, vars) },
        ...(denies ? { deny: [FIXTURE_DENIED_TOOL] } : {}),
      },
      turns: TURNS[name],
      ...(denies ? { deniedTool: FIXTURE_DENIED_TOOL } : {}),
    };
  },
  // A known kind with a payload no schema accepts: parseCanonical keeps it as runner_native.
  unknownLines: (nonce) => [
    {
      kind: "tool_result",
      runner_type: "frm.conformance",
      tool_name: FIXTURE_DENIED_TOOL,
      status: "frm_unknown_status",
      payload: { call_id: "call-unknown", nonce },
    },
  ],
};
