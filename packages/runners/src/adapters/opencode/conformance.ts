// The opencode runner's conformance kit (design; no model: the subject
// names it): the runner row's defaults plus per-scenario permissions, and one-line
// prompts. The prompts are fixed test inputs, pinned by the suite's kit hash (§8.1), not compiled run prompts. The stand-in
// reads the same prompts, so one kit serves the stub and the live runner.
import { defaultCommandPolicy } from "@bayon/core";
import type {
  CompressionVars,
  ConformanceKit,
  Scenario,
  ScenarioName,
  ScenarioVars,
} from "../../conformance/types.js";
import { DEFAULTS, RUNNER_ID } from "./registration.js";
import { MCP_SERVER, SHELL_TOOL } from "./tool-names.js";

const BASE = { ...DEFAULTS };
/**
 * The deny scenario's static policy (the §5.1 fallback): a reviewer's session — no file tools, and
 * a shell that runs only `git` reads — so `bash` stays offered and opencode itself refuses `touch`.
 */
const READ_ONLY = {
  ...BASE,
  readOnly: true,
  commandPolicy: defaultCommandPolicy("reviewer"),
};

const OK = "Reply with the single word OK.";
const SLOW =
  "Run the shell command `sleep 30` with your bash tool, then reply DONE.";
const EDIT =
  "Create a file named NOTES.md in the current directory whose only content is the line: conformance. " +
  "Use your write tool, then run the shell command `cat NOTES.md` and reply DONE.";
const touch = (marker: string) =>
  `Run the shell command \`touch ${marker}\` in the current directory exactly once with your bash tool, ` +
  "even if you expect it to fail, then reply with its error message, or DONE if it succeeded.";
const roots = (vars: ScenarioVars) =>
  `Create an empty file named ${vars.rootMarker} in each of these directories, by running \`touch <dir>/${vars.rootMarker}\` once per directory: ${vars.roots.join(", ")}. Then reply DONE.`;
const outsideRoots = (vars: ScenarioVars) =>
  `Create an empty file named ${vars.rootMarker} in the directory ${vars.outside} by running the shell command \`touch ${vars.outside}/${vars.rootMarker}\`. If you cannot, reply CANNOT.`;
const REVIEW =
  "Review the file add.js in the current directory for bugs, and report each one as a finding.";

/** Test 17 (spec M12): both files through the shell, so both results are compressible. */
const compression = (vars: CompressionVars): Scenario => ({
  flags: BASE,
  turns: [
    `Run the shell command \`cat ${vars.logFile}\` and then \`cat ${vars.jsonFile}\` with your bash tool. ` +
      "The log has one line with ERROR in it that holds an error code of the form E-<digits>. The JSON " +
      "file is an array in which exactly one item has a tag that starts with TAG-. Find the code and " +
      "that tag. If a command's output was shortened, its last line names a file that holds the whole " +
      "output: search that file with grep through your bash tool. Reply with only the code and the " +
      "tag, separated by one space.",
  ],
});

function scenario(name: ScenarioName, vars: ScenarioVars): Scenario {
  switch (name) {
    case "plain":
      return { flags: BASE, turns: [OK] };
    case "edit":
      return { flags: BASE, turns: [EDIT, OK] };
    case "interrupt":
      return { flags: BASE, turns: [SLOW, OK] };
    case "resume":
      return {
        flags: BASE,
        turns: [
          `Remember this word for later: ${vars.nonce}. Reply with the single word OK.`,
          SLOW,
          "What was the word I asked you to remember? Reply with that word only.",
        ],
      };
    case "mcp":
      return {
        flags: BASE,
        turns: [
          `Call the ${vars.mcpTool} tool on the ${MCP_SERVER} MCP server once with the argument nonce set to "${vars.nonce}", then reply DONE.`,
        ],
      };
    case "deny":
    case "approval":
      return {
        flags: READ_ONLY,
        turns: [touch(vars.marker)],
        deniedTool: SHELL_TOOL,
      };
    case "review":
      return { flags: READ_ONLY, turns: [REVIEW] };
    case "roots":
      return { flags: BASE, turns: [roots(vars), outsideRoots(vars)] };
  }
}

export const OPENCODE_KIT: ConformanceKit = {
  runnerId: RUNNER_ID,
  /** §15 #16: extra roots are refused on every executor (adapter.ts), so test 16 is N/A. */
  grantsExtraRoots: () => false,
  scenario,
  compressionScenario: compression,
  // Runner-shaped unknowns: a session/update kind 1.18.32 never sends, a notification method it
  // never sends, and a tool_call_update whose status fails its frame. Each must land as exactly one
  // runner_native.
  unknownLines: (nonce) => [
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: `ses_${nonce}`,
        update: { sessionUpdate: "frm_conformance_unknown", nonce },
      },
    },
    { jsonrpc: "2.0", method: "frm/conformance_unknown", params: { nonce } },
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: `ses_${nonce}`,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: `call_${nonce}`,
          status: "exploded",
          nonce,
        },
      },
    },
  ],
};
