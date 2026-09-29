// The codex-exec kit's prompts, where a real model's reading of them decides a precondition
//. The stub is scripted to attempt whatever it is asked, so only these pin the intent.
import { expect, test } from "vitest";
import type { ScenarioVars } from "../../conformance/types.js";
import { CODEX_EXEC_KIT } from "./conformance.js";
import { SHELL_TOOL } from "./mapper.js";

const VARS: ScenarioVars = {
  nonce: "n-116",
  mcpTool: "conformance_echo",
  marker: "frm-marker-116",
  roots: [],
  outside: "/tmp/outside",
  rootMarker: "r",
};

test("test 12's deny turn asks for the shell attempt itself and offers no way out", () => {
  for (const name of ["deny", "approval"] as const) {
    const s = CODEX_EXEC_KIT.scenario(name, VARS);
    expect(s.deniedTool).toBe(SHELL_TOOL);
    expect(s.flags).toMatchObject({ sandbox: "read-only" });
    const [prompt, ...more] = s.turns;
    expect(more).toEqual([]);
    // The model is told the sandbox is read-only before the turn: a way out is taken, untried.
    expect(prompt).not.toMatch(/if you cannot|CANNOT/i);
    expect(prompt).toContain("`touch frm-marker-116`");
    expect(prompt).toContain("exactly once");
    expect(prompt).toContain("even though you expect it to fail");
    // An escalated call is rejected before Codex emits an item, so the stream would still be empty.
    expect(prompt).toContain("leave sandbox_permissions unset");
  }
});
