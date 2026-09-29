// The codex-exec runner's conformance kit,
// the runner row's defaults plus per-scenario sandbox, and one-line prompts. The prompts are fixed
// test inputs, pinned by the suite's kit hash (§8.1), not compiled run prompts. The stand-in CLI
// reads the same prompts, so one kit serves the stub and the live runner.
import type {
  ConformanceKit,
  Scenario,
  ScenarioName,
  ScenarioVars,
} from "../../conformance/types.js";
import { MCP_SERVER } from "./argv.js";
import { SHELL_TOOL } from "./mapper.js";
import { DEFAULTS, RUNNER_ID } from "./registration.js";

const BASE = { ...DEFAULTS };
/** The deny scenario's static policy: Codex's own sandbox refuses the write (the §5.1 fallback). */
const READ_ONLY = { ...BASE, sandbox: "read-only" };

const OK = "Reply with the single word OK.";
const SLOW = "Run the shell command `sleep 30`, then reply DONE.";
const EDIT =
  "Create a file named NOTES.md in the current directory whose only content is the line: conformance. " +
  "Then run the shell command `cat NOTES.md` and reply DONE.";
/**
 * The deny scenario's one shell call. Before the turn, Codex tells the model that the
 * sandbox only permits reading and that escalation will be rejected. With a way out ("If you
 * cannot, reply CANNOT") the model answers without trying; an escalated call is rejected before
 * Codex emits any item. Either way test 12 sees no call, and codex-exec, unlike a runner that can
 * unlist the tool, has no other way to show one. So the prompt asks for the attempt itself.
 */
const touch = (marker: string) =>
  `Run the shell command \`touch ${marker}\` in the current directory exactly once, as it is, with your shell tool. ` +
  "Do not request escalated permissions: leave sandbox_permissions unset. " +
  "This checks that the sandbox refuses the write, so run the command even though you expect it to fail, " +
  "then reply with its error message, or DONE if it succeeded.";
const roots = (vars: ScenarioVars) =>
  `Create an empty file named ${vars.rootMarker} in each of these directories, by running \`touch <dir>/${vars.rootMarker}\` once per directory: ${vars.roots.join(", ")}. Then reply DONE.`;
const outsideRoots = (vars: ScenarioVars) =>
  `Create an empty file named ${vars.rootMarker} in the directory ${vars.outside} by running the shell command \`touch ${vars.outside}/${vars.rootMarker}\`. If you cannot, reply CANNOT.`;
const REVIEW =
  "Review the file add.js in the current directory for bugs, and report each one as a finding.";

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

export const CODEX_EXEC_KIT: ConformanceKit = {
  runnerId: RUNNER_ID,
  /**
   * §15 #16. 0.154.0's `sandbox_workspace_write.writable_roots` is unverified against the pinned
   * binary, so adapter.ts refuses a non-empty `extraRoots` rather than drop the grant silently —
   * except under danger-full-access, where the container is the boundary and every path in it is
   * already writable. Read from the same `sandboxByKind` the spawn resolves, so the declaration
   * cannot drift from the refusal: test 16 is N/A exactly where the runner really refuses.
   */
  grantsExtraRoots: (executorKind) =>
    DEFAULTS.sandboxByKind[executorKind] === "danger-full-access",
  scenario,
  // Runner-shaped unknowns: an item type 0.154.0 never names, an unknown item.updated, and a known
  // item whose status fails its frame. Each must land as exactly one runner_native.
  unknownLines: (nonce) => [
    {
      type: "item.completed",
      item: { id: `frm_${nonce}_1`, type: "frm_conformance_unknown", nonce },
    },
    {
      type: "item.updated",
      item: { id: `frm_${nonce}_2`, type: "frm_conformance_unknown", nonce },
    },
    {
      type: "item.completed",
      item: {
        id: `frm_${nonce}_3`,
        type: "command_execution",
        command: "true",
        aggregated_output: "",
        exit_code: 0,
        status: "exploded",
        nonce,
      },
    },
  ],
};
