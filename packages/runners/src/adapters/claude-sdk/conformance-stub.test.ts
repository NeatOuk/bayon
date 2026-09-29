// The conformance subset the stand-in CLI can drive, through the real SDK and the real local
// executor, no key: 1, 2, 3, 7, 9, 10, 13 and 14. It proves the faults reach the runner through the
// SDK (a stall silences it; the SDK tolerates injected unknown frames), and that a review's answer
// reaches SendSpec.output.path through outputFormat (13, now on its cap branch), before any live
// spend.
import { CHEAP_MODEL } from "./testing/cheap-model.js";
import { systemClock } from "@bayon/core";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { expect, test } from "vitest";
import { FaultExecutor } from "../../conformance/fault-executor.js";
import { createReferencePorts } from "../../conformance/reference.js";
import { statuses } from "../../conformance/fixtures.js";
import { renderReport } from "../../conformance/report.js";
import { runConformance } from "../../conformance/suite.js";
import { OFFLINE_BUDGETS, type Budgets } from "../../conformance/types.js";
import { createClaudeSdkAdapter } from "./adapter.js";
import { CLAUDE_SDK_STUB_KIT } from "./testing/conformance-stub.js";
import { STUB_CLI } from "./testing/stub.js";

const BUDGETS: Budgets = {
  ...OFFLINE_BUDGETS,
  callMs: 20_000,
  turnMs: 20_000,
  hangMs: 2_000,
  graceMs: 500,
};

test(
  "claude-sdk on its stub CLI passes 1, 2, 3, 7, 9, 10, 13 and 14",
  { timeout: 180_000 },
  async () => {
    const ports = await createReferencePorts({
      clock: systemClock,
      budgets: BUDGETS,
    });
    try {
      const result = await runConformance(
        {
          adapter: createClaudeSdkAdapter({
            pathToExecutable: STUB_CLI,
            executable: "node",
            graceMs: 500,
          }),
          kit: CLAUDE_SDK_STUB_KIT,
          model: CHEAP_MODEL,
          executor: new FaultExecutor(
            new LocalExecutor({ id: "local", slots: new SlotCounter(8) }),
          ),
          // The stub runs under `node`, found on PATH.
          env: { PATH: process.env["PATH"] ?? "" },
        },
        ports,
        { budgets: BUDGETS, only: [1, 2, 3, 7, 9, 10, 13, 14] },
      );
      if (!result.ok) throw new Error(result.error.message);
      expect(
        statuses(result.value).filter(
          (s) => !s.endsWith("not_run not in options.only"),
        ),
      ).toEqual([
        "1 pass",
        "2 pass",
        "3 pass",
        "7 pass",
        "9 pass",
        "10 pass",
        "13 pass",
        "14 pass",
      ]);
    } finally {
      await ports.workspace.dispose();
    }
  },
);

test(
  "a model too new for the pinned CLI halts the suite at test 2",
  { timeout: 180_000 },
  async () => {
    const ports = await createReferencePorts({
      clock: systemClock,
      budgets: BUDGETS,
    });
    try {
      const result = await runConformance(
        {
          adapter: createClaudeSdkAdapter({
            pathToExecutable: STUB_CLI,
            executable: "node",
            graceMs: 500,
          }),
          kit: CLAUDE_SDK_STUB_KIT,
          model: CHEAP_MODEL,
          executor: new FaultExecutor(
            new LocalExecutor({ id: "local", slots: new SlotCounter(8) }),
          ),
          env: {
            PATH: process.env["PATH"] ?? "",
            FRM_STUB_MODEL_400: "2.1.283:2.2.0",
          },
        },
        ports,
        { budgets: BUDGETS },
      );
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.summary.certifiable).toBe(false);
      expect(result.value.tests.map((t) => t.status)).toEqual([
        "pass",
        "fail",
        ...Array.from({ length: 14 }, () => "incomplete"),
      ]);
      const test2 = result.value.tests.find((t) => t.id === 2);
      expect(
        test2?.checks.some(
          (c) =>
            c.name === "runner_version" &&
            !c.ok &&
            c.detail?.includes("version 2.2.0 or newer is required"),
        ),
      ).toBe(true);
      const test3 = result.value.tests.find((t) => t.id === 3);
      expect(
        test3?.checks.some((c) =>
          c.detail?.includes("version 2.2.0 or newer is required"),
        ),
      ).toBe(true);
      expect(renderReport(result.value)).toContain(
        "version 2.2.0 or newer is required",
      );
    } finally {
      await ports.workspace.dispose();
    }
  },
);
