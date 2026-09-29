import { describe, expect, test } from "vitest";
import {
  GATING_CAP,
  MUST_NOT_FAIL_TESTS,
  NON_NEGOTIABLE_TESTS,
} from "./conformance.js";
import {
  ADMISSION_SETTING_KEYS,
  AdmissionGate,
  admissionRefused,
  admitEarly,
  admitSpawn,
  budgetBreach,
  mayStartTurn,
  inStormHold,
  readAdmissionSettings,
  retryStormHolds,
  retryStormUntil,
  SINGLE_SESSION_CAP,
  type AdmissionSettings,
  type BudgetFact,
  type SpawnFacts,
} from "./admission.js";

const NOW = Date.UTC(2026, 8, 14, 12);
const MIN = 60_000;

const SETTINGS: AdmissionSettings = {
  paused: false,
  requireCertified: true,
  diskMinFreePct: 10,
  recheckMs: 5_000,
  untrustedRoles: ["investigator"],
  retryStorm: { count: 3, windowMs: 10 * MIN, backoffMs: 15 * MIN },
};

const BASE: SpawnFacts = {
  now: NOW,
  settings: SETTINGS,
  executor: {
    id: "local",
    loaded: true,
    enabled: true,
    trust: "trusted",
    health: "healthy",
    freePct: 50,
    slots: 2,
    used: 0,
  },
  runner: {
    id: "r1",
    loaded: true,
    enabled: true,
    certified: true,
    compression: false,
    jobRunner: false,
    concurrentSessions: true,
    live: 0,
  },
  agent: { id: "a1", enabled: true, maxConcurrency: 1, admitted: 0 },
  model: "m-1",
  modelId: "r1.standard",
  tier: "standard",
  role: "builder",
  untrustedInput: false,
  tools: {
    profileId: "p1",
    roleTools: 17,
    mcpClient: true,
    mounted: 11,
    gateReviewer: false,
  },
  context: {
    runClass: "build",
    capTokens: 300_000,
    baselineTokens: 20_000,
    ownTools: true,
  },
  reviewer: false,
  project: { id: "P-A", paused: false },
  budgets: [],
  failures: [],
  mcpUnreachable: null,
};

const budget = (o: Partial<BudgetFact> = {}): BudgetFact => ({
  id: "b1",
  scope: "fleet",
  scope_ref: null,
  period: "day",
  cap_usd: 2,
  cap_tokens: null,
  on_breach: "pause_admission",
  spent_usd: 0,
  spent_tokens: 0,
  ...o,
});

/** Facts that fail exactly that gate, from any facts that pass it. */
const FAIL: Record<AdmissionGate, (f: SpawnFacts) => SpawnFacts> = {
  disabled: (f) => ({ ...f, executor: { ...f.executor, enabled: false } }),
  no_model: (f) => ({ ...f, model: null }),
  no_tools: (f) => ({ ...f, tools: { ...f.tools, mounted: 0 } }),
  context_baseline: (f) => ({
    ...f,
    context: { ...f.context, capTokens: 15_000 },
  }),
  trust: (f) => ({ ...f, role: "investigator" }),
  uncertified: (f) => ({ ...f, runner: { ...f.runner, certified: false } }),
  fleet_paused: (f) => ({ ...f, settings: { ...f.settings, paused: true } }),
  project_paused: (f) => ({ ...f, project: { id: "P-A", paused: true } }),
  budget: (f) => ({ ...f, budgets: [budget({ spent_usd: 2 })] }),
  disk: (f) => ({ ...f, executor: { ...f.executor, freePct: 5 } }),
  retry_storm: (f) => ({ ...f, failures: [NOW - 3, NOW - 2, NOW - 1] }),
  concurrency: (f) => ({ ...f, agent: { ...f.agent, admitted: 1 } }),
  runner_concurrency: (f) => ({
    ...f,
    runner: { ...f.runner, concurrentSessions: false, live: 1 },
  }),
  unhealthy: (f) => ({
    ...f,
    executor: { ...f.executor, health: "unhealthy" },
  }),
  slot: (f) => ({ ...f, executor: { ...f.executor, used: 2 } }),
};

const GATES = AdmissionGate.options;
const REFUSE = [
  "disabled",
  "no_model",
  "no_tools",
  "context_baseline",
  "trust",
  "uncertified",
] as const;
const TURN = ["fleet_paused", "project_paused", "budget"] as const;
const pairs = <T>(xs: readonly T[]): [T, T][] =>
  xs.flatMap((a, i) => xs.slice(i + 1).map((b): [T, T] => [a, b]));

describe("the table", () => {
  test("passing facts are admitted in every scope", () => {
    expect(admitEarly(BASE)).toEqual({ kind: "admit" });
    expect(admitSpawn(BASE)).toEqual({ kind: "admit" });
    expect(mayStartTurn(BASE, "run")).toEqual({ kind: "admit" });
  });

  test.each(GATES)(
    "%s alone decides the spawn, refused or queued by its kind",
    (gate) => {
      const v = admitSpawn(FAIL[gate](BASE));
      expect(v).toMatchObject({
        kind: (REFUSE as readonly string[]).includes(gate) ? "refuse" : "queue",
        gate,
      });
    },
  );

  test.each(pairs(GATES))("%s is reported before %s", (first, second) => {
    expect(admitSpawn(FAIL[second](FAIL[first](BASE)))).toMatchObject({
      gate: first,
    });
  });

  test.each(REFUSE)("early: %s refuses before the row exists", (gate) => {
    expect(admitEarly(FAIL[gate](BASE))).toMatchObject({
      kind: "refuse",
      gate,
    });
  });

  test.each(pairs(REFUSE))(
    "early: %s is reported before %s",
    (first, second) => {
      expect(admitEarly(FAIL[second](FAIL[first](BASE)))).toMatchObject({
        gate: first,
      });
    },
  );

  test.each(GATES.filter((g) => !(REFUSE as readonly string[]).includes(g)))(
    "early never decides %s: it never queues",
    (gate) => {
      expect(admitEarly(FAIL[gate](BASE))).toEqual({ kind: "admit" });
    },
  );
});

describe("context_baseline", () => {
  const low = FAIL.context_baseline(BASE);

  test("names the run class, its cap, the runner and its baseline; never retryable", () => {
    const v = admitEarly(low);
    expect(v).toEqual({
      kind: "refuse",
      gate: "context_baseline",
      detail:
        "run class build's context_tokens_cap 15000 is below runner r1's session baseline of 20000 tokens (sessionBaselineTokens), so a session could not start in it: raise the cap (frm config apply run_classes) or staff another runner",
    });
    expect(v.kind !== "admit" && admissionRefused(v)).toMatchObject({
      class: "admission_refused",
      retryable: false,
      cause: { gate: "context_baseline" },
    });
  });

  const passing: {
    readonly why: string;
    readonly context: Partial<SpawnFacts["context"]>;
  }[] = [
    { why: "a cap of 0 (n/a)", context: { capTokens: 0 } },
    { why: "a cap equal to the baseline", context: { capTokens: 20_000 } },
    {
      why: "a runner that declares no baseline",
      context: { baselineTokens: 0 },
    },
    {
      why: "an MCP-only session (the pulse), which withholds the runner's own tools,",
      context: { ownTools: false },
    },
  ];
  test.each(passing)("$why is admitted", ({ context }) => {
    expect(
      admitEarly({ ...low, context: { ...low.context, ...context } }),
    ).toEqual({ kind: "admit" });
  });
});

describe("no_tools", () => {
  const none = FAIL.no_tools(BASE);

  test("names the agent and the profile, and says it could not write back; never retryable", () => {
    const v = admitEarly(none);
    expect(v).toEqual({
      kind: "refuse",
      gate: "no_tools",
      detail:
        "agent a1: profile p1 allows none of role builder's 17 MCP tools (tool_allowlist_json), so the session could not write back: no accept, no plan, no hand-off",
    });
    expect(v.kind !== "admit" && admissionRefused(v)).toMatchObject({
      class: "admission_refused",
      retryable: false,
      cause: { gate: "no_tools" },
    });
  });

  test("a runner with no MCP client is not this gate: it mounts nothing by design", () => {
    expect(
      admitEarly({ ...none, tools: { ...none.tools, mcpClient: false } }),
    ).toEqual({ kind: "admit" });
  });

  test("a gate's reviewer is not this gate: its verdict is its output file, not an MCP call", () => {
    expect(
      admitEarly({
        ...none,
        role: "reviewer",
        tools: { ...none.tools, gateReviewer: true },
      }),
    ).toEqual({ kind: "admit" });
  });

  test("a role with no catalogue row (no work role) is not this gate", () => {
    expect(
      admitEarly({
        ...none,
        role: "util",
        tools: { ...none.tools, roleTools: 0 },
      }),
    ).toEqual({ kind: "admit" });
  });
});

describe("mayStartTurn", () => {
  test.each(TURN)("a run is refused by %s, retryable", (gate) => {
    const v = mayStartTurn(FAIL[gate](BASE), "run");
    expect(v).toMatchObject({ kind: "queue", gate });
    expect(v.kind !== "admit" && admissionRefused(v).retryable).toBe(true);
  });

  test.each(pairs(TURN))("%s is reported before %s", (first, second) => {
    expect(mayStartTurn(FAIL[second](FAIL[first](BASE)), "run")).toMatchObject({
      gate: first,
    });
  });

  test.each(GATES.filter((g) => !(TURN as readonly string[]).includes(g)))(
    "%s never refuses a turn",
    (gate) => {
      expect(mayStartTurn(FAIL[gate](BASE), "run")).toEqual({ kind: "admit" });
    },
  );

  test.each(["first", "handoff"] as const)(
    "a %s run is never checked",
    (kind) => {
      const held = FAIL.budget(FAIL.project_paused(FAIL.fleet_paused(BASE)));
      expect(mayStartTurn(held, kind)).toEqual({ kind: "admit" });
    },
  );
});

describe("project_paused", () => {
  const held = FAIL.project_paused(BASE);

  test("queues a spawn and holds a run, naming the project; retryable", () => {
    const detail = "project P-A is paused (workspaces.paused=1)";
    for (const v of [admitSpawn(held), mayStartTurn(held, "run")]) {
      expect(v).toEqual({ kind: "queue", gate: "project_paused", detail });
      expect(v.kind !== "admit" && admissionRefused(v)).toMatchObject({
        class: "admission_refused",
        retryable: true,
        cause: { gate: "project_paused" },
      });
    }
  });

  test("is not an early gate: the row is made, then it waits", () => {
    expect(admitEarly(held)).toEqual({ kind: "admit" });
  });

  test("fleet work (no project) is never held by it", () => {
    expect(admitSpawn({ ...BASE, project: null })).toEqual({ kind: "admit" });
    expect(mayStartTurn({ ...BASE, project: null }, "run")).toEqual({
      kind: "admit",
    });
  });

  test("the fleet's pause is reported first; it is reported before every later gate", () => {
    expect(admitSpawn(FAIL.fleet_paused(held))).toMatchObject({
      gate: "fleet_paused",
    });
    const later = GATES.slice(GATES.indexOf("project_paused") + 1);
    expect(later).toContain("budget");
    for (const gate of later) {
      expect(admitSpawn(FAIL[gate](held))).toMatchObject({
        kind: "queue",
        gate: "project_paused",
      });
    }
  });
});

describe("each gate's facts", () => {
  test.each([
    [
      { executor: { ...BASE.executor, loaded: false } },
      "executor local is not loaded",
    ],
    [
      { executor: { ...BASE.executor, enabled: false } },
      "executor local is disabled",
    ],
    [
      { runner: { ...BASE.runner, loaded: false } },
      "no adapter is loaded for runner r1",
    ],
    [{ runner: { ...BASE.runner, enabled: false } }, "runner r1 is disabled"],
    [{ agent: { ...BASE.agent, enabled: false } }, "agent a1 is disabled"],
    [
      { agent: { ...BASE.agent, maxConcurrency: 0 } },
      "agent a1 has max_concurrency 0",
    ],
  ] as const)("disabled: %j", (patch, detail) => {
    expect(admitSpawn({ ...BASE, ...patch })).toEqual({
      kind: "refuse",
      gate: "disabled",
      detail,
    });
  });

  test("no_model names the tier and the runner", () => {
    expect(admitEarly({ ...BASE, model: null })).toMatchObject({
      detail: "no active standard model of runner r1",
    });
  });

  test("no_model refuses an unpriced model, early and at spawn; a priced one (0 too) passes", () => {
    for (const admit of [admitEarly, admitSpawn]) {
      expect(admit({ ...BASE, modelUnpriced: true })).toMatchObject({
        kind: "refuse",
        gate: "no_model",
        detail: expect.stringContaining("is unpriced") as unknown,
      });
      expect(admit({ ...BASE, modelUnpriced: false })).toEqual(admit(BASE));
    }
  });

  test("trust: untrusted_input needs an untrusted executor, which passes", () => {
    expect(admitEarly({ ...BASE, untrustedInput: true })).toMatchObject({
      gate: "trust",
    });
    expect(
      admitEarly({
        ...BASE,
        role: "investigator",
        executor: { ...BASE.executor, trust: "untrusted" },
      }),
    ).toEqual({ kind: "admit" });
  });

  test("uncertified: a job runner, or require_certified=0, passes", () => {
    const bare = FAIL.uncertified(BASE);
    expect(admitEarly(bare)).toMatchObject({
      detail:
        "runner r1 with model m-1 is not certified on executor local (admission.require_certified=1): certify it with frm runner conformance r1 --model r1.standard --executor local",
    });
    // Compressed (spec M12): the certificate it lacks is the compression-on one, and the command
    // that earns it says so.
    expect(
      admitEarly({ ...bare, runner: { ...bare.runner, compression: true } }),
    ).toMatchObject({
      kind: "refuse",
      gate: "uncertified",
      detail:
        "runner r1 with model m-1 is not certified with context compression on executor local (admission.require_certified=1): certify it with frm runner conformance r1 --model r1.standard --executor local --compression",
    });
    // No models row to name (a caller that has none): the placeholder, as before.
    expect(admitEarly({ ...bare, modelId: null })).toMatchObject({
      detail: expect.stringContaining("--model <id> --executor local"),
    });
    expect(
      admitEarly({ ...bare, runner: { ...bare.runner, jobRunner: true } }),
    ).toEqual({ kind: "admit" });
    expect(
      admitEarly({
        ...bare,
        settings: { ...SETTINGS, requireCertified: false },
      }),
    ).toEqual({ kind: "admit" });
  });

  test("disk: no measurement passes, and so does exactly the minimum", () => {
    const at = (freePct: number | null) =>
      admitSpawn({ ...BASE, executor: { ...BASE.executor, freePct } });
    expect(at(null)).toEqual({ kind: "admit" });
    expect(at(10)).toEqual({ kind: "admit" });
    expect(at(9.9)).toMatchObject({
      gate: "disk",
      detail:
        "executor local has 9.9 % disk free, under admission.disk_min_free_pct 10",
    });
  });

  test("retry_storm names the pair and when admission reopens", () => {
    expect(admitSpawn(FAIL.retry_storm(BASE))).toMatchObject({
      gate: "retry_storm",
      detail: `runner r1 on executor local: 3 runner_error failures within 600000 ms; admission reopens at ${new Date(NOW - 1 + 15 * MIN).toISOString()}`,
    });
  });

  test("concurrency: a reviewer is exempt, but not from slot", () => {
    const busy = FAIL.concurrency(BASE);
    expect(admitSpawn(busy)).toMatchObject({
      gate: "concurrency",
      detail: "agent a1 runs 1 of max_concurrency 1",
    });
    expect(admitSpawn({ ...busy, reviewer: true })).toEqual({ kind: "admit" });
    expect(admitSpawn(FAIL.slot({ ...busy, reviewer: true }))).toMatchObject({
      gate: "slot",
    });
  });

  test("unhealthy: an unknown executor, or an MCP that does not answer", () => {
    expect(
      admitSpawn({
        ...BASE,
        executor: { ...BASE.executor, health: "unknown" },
      }),
    ).toMatchObject({ gate: "unhealthy", detail: "executor local is unknown" });
    expect(
      admitSpawn({ ...BASE, mcpUnreachable: "http://127.0.0.1:1/mcp" }),
    ).toMatchObject({
      gate: "unhealthy",
      detail: "mcp http://127.0.0.1:1/mcp does not answer",
    });
  });

  test("slot: 0 slots drains, visibly queued", () => {
    expect(
      admitSpawn({ ...BASE, executor: { ...BASE.executor, slots: 0 } }),
    ).toEqual({
      kind: "queue",
      gate: "slot",
      detail: "no slot on local: 0 of 0 held",
    });
  });
});

describe("retryStormUntil", () => {
  const c = SETTINGS.retryStorm;

  test("fewer failures than the count never hold", () => {
    expect(retryStormUntil([NOW - 2, NOW - 1], NOW, c)).toBeNull();
    expect(retryStormUntil([], NOW, c)).toBeNull();
  });

  test("the count within the window holds until the last one plus the backoff, edge included", () => {
    const burst = [NOW - 10 * MIN, NOW - 5 * MIN, NOW];
    expect(retryStormUntil(burst, NOW, c)).toBe(NOW + 15 * MIN);
    expect(retryStormUntil(burst.toReversed(), NOW, c)).toBe(NOW + 15 * MIN);
  });

  test("the count spread wider than the window never holds", () => {
    expect(
      retryStormUntil([NOW - 10 * MIN - 1, NOW - 5 * MIN, NOW], NOW, c),
    ).toBeNull();
  });

  test("a hold ends at its time; the latest burst wins", () => {
    const old = [NOW - 40 * MIN, NOW - 39 * MIN, NOW - 38 * MIN];
    expect(retryStormUntil(old, NOW, c)).toBeNull();
    expect(retryStormUntil(old, NOW - 30 * MIN, c)).toBe(NOW - 23 * MIN);
    const late = [...old, NOW - 3, NOW - 2, NOW - 1];
    expect(retryStormUntil(late, NOW, c)).toBe(NOW - 1 + 15 * MIN);
  });
});

// Holds as history: every burst, with no `now`, so the breaker can exclude
// a storm's failures long after its hold lapsed.
describe("retryStormHolds", () => {
  const c = SETTINGS.retryStorm;

  test("every burst is listed, oldest first, with its first failure, trigger and end", () => {
    const old = [NOW - 40 * MIN, NOW - 39 * MIN, NOW - 38 * MIN];
    const late = [NOW - 3, NOW - 2, NOW - 1];
    expect(retryStormHolds([...late, ...old], c)).toEqual([
      {
        burstStart: NOW - 40 * MIN,
        triggeredAt: NOW - 38 * MIN,
        until: NOW - 23 * MIN,
      },
      { burstStart: NOW - 3, triggeredAt: NOW - 1, until: NOW - 1 + 15 * MIN },
    ]);
  });

  test("overlapping bursts each give a hold; fewer than the count give none", () => {
    const four = [NOW, NOW + 1, NOW + 2, NOW + 3];
    expect(retryStormHolds(four, c).map((h) => h.triggeredAt)).toEqual([
      NOW + 2,
      NOW + 3,
    ]);
    expect(retryStormHolds(four.slice(0, 2), c)).toEqual([]);
  });

  test("it never depends on now, and retryStormUntil reads its latest hold", () => {
    const burst = [NOW - 10 * MIN, NOW - 5 * MIN, NOW];
    const [hold] = retryStormHolds(burst, c);
    expect(hold?.until).toBe(retryStormUntil(burst, NOW, c));
    expect(retryStormUntil(burst, NOW + 16 * MIN, c)).toBeNull();
    expect(retryStormHolds(burst, c)).toHaveLength(1);
  });

  test("inStormHold spans the burst's first failure to the hold's end", () => {
    const holds = retryStormHolds([NOW - 10 * MIN, NOW - 5 * MIN, NOW], c);
    expect(inStormHold(NOW - 10 * MIN, holds)).toBe(true);
    expect(inStormHold(NOW + 15 * MIN, holds)).toBe(true);
    expect(inStormHold(NOW - 10 * MIN - 1, holds)).toBe(false);
    expect(inStormHold(NOW + 15 * MIN + 1, holds)).toBe(false);
  });
});

describe("budgetBreach", () => {
  test("warn never holds; pause_admission at its cap does", () => {
    expect(
      budgetBreach([budget({ spent_usd: 5, on_breach: "warn" })], "a1"),
    ).toBeNull();
    expect(budgetBreach([budget({ spent_usd: 1.99 })], "a1")).toBeNull();
    expect(budgetBreach([budget({ spent_usd: 2 })], "a1")).toMatchObject({
      detail: "$2.00 of $2.00",
    });
  });

  test("another agent's budget is ignored; its own holds", () => {
    const own = budget({
      id: "b2",
      scope: "agent",
      scope_ref: "a1",
      spent_usd: 3,
    });
    expect(budgetBreach([{ ...own, scope_ref: "a2" }], "a1")).toBeNull();
    expect(budgetBreach([own], "a1")).toMatchObject({ budget: { id: "b2" } });
  });

  test("a token cap holds; null caps never do", () => {
    expect(
      budgetBreach(
        [budget({ cap_usd: null, cap_tokens: 100, spent_tokens: 100 })],
        "a1",
      ),
    ).toMatchObject({ detail: "100 of 100 tokens" });
    expect(
      budgetBreach(
        [
          budget({
            cap_usd: 5,
            cap_tokens: 100,
            spent_usd: 1,
            spent_tokens: 99,
          }),
        ],
        "a1",
      ),
    ).toBeNull();
    expect(
      budgetBreach([budget({ cap_usd: null, spent_usd: 9 })], "a1"),
    ).toBeNull();
  });

  test("the gate's detail names the budget", () => {
    expect(admitSpawn(FAIL.budget(BASE))).toMatchObject({
      gate: "budget",
      detail: "budget fleet/day b1: $2.00 of $2.00",
    });
  });
});

describe("admissionRefused", () => {
  test("a refuse gate is not retryable; the cause carries the gate", () => {
    expect(
      admissionRefused({ kind: "refuse", gate: "trust", detail: "why" }),
    ).toEqual({
      class: "admission_refused",
      message: "refused (trust): why",
      retryable: false,
      cause: { gate: "trust", detail: "why" },
    });
  });

  test("a queue gate is retryable", () => {
    expect(
      admissionRefused({ kind: "queue", gate: "fleet_paused", detail: "x" }),
    ).toMatchObject({ retryable: true, cause: { gate: "fleet_paused" } });
  });
});

describe("readAdmissionSettings", () => {
  const rows = (o: Record<string, unknown> = {}) =>
    new Map<string, unknown>(
      Object.entries({
        [ADMISSION_SETTING_KEYS.paused]: 0,
        [ADMISSION_SETTING_KEYS.requireCertified]: true,
        [ADMISSION_SETTING_KEYS.diskMinFreePct]: 10,
        [ADMISSION_SETTING_KEYS.recheckMs]: 5000,
        [ADMISSION_SETTING_KEYS.untrustedRoles]: ["investigator"],
        [ADMISSION_SETTING_KEYS.stormCount]: 5,
        [ADMISSION_SETTING_KEYS.stormWindowMs]: 600000,
        [ADMISSION_SETTING_KEYS.stormBackoffMs]: 900000,
        ...o,
      }),
    );

  test("012's rows parse, flags from 0/1 or booleans", () => {
    expect(readAdmissionSettings(rows({ "fleet.paused": 1 }))).toEqual({
      ok: true,
      value: {
        paused: true,
        requireCertified: true,
        diskMinFreePct: 10,
        recheckMs: 5000,
        untrustedRoles: ["investigator"],
        retryStorm: { count: 5, windowMs: 600000, backoffMs: 900000 },
      },
    });
  });

  test("a missing or malformed row is a config error, never a default", () => {
    const missing = rows();
    missing.delete(ADMISSION_SETTING_KEYS.recheckMs);
    expect(readAdmissionSettings(missing)).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    expect(readAdmissionSettings(rows({ "fleet.paused": 2 }))).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });
});

// §5.1 concurrentSessions: a credential that serves one session at a time.
describe("runner_concurrency", () => {
  const live = (n: number, concurrentSessions = false): SpawnFacts => ({
    ...BASE,
    runner: { ...BASE.runner, concurrentSessions, live: n },
  });

  test("the second session waits: queued and retryable, never a spawn error", () => {
    const v = admitSpawn(live(1));
    expect(v).toEqual({
      kind: "queue",
      gate: "runner_concurrency",
      detail:
        "runner r1 serves one session at a time (concurrentSessions=false) and runs 1",
    });
    expect(v.kind !== "admit" && admissionRefused(v)).toMatchObject({
      class: "admission_refused",
      retryable: true,
      cause: { gate: "runner_concurrency" },
    });
  });

  test("the first is admitted: the cap limits the runner to one session, it does not disable it", () => {
    expect(admitSpawn(live(0))).toEqual({ kind: "admit" });
  });

  test("a runner that declares the cap is never held here, however many it runs", () => {
    expect(admitSpawn(live(3, true))).toEqual({ kind: "admit" });
  });

  test("conformance test 15 is gated on the cap this gate enforces (§15)", () => {
    // One constant, read from both ends: the N/A of test 15 is honest only because a runner that
    // declares the cap absent is serialised here. Drop the gate row and the test above fails.
    expect(GATING_CAP[15]).toBe(SINGLE_SESSION_CAP);
    expect(admitSpawn(live(1))).toMatchObject({ gate: "runner_concurrency" });
    // The claim half of the old test 14 keeps its place: one session is all it ever needed, so it
    // must have *passed*. Test 15 may be N/A, so §15 asks only that it did not fail.
    expect(NON_NEGOTIABLE_TESTS).toContain(14);
    expect(NON_NEGOTIABLE_TESTS).not.toContain(15);
    expect(MUST_NOT_FAIL_TESTS).toEqual([15]);
    expect(GATING_CAP[14]).toBeUndefined();
  });
});
