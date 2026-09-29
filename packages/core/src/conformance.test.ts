import { describe, expect, test } from "vitest";
import {
  ALL_CONFORMANCE_TEST_IDS,
  COMPRESSION_TEST_ID,
  CONFORMANCE_TEST_IDS,
  CONFORMANCE_TEST_NAMES,
  expectedTestIds,
  NEVER_NA,
  SUITE_VERSION,
  certify,
  type ConformanceCheck,
  type ConformanceDraft,
  type ConformanceTestId,
  type ConformanceTestResult,
} from "./conformance.js";
import type { RunnerCaps } from "./runner-caps.js";

const CAPS: RunnerCaps = {
  structuredEvents: true,
  multiTurnInProcess: true,
  resumable: true,
  concurrentSessions: true,
  costReporting: true,
  tokenCounting: false,
  toolApprovalCallback: false,
  sandboxModes: false,
  mcpClient: true,
  hooks: false,
  pty: false,
  outputSchema: false,
  imageInput: false,
  subagents: false,
};

const check = (name: string, ok = true): ConformanceCheck => ({
  name,
  ok,
  detail: null,
});

/** A test as the suite writes it; 12 and 13 are N/A under CAPS (no approval, no schema). */
function entry(
  id: ConformanceTestId,
  o: Partial<ConformanceTestResult> = {},
): ConformanceTestResult {
  const na = id === 12 || id === 13;
  return {
    id,
    name: CONFORMANCE_TEST_NAMES[id],
    status: na ? "na" : "pass",
    attempts: 1,
    duration_ms: 12,
    fallback: na ? "the fallback held" : null,
    checks: [check("held")],
    ...o,
  };
}

function draft(
  o: Partial<ConformanceDraft> & {
    readonly change?: Partial<
      Record<ConformanceTestId, Partial<ConformanceTestResult>>
    >;
  } = {},
): ConformanceDraft {
  const { change = {}, ...rest } = o;
  return {
    schema: 1,
    suite_version: SUITE_VERSION,
    runner_id: "fixture",
    runner_version: "1",
    model: "fixture-model",
    executor: { id: "local", kind: "local", image_id: null },
    started_at: 1_000,
    finished_at: 2_000,
    kit_hash: "sha256:abc",
    ports: {
      ingest: "supervisor",
      watchdog: "supervisor",
      mcp: "supervisor",
      workspace: "supervisor",
    },
    caps: CAPS,
    spend: { tokens_in: 10, tokens_out: 2, cost_usd: 0.01 },
    tests: expectedTestIds(
      rest.compression !== undefined && rest.compression !== null,
    ).map((id) => entry(id, change[id])),
    ...rest,
  };
}

/** A compression-on draft (spec M12): 1–17, the ruleset named. */
const ON = { compression: { ruleset: "ctx1" } } as const;

function certified(d: unknown) {
  const result = certify(d);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.summary;
}

function refused(d: unknown): string {
  const result = certify(d);
  if (result.ok) throw new Error("expected a refusal");
  expect(result.error.class).toBe("validation");
  return result.error.message;
}

describe("certify: the summary is recomputed, never trusted", () => {
  test("a clean run on supervisor ports is certifiable, gate-eligible and unattended", () => {
    expect(certified(draft())).toEqual({
      passed: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 16],
      failed: [],
      na: [12, 13],
      incomplete: [],
      unverified_caps: [],
      certifiable: true,
      gate_eligible: true,
      unattended_allowed: true,
    });
  });

  test("a forged summary is replaced", () => {
    const forged = {
      ...draft({
        change: { 9: { status: "fail", checks: [check("x", false)] } },
      }),
      summary: {
        passed: [],
        failed: [],
        na: [],
        incomplete: [],
        unverified_caps: [],
        certifiable: true,
        gate_eligible: true,
        unattended_allowed: true,
      },
    };
    expect(certified(forged)).toMatchObject({
      failed: [9],
      gate_eligible: false,
      unattended_allowed: false,
    });
  });

  test.each(["ingest", "watchdog", "mcp", "workspace"] as const)(
    "a reference %s port is never certifiable",
    (port) => {
      const d = draft();
      expect(
        certified({ ...d, ports: { ...d.ports, [port]: "reference" } }),
      ).toMatchObject({
        certifiable: false,
        gate_eligible: false,
        unattended_allowed: false,
      });
    },
  );

  test("an incomplete test (a spent budget) is never certifiable", () => {
    expect(
      certified(
        draft({ change: { 13: { status: "incomplete", fallback: null } } }),
      ),
    ).toMatchObject({
      incomplete: [13],
      certifiable: false,
      gate_eligible: false,
      unattended_allowed: false,
    });
  });

  test("without structuredEvents a runner is never gate-eligible, but may run unattended", () => {
    expect(
      certified(draft({ caps: { ...CAPS, structuredEvents: false } })),
    ).toMatchObject({ gate_eligible: false, unattended_allowed: true });
  });

  test("a failed ordinary test costs gate eligibility only", () => {
    expect(
      certified(
        draft({
          change: { 4: { status: "fail", checks: [check("x", false)] } },
        }),
      ),
    ).toMatchObject({
      failed: [4],
      certifiable: true,
      gate_eligible: false,
      unattended_allowed: true,
    });
  });

  test.each([9, 10, 14] as const)(
    "a failed non-negotiable test %i forbids unattended work",
    (id) => {
      expect(
        certified(
          draft({
            change: { [id]: { status: "fail", checks: [check("x", false)] } },
          }),
        ),
      ).toMatchObject({ gate_eligible: false, unattended_allowed: false });
    },
  );

  test("a failed test 1 forbids unattended work: it pins nothing", () => {
    expect(
      certified(
        draft({
          change: {
            1: { status: "fail", checks: [check("health_ok", false)] },
          },
        }),
      ),
    ).toMatchObject({
      failed: [1],
      certifiable: true,
      unattended_allowed: false,
    });
  });

  test("image_id defaults to null, so results stored before it still certify", () => {
    const { executor, ...rest } = draft();
    expect(
      certify({ ...rest, executor: { id: executor.id, kind: executor.kind } }),
    ).toMatchObject({ ok: true, value: { executor: { image_id: null } } });
  });

  // On a container the image id is the pair's only falsifiable pin: the health
  // pass reads no version there (test 1 read it inside a session), so versionDrift is a no-op by
  // construction. With no image id such a certification can never lapse — and every container
  // certification predating an earlier change has none, while new base builds a different image.
  const container = (image_id: string | null) =>
    draft({ executor: { id: "ctr-lab", kind: "container", image_id } });

  test("a container pair with no image pin is never unattended: it pins nothing at all", () => {
    expect(certified(container(null))).toMatchObject({
      passed: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 16],
      certifiable: true,
      gate_eligible: true,
      unattended_allowed: false,
    });
    expect(certified(container(`sha256:${"a".repeat(64)}`))).toMatchObject({
      certifiable: true,
      unattended_allowed: true,
    });
  });

  test("only a container needs one: an executor with no image pins the version instead", () => {
    for (const kind of ["local", "remote"] as const) {
      expect(
        certified(draft({ executor: { id: "e", kind, image_id: null } })),
      ).toMatchObject({ unattended_allowed: true });
    }
  });

  test("unverified caps are the declared ones no test checks", () => {
    expect(
      certified(
        draft({ caps: { ...CAPS, pty: true, subagents: true, hooks: false } }),
      ),
    ).toMatchObject({ unverified_caps: ["pty", "subagents"] });
  });
});

// §15 (page v33): unattended work needs 9, 10 and 14 passed and 15 not failed. Two rules, because
// 15 can legitimately be N/A — a credential that serves one session at a time, which admission
// enforces instead (§5.1) — while 9, 10 and 14 never can.
describe("certify: what unattended work requires", () => {
  const failed = (id: ConformanceTestId) =>
    certified(
      draft({
        change: { [id]: { status: "fail", checks: [check("x", false)] } },
      }),
    );

  test.each([9, 10, 14, 15] as const)(
    "a failed test %i takes unattended work away",
    (id) => {
      expect(failed(id)).toMatchObject({
        gate_eligible: false,
        unattended_allowed: false,
      });
    },
  );

  test("an N/A test 15 keeps it: the runner's credential serves one session, and admission enforces that", () => {
    expect(
      certified(
        draft({
          caps: { ...CAPS, concurrentSessions: false },
          change: {
            15: { status: "na", fallback: "one session at a time" },
          },
        }),
      ),
    ).toMatchObject({
      na: [12, 13, 15],
      gate_eligible: true,
      unattended_allowed: true,
    });
  });

  test("a test outside both rules costs gate_eligible, not unattended work", () => {
    expect(failed(16)).toMatchObject({
      gate_eligible: false,
      unattended_allowed: true,
    });
  });
});

describe("certify: compression on or off (spec M12)", () => {
  test("a draft with no compression is off, and its result says so", () => {
    const r = certify(draft());
    expect(r.ok ? r.value.compression : "refused").toBeNull();
    const on = certify(draft(ON));
    expect(on.ok ? on.value.compression : "refused").toEqual({
      ruleset: "ctx1",
    });
  });

  test("with compression on, unattended work needs test 17 passed", () => {
    expect(certified(draft(ON)).unattended_allowed).toBe(true);
    const failed = certified(
      draft({
        ...ON,
        change: { 17: { status: "fail", checks: [check("tag", false)] } },
      }),
    );
    expect(failed).toMatchObject({
      failed: [17],
      certifiable: true,
      gate_eligible: false,
      unattended_allowed: false,
    });
  });
});

describe("certify: statuses must agree with their checks, caps and fallbacks", () => {
  test.each(NEVER_NA)("test %i can never be N/A", (id) => {
    expect(
      refused(
        draft({ ...ON, change: { [id]: { status: "na", fallback: "f" } } }),
      ),
    ).toBe(`test ${id} can never be N/A`);
  });

  test("N/A needs its gating cap declared absent", () => {
    expect(refused(draft({ caps: { ...CAPS, outputSchema: true } }))).toBe(
      "test 13 is N/A but outputSchema is declared",
    );
  });

  test("N/A needs a fallback", () => {
    expect(refused(draft({ change: { 12: { fallback: null } } }))).toBe(
      "test 12 is N/A with no fallback",
    );
  });

  test("N/A needs its fallback check to hold", () => {
    expect(
      refused(draft({ change: { 12: { checks: [check("deny", false)] } } })),
    ).toBe("test 12 is N/A with a failed check");
  });

  // §15 #16: a test whose N/A is the runner's own declared refusal, not a §5.1 cap.
  test("a declared N/A needs a fallback and checks that hold", () => {
    const problem = (d: unknown): string | undefined => {
      const r = certify(d);
      return r.ok ? undefined : r.error.message;
    };
    const na = (change: Partial<ConformanceTestResult>) =>
      problem(
        draft({
          change: {
            16: { status: "na", fallback: "it refuses extra roots", ...change },
          },
        }),
      );
    expect(na({ checks: [check("roots_refused")] })).toBeUndefined();
    expect(na({ checks: [] })).toBe("test 16 is N/A with no checks");
    expect(na({ fallback: null, checks: [check("roots_refused")] })).toBe(
      "test 16 is N/A with no fallback",
    );
    expect(na({ checks: [check("roots_refused", false)] })).toBe(
      "test 16 is N/A with a failed check",
    );
    // It has no gating cap, so no cap can contradict it and it may still simply pass.
    expect(
      problem(draft({ change: { 16: { status: "pass", fallback: null } } })),
    ).toBeUndefined();
  });

  test("a pass needs every check ok", () => {
    expect(
      refused(
        draft({ change: { 2: { checks: [check("a"), check("b", false)] } } }),
      ),
    ).toBe("test 2 passed with a failed check");
  });

  test("a pass needs at least one check", () => {
    expect(refused(draft({ change: { 2: { checks: [] } } }))).toBe(
      "test 2 passed with no checks",
    );
  });

  test("a gated test cannot pass without its cap", () => {
    expect(
      refused(draft({ change: { 13: { status: "pass", fallback: null } } })),
    ).toBe("test 13 passed without outputSchema: it can only be N/A or fail");
  });

  test("a fail needs a failed check", () => {
    expect(refused(draft({ change: { 5: { status: "fail" } } }))).toBe(
      "test 5 failed with every check ok",
    );
  });

  test("tests are exactly 1–16, in order", () => {
    const d = draft();
    expect(refused({ ...d, tests: d.tests.slice(1) })).toMatch(
      /^tests must be 1–16 in order/,
    );
    expect(refused({ ...d, tests: d.tests.toReversed() })).toMatch(
      /^tests must be 1–16 in order/,
    );
  });

  test("with compression on, tests are exactly 1–17; off, 17 is not one of them", () => {
    const off = draft();
    const on = draft(ON);
    expect(on.tests.map((t) => t.id)).toEqual([...ALL_CONFORMANCE_TEST_IDS]);
    expect(certify(on).ok).toBe(true);
    expect(refused({ ...on, tests: off.tests })).toMatch(
      /^tests must be 1–17 in order with compression on/,
    );
    expect(refused({ ...off, tests: on.tests })).toMatch(
      /^tests must be 1–16 in order, got/,
    );
    expect(expectedTestIds(false)).toEqual(CONFORMANCE_TEST_IDS);
    expect(COMPRESSION_TEST_ID).toBe(17);
    expect(CONFORMANCE_TEST_NAMES[17]).toBe("context_compression");
  });

  test("the ruleset is a name, and nothing else rides along", () => {
    expect(refused(draft({ compression: { ruleset: "CTX 1" } }))).toMatch(
      /^not a conformance draft/,
    );
    expect(
      refused({ ...draft(ON), compression: { ruleset: "ctx1", x: 1 } }),
    ).toMatch(/^not a conformance draft/);
  });

  test("each test carries its §15 name", () => {
    expect(refused(draft({ change: { 7: { name: "interrupts" } } }))).toBe(
      "test 7 is named interrupts, not interrupt",
    );
  });

  test("finished_at cannot precede started_at", () => {
    expect(refused(draft({ finished_at: 999 }))).toBe(
      "finished_at is before started_at",
    );
  });

  test("anything not shaped like a draft is refused", () => {
    expect(refused("nope")).toMatch(/^not a conformance draft/);
    expect(
      refused(
        draft({
          change: {
            1: { checks: [{ name: "v", ok: true, detail: "x".repeat(201) }] },
          },
        }),
      ),
    ).toMatch(/^not a conformance draft/);
    expect(refused({ ...draft(), extra: 1 })).toMatch(
      /^not a conformance draft/,
    );
  });
});
