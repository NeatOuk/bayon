// The full conformance suite against the real runner. CI never sets
// FRM_REAL_RUNNER, so this is skipped there; run it by hand and paste the result into the PR:
//   FRM_REAL_RUNNER=1 CLAUDE_CODE_OAUTH_TOKEN=… pnpm exec vitest run packages/runners/src/adapters/claude-sdk/conformance.live.test.ts
// Reference ports, so the result is never certifiable: the committed report comes from // `frm runner conformance claude-sdk` on the supervisor's ports.
import { CHEAP_MODEL } from "./testing/cheap-model.js";
import { systemClock } from "@bayon/core";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { describe, expect, test } from "vitest";
import { FaultExecutor } from "../../conformance/fault-executor.js";
import { createReferencePorts } from "../../conformance/reference.js";
import { statuses } from "../../conformance/fixtures.js";
import { runConformance } from "../../conformance/suite.js";
import { LIVE_BUDGETS } from "../../conformance/types.js";
import { createClaudeSdkAdapter } from "./adapter.js";
import { CLAUDE_SDK_KIT } from "./conformance.js";
import { DEFAULTS } from "./registration.js";

const LIVE = process.env["FRM_REAL_RUNNER"] === "1";

describe.skipIf(!LIVE)(
  "claude-sdk conformance, live",
  { timeout: 1_800_000 },
  () => {
    test("the full suite on the real runner", async () => {
      // Whichever credential the operator has, first in the registration's one-of order.
      const auth = DEFAULTS.secretEnvAnyOf
        .flat()
        .find((name) => process.env[name]);
      expect(auth).toBeDefined();
      const ports = await createReferencePorts({
        clock: systemClock,
        budgets: LIVE_BUDGETS,
      });
      try {
        const result = await runConformance(
          {
            adapter: createClaudeSdkAdapter(),
            kit: CLAUDE_SDK_KIT,
            model: CHEAP_MODEL,
            executor: new FaultExecutor(
              new LocalExecutor({ id: "local", slots: new SlotCounter(4) }),
            ),
            env: {
              PATH: process.env["PATH"] ?? "",
              ...(auth === undefined
                ? {}
                : { [auth]: process.env[auth] ?? "" }),
            },
          },
          ports,
          { budgets: LIVE_BUDGETS },
        );
        if (!result.ok) throw new Error(result.error.message);
        // The evidence for the PR: statuses, checks and spend. Never the env.
        console.log(JSON.stringify(result.value, null, 2));
        expect(statuses(result.value)).toEqual([
          "1 pass",
          "2 pass",
          "3 pass",
          "4 pass",
          "5 pass",
          "6 pass",
          "7 pass",
          "8 pass",
          "9 pass",
          "10 pass",
          "11 pass",
          "12 na",
          "13 na",
          "14 pass",
          "15 pass",
          "16 pass",
        ]);
      } finally {
        await ports.workspace.dispose();
      }
    });
  },
);
