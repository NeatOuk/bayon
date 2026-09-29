// The claude-sdk kit for its stand-in CLI: the same scenarios, plus the stub's own controls. Tests
// only: the stub ignores prompts, so its runs are shaped by env.
import type { ConformanceKit } from "../../../conformance/types.js";
import { CLAUDE_SDK_KIT } from "../conformance.js";

export const CLAUDE_SDK_STUB_KIT: ConformanceKit = {
  ...CLAUDE_SDK_KIT,
  // Test 17: the stub plays the model from the files it is told (it ignores prompts).
  compressionScenario(vars) {
    const s = CLAUDE_SDK_KIT.compressionScenario?.(vars) ?? {
      flags: {},
      turns: [],
    };
    return {
      ...s,
      env: {
        ...s.env,
        FRM_STUB_CTX: JSON.stringify({
          log: vars.logFile,
          json: vars.jsonFile,
        }),
      },
    };
  },
  scenario(name, vars) {
    const s = CLAUDE_SDK_KIT.scenario(name, vars);
    // The first run starts a tool call and holds open until interrupted (tests 7 and 9).
    return name === "interrupt"
      ? { ...s, env: { ...s.env, FRM_STUB_SLOW_RUNS: "1" } }
      : s;
  },
};
