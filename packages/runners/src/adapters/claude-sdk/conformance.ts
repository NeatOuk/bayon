// The claude-sdk runner's conformance kit, the runner
// row's defaults plus per-scenario tool lists and a per-turn cap, and one-line prompts. The
// prompts are fixed test inputs, pinned by the suite's kit hash (§8.1), not compiled run prompts.
import type {
  CompressionVars,
  ConformanceKit,
  Scenario,
  ScenarioName,
  ScenarioVars,
} from "../../conformance/types.js";
import { requiredCliVersion } from "./models.js";
import { DEFAULTS, RUNNER_ID } from "./registration.js";

/** The server name adapter.ts mounts the session's MCP server under. */
const MCP_SERVER = "foreman";

/** Keeps a single turn from spending the suite's budget. */
const BASE = { ...DEFAULTS, maxTurns: 4 };

const OK = "Reply with the single word OK.";
const SLOW =
  "Run the shell command `sleep 30` with your Bash tool, then reply DONE.";
const touch = (marker: string) =>
  `Create an empty file named ${marker} in the current directory by running \`touch ${marker}\` with your Bash tool. If you cannot, reply CANNOT.`;
const roots = (vars: ScenarioVars) =>
  `Create an empty file named ${vars.rootMarker} in each of these directories, by running \`touch <dir>/${vars.rootMarker}\` with your Bash tool once per directory: ${vars.roots.join(", ")}. Then reply DONE.`;
const outsideRoots = (vars: ScenarioVars) =>
  `Create an empty file named ${vars.rootMarker} in the directory ${vars.outside} by running \`touch ${vars.outside}/${vars.rootMarker}\` with your Bash tool. If you cannot, reply CANNOT.`;
const REVIEW =
  "Review the file add.js in the current directory for bugs. Reply with only a JSON object, " +
  'no other text, shaped exactly like {"summary": "…", "findings": [{"severity": "blocker" | "major" | ' +
  '"minor" | "nit", "summary": "…", "file": "add.js", "line": 3, "category": "correctness", ' +
  '"detail_md": null}]}.';

/**
 * Test 17 (spec M12): both files through the shell, so both results are compressible; Read and
 * subagents denied, so the original is read back through the shell too and every model call shares
 * one history.
 */
const compression = (vars: CompressionVars): Scenario => ({
  flags: {
    ...BASE,
    maxTurns: 8,
    allowedTools: ["Bash"],
    disallowedTools: ["Read", "Task", "Agent"],
  },
  turns: [
    `Run \`cat ${vars.logFile}\` and then \`cat ${vars.jsonFile}\` with your Bash tool. The log has one ` +
      "line with ERROR in it that holds an error code of the form E-<digits>. The JSON file is an " +
      "array in which exactly one item has a tag that starts with TAG-. Find the code and that tag. " +
      "If a command's output was shortened, its last line names a file that holds the whole output: " +
      "search that file with grep through your Bash tool. Reply with only the code and the tag, " +
      "separated by one space.",
  ],
});

function scenario(name: ScenarioName, vars: ScenarioVars): Scenario {
  switch (name) {
    case "plain":
      return { flags: BASE, turns: [OK] };
    case "edit":
      return {
        flags: { ...BASE, allowedTools: ["Write", "Edit", "Read"] },
        turns: [
          "Create a file named NOTES.md in the current directory whose only content is the line: conformance. Use your Write tool, then reply DONE.",
          OK,
        ],
      };
    case "interrupt":
      return {
        flags: { ...BASE, allowedTools: ["Bash(sleep:*)"] },
        turns: [SLOW, OK],
      };
    case "resume":
      return {
        flags: { ...BASE, allowedTools: ["Bash(sleep:*)"] },
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
          `Call the mcp__${MCP_SERVER}__${vars.mcpTool} tool once with the argument nonce set to "${vars.nonce}", then reply DONE.`,
        ],
      };
    case "deny":
      return {
        flags: {
          ...BASE,
          disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit"],
        },
        turns: [touch(vars.marker)],
        deniedTool: "Bash",
      };
    case "approval":
      return {
        flags: {
          ...BASE,
          permissionMode: "default",
          permissionPrompts: "host",
        },
        turns: [touch(vars.marker)],
        deniedTool: "Bash",
      };
    case "review":
      return { flags: { ...BASE, allowedTools: ["Read"] }, turns: [REVIEW] };
    case "roots":
      return {
        flags: { ...BASE, allowedTools: ["Bash(touch:*)", "Write", "Read"] },
        turns: [roots(vars), outsideRoots(vars)],
      };
  }
}

export const CLAUDE_SDK_KIT: ConformanceKit = {
  runnerId: RUNNER_ID,
  // adapter.ts maps SpawnSpec.extraRoots onto the SDK's own additionalDirectories, and the
  // sandbox holds the boundary at those directories and the cwd (test 16).
  grantsExtraRoots: () => true,
  scenario,
  compressionScenario: compression,
  // A system frame with an unknown subtype: the stream's own shape, a type the mapper never saw.
  unknownLines: (nonce) => [
    { type: "system", subtype: "frm_conformance_unknown", nonce },
  ],
  // a model too new for the pinned CLI fails every test the same way; recognise it once
  // and stop the suite rather than run 13 more doomed tests at the tier's price.
  blocker: (errorMessages) => {
    for (const message of errorMessages) {
      const version = requiredCliVersion(message);
      if (version !== null) return version;
    }
    return null;
  },
};
