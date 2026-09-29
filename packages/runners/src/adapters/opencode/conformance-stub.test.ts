// The whole conformance suite on opencode's stand-in, through the real turn host
// and the real local executor, no model: every test passes except the two that run their fallback
// and hold there (12: the static deny of a reviewer's permissions; 16: extra roots it refuses).
import { systemClock, type ConformanceResult } from "@bayon/core";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { expect, test } from "vitest";
import { FaultExecutor } from "../../conformance/fault-executor.js";
import { runUnderLoad } from "../../conformance/fixtures.js";
import { createReferencePorts } from "../../conformance/reference.js";
import { runConformance } from "../../conformance/suite.js";
import type { Budgets } from "../../conformance/types.js";
import { createOpencodeAdapter } from "./adapter.js";
import { OPENCODE_KIT } from "./conformance.js";
import { CHEAP_MODEL } from "./testing/cheap-model.js";
import { STUB_OPENCODE } from "./testing/stub.js";

async function suiteOnStub(budgets: Budgets): Promise<ConformanceResult> {
  const ports = await createReferencePorts({ clock: systemClock, budgets });
  try {
    const result = await runConformance(
      {
        adapter: createOpencodeAdapter({
          bin: [process.execPath, STUB_OPENCODE],
          graceMs: budgets.graceMs,
          ...(process.platform === "darwin" ? {} : { unsandboxed: true }),
        }),
        kit: OPENCODE_KIT,
        executor: new FaultExecutor(
          new LocalExecutor({ id: "local", slots: new SlotCounter(8) }),
        ),
        env: { PATH: process.env["PATH"] ?? "" },
        model: CHEAP_MODEL,
      },
      ports,
      { budgets },
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  } finally {
    await ports.workspace.dispose();
  }
}

test(
  "opencode on its stub: 1–16 pass, 12 and 16 are N/A on their verified fallbacks",
  { timeout: 300_000 },
  async () => {
    const result = await runUnderLoad(suiteOnStub);
    const failed = result.tests
      .filter((t) => t.status !== "pass" && t.status !== "na")
      .map((t) => ({
        id: t.id,
        status: t.status,
        checks: t.checks.filter((c) => !c.ok),
      }));
    expect(failed).toEqual([]);
    expect(result.tests.map((t) => `${t.id} ${t.status}`)).toEqual([
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
      "13 pass",
      "14 pass",
      "15 pass",
      "16 na",
    ]);
  },
);
