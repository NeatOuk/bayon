// The whole suite against the fixture runner on real processes (LocalExecutor, the real program):
// real pipes, a real kill -9, real waits under budgets scaled to the machine's load. Reference
// ports, so never certifiable.
import { systemClock, type ConformanceResult } from "@bayon/core";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { expect, test } from "vitest";
import { FIXTURE_KIT } from "../adapters/fixture/conformance.js";
import { createFixtureAdapter } from "../adapters/fixture/index.js";
import { FaultExecutor } from "./fault-executor.js";
import { FIXTURE_EXPECTED, runUnderLoad, statuses } from "./fixtures.js";
import { createReferencePorts } from "./reference.js";
import { renderReport } from "./report.js";
import { runConformance } from "./suite.js";
import type { Budgets } from "./types.js";

async function suiteOnFixture(budgets: Budgets): Promise<ConformanceResult> {
  const ports = await createReferencePorts({ clock: systemClock, budgets });
  try {
    const result = await runConformance(
      {
        adapter: createFixtureAdapter({ graceMs: budgets.graceMs }),
        kit: FIXTURE_KIT,
        model: "fixture-model",
        executor: new FaultExecutor(
          new LocalExecutor({ id: "local", slots: new SlotCounter(8) }),
        ),
        env: { PATH: process.env["PATH"] ?? "" },
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
  "the fixture on real processes passes every applicable test",
  { timeout: 120_000 },
  async () => {
    const r = await runUnderLoad(suiteOnFixture);
    expect(statuses(r)).toEqual(FIXTURE_EXPECTED);
    expect(r.tests.find((t) => t.id === 12)?.fallback).toMatch(
      /^toolApprovalCallback=false/,
    );
    expect(r.summary).toMatchObject({
      na: [12, 13],
      certifiable: false, // reference ports never certify
      gate_eligible: false,
      unattended_allowed: false,
    });
    expect(r).toMatchObject({
      runner_id: "fixture",
      runner_version: "1",
      model: "fixture-model",
      executor: { id: "local", kind: "local" },
      ports: {
        ingest: "reference",
        watchdog: "reference",
        mcp: "reference",
        workspace: "reference",
      },
    });
    expect(r.spend.cost_usd).toBeGreaterThan(0);
    expect(renderReport(r)).toContain(
      "# Conformance — fixture 1 · fixture-model on local",
    );
  },
);
