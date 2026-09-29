// The proof that tests 9, 10, 14 and 15 genuinely fail a non-compliant adapter (§15, design
// §5): each seeded bug fails exactly its test, on its named check, and every other test's checks
// ({name, ok}) stay exactly as the flag-free baseline has them.
import {
  certify,
  systemClock,
  type ConformanceResult,
  type ConformanceTestResult,
} from "@bayon/core";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { FaultExecutor } from "../../conformance/fault-executor.js";
import { createReferencePorts } from "../../conformance/reference.js";
import {
  FIXTURE_EXPECTED,
  runUnderLoad,
  statuses,
  type HangScale,
} from "../../conformance/fixtures.js";
import { runConformance } from "../../conformance/suite.js";
import { OFFLINE_BUDGETS, type Budgets } from "../../conformance/types.js";
import { FIXTURE_KIT } from "../fixture/conformance.js";
import { FIXTURE_PROGRAM, fixtureProgram } from "../fixture/index.js";
import { createBrokenStubAdapter, type BrokenStubFlags } from "./adapter.js";

/**
 * The program runs in-process (FakeExecutor), so its first record waits on this worker's share of a
 * loaded host, not on a boot of its own: the hang budget spans 10 child boots, from a 200 ms floor
 * (a quiet host pays nothing extra) to a 10 s cap. A green case costs ~0.7 s besides that wait;
 * with 4× that on a host loaded enough to reach the cap, a rerun case's worst is
 * 2 × (10 s + 3 s) = 26 s, under the 60 s timeout.
 */
const FAKE_PROCESS_SCALE: HangScale = {
  base: {
    ...OFFLINE_BUDGETS,
    callMs: 5_000,
    turnMs: 5_000,
    hangMs: 200,
    graceMs: 200,
  },
  perBoot: 10,
  maxHangMs: 10_000,
};

async function suite(
  flags: BrokenStubFlags,
  budgets: Budgets,
): Promise<ConformanceResult> {
  const ports = await createReferencePorts({ clock: systemClock, budgets });
  try {
    const result = await runConformance(
      {
        adapter: createBrokenStubAdapter(flags, {
          command: [FIXTURE_PROGRAM],
          graceMs: budgets.graceMs,
        }),
        kit: FIXTURE_KIT,
        model: "fixture-model",
        executor: new FaultExecutor(
          new FakeExecutor({
            programs: { [FIXTURE_PROGRAM]: fixtureProgram },
            slots: new SlotCounter(16),
          }),
        ),
        env: {},
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

/** The suite with `flags`, rerun once only if the host's load, not a seeded bug, failed test 9. */
const suiteUnderLoad = (
  flags: BrokenStubFlags,
  expectedFailed: readonly number[] = [],
) =>
  runUnderLoad((b) => suite(flags, b), {
    scale: FAKE_PROCESS_SCALE,
    expectedFailed,
  });

/** What "nothing else moved" compares: the status and each check's name and verdict. */
const shape = (t: ConformanceTestResult | undefined) => ({
  status: t?.status,
  checks: t?.checks.map((c) => ({ name: c.name, ok: c.ok })),
});

/** The result as supervisor ports would have certified it. */
function asCertified(r: ConformanceResult) {
  const summary = certify({
    ...r,
    ports: {
      ingest: "supervisor",
      watchdog: "supervisor",
      mcp: "supervisor",
      workspace: "supervisor",
    },
  });
  if (!summary.ok) throw new Error(summary.error.message);
  return summary.value.summary;
}

describe(
  "the broken stub (§15: 9, 10, 14 and 15 must genuinely fail, and cost unattended work)",
  { timeout: 60_000 },
  () => {
    let baseline: ConformanceResult;
    beforeAll(async () => {
      baseline = await suiteUnderLoad({});
    }, 60_000);

    test("with no flag set it is the fixture: every applicable test passes", () => {
      expect(statuses(baseline)).toEqual(FIXTURE_EXPECTED);
      expect(asCertified(baseline)).toMatchObject({
        gate_eligible: true,
        unattended_allowed: true,
      });
    });

    // The other half of §15's rule for test 15, and the reason it is a rule of its own: a runner
    // whose credential serves one session reports 15 N/A (admission enforces the limit instead,
    // §5.1) and is still trusted unattended. Only a runner that ran the test and contended is
    // refused — the `sharedState` row below. Re-certified from the baseline run, so the two cases
    // differ in exactly one test's status.
    test("an N/A test 15 keeps unattended work; only a failed one takes it away", () => {
      const single = {
        ...baseline,
        caps: { ...baseline.caps, concurrentSessions: false },
        tests: baseline.tests.map((t) =>
          t.id === 15
            ? {
                ...t,
                status: "na" as const,
                fallback:
                  "concurrentSessions=false; the one session kept its own home",
              }
            : t,
        ),
      };
      expect(asCertified(single)).toMatchObject({
        na: [12, 13, 15],
        failed: [],
        gate_eligible: true,
        unattended_allowed: true,
      });
    });

    test.each<[BrokenStubFlags, readonly number[], readonly string[]]>([
      [{ terminalOnExit: true }, [9], ["no_runner_terminal"]],
      [{ dropUnknown: true }, [10], ["unknown_stored"]],
      [{ ignoreHomeClaim: true }, [14], ["second_claim_refused"]],
      [{ sharedState: true }, [15], ["private_state"]],
      [{ ignoreExtraRoots: true }, [16], ["roots_written"]],
      [{ rootsEverywhere: true }, [16], ["outside_refused"]],
      [
        {
          terminalOnExit: true,
          dropUnknown: true,
          ignoreHomeClaim: true,
          sharedState: true,
          ignoreExtraRoots: true,
        },
        [9, 10, 14, 15, 16],
        [
          "no_runner_terminal",
          "unknown_stored",
          "second_claim_refused",
          "private_state",
          "roots_written",
        ],
      ],
    ])(
      "%o fails exactly %o, on %o, and nothing else moves",
      async (flags, failed, named) => {
        const r = await suiteUnderLoad(flags, failed);
        expect(r.summary.failed, statuses(r).join("; ")).toEqual(failed);
        const checks = r.tests.flatMap((t) =>
          failed.includes(t.id) ? t.checks : [],
        );
        for (const name of named) {
          expect(checks.find((c) => c.name === name)?.ok, name).toBe(false);
        }
        for (const t of r.tests) {
          if (failed.includes(t.id)) continue;
          expect(shape(t), `test ${t.id}`).toEqual(
            shape(baseline.tests.find((b) => b.id === t.id)),
          );
        }
        // §15's two rules for unattended work, kept apart here as they are in core: these must
        // have passed, and these must not have failed. A seeded bug outside both lists (16)
        // costs gate_eligible alone, which every failure costs.
        const mustPass = [9, 10, 14];
        const mustNotFail = [15];
        const unattended = !failed.some(
          (id) => mustPass.includes(id) || mustNotFail.includes(id),
        );
        expect(asCertified(r)).toMatchObject({
          gate_eligible: false,
          unattended_allowed: unattended,
        });
      },
    );
  },
);
