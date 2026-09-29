// Runner conformance (§15, M3 amendment a): what one run of the suite produces, and the one pure
// function that decides what it certifies. The suite in @bayon/runners builds a draft; `certify`
// validates it and recomputes its summary, never trusting a stored one. Certification is per
// (runner, executor): an earlier change stores only what `certify` returns, and only a `certifiable` one.
import { z } from "zod";
import { SINGLE_SESSION_CAP } from "./admission-gates.js";
import { err, ok, type Result } from "./errors.js";
import { EpochMs } from "./events/schema.js";
import { canonicalJson } from "./hash/canonical-json.js";
import { sha256Hex } from "./hash/hashes.js";
import { RunnerCaps } from "./runner-caps.js";

/** Bumped whenever a test's drive or judge changes: a stored certification then lapses. */
export const SUITE_VERSION = "2";

/** The base suite, 1–16: every run has exactly these, in order, and a run with compression off only these. */
export const CONFORMANCE_TEST_IDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
] as const;
/**
 * §15 #17 (spec M12): context compression. It runs only when the suite runs with compression on, and
 * a compression-on result has 1–17. Never N/A (no gating cap): support is the adapter's declaration,
 * and a runner that does not declare it on the executor is refused before any test runs.
 */
export const COMPRESSION_TEST_ID = 17;
/** Every test id a result may carry. */
export const ALL_CONFORMANCE_TEST_IDS = [
  ...CONFORMANCE_TEST_IDS,
  COMPRESSION_TEST_ID,
] as const;
export const ConformanceTestId = z.literal(ALL_CONFORMANCE_TEST_IDS);
export type ConformanceTestId = z.infer<typeof ConformanceTestId>;

/** The ids a result must carry, in order: 1–16, and 17 as well with compression on. */
export const expectedTestIds = (
  compression: boolean,
): readonly ConformanceTestId[] =>
  compression ? ALL_CONFORMANCE_TEST_IDS : CONFORMANCE_TEST_IDS;

/** §15 #1: version + health. The pins live here (certification-pins.ts re-exports it), because
 * `unattended_allowed` below needs it and that module already reads this one. */
export const VERSION_TEST_ID: ConformanceTestId = 1;

/** The §15 tests by number, as stored in `tests[].name`. */
export const CONFORMANCE_TEST_NAMES: Readonly<
  Record<ConformanceTestId, string>
> = {
  1: "version_health",
  2: "spawn_single_turn",
  3: "multi_turn",
  4: "tool_call_capture",
  5: "file_change_capture",
  6: "usage_capture",
  7: "interrupt",
  8: "kill_adopt",
  9: "no_terminal_event",
  10: "unknown_event",
  11: "mcp_round_trip",
  12: "permission_mapping",
  13: "review_output",
  14: "home_claim",
  15: "concurrent_home_isolation",
  16: "extra_workspace_roots",
  17: "context_compression",
};

/** A test's one gating cap: declared absent, it runs its fallback and may be N/A (amendment a). */
export const GATING_CAP: Readonly<
  Partial<Record<ConformanceTestId, keyof RunnerCaps>>
> = {
  3: "multiTurnInProcess",
  6: "costReporting",
  8: "resumable",
  11: "mcpClient",
  12: "toolApprovalCallback",
  13: "outputSchema",
  // Test 15 observes two live sessions, which a single-session credential cannot give it. The N/A
  // is sound because admission enforces the same cap (SINGLE_SESSION_CAP is that gate's own
  // constant, §15): what test 15 guards against cannot happen when two sessions cannot exist.
  15: SINGLE_SESSION_CAP,
};

/**
 * Tests whose N/A rests on the runner's own declared refusal rather than on a §5.1 capability
 * (§15 #16: "N/A when the runner declares it refuses extra roots rather than granting them" —
 * §5.1's matrix has no such capability, so the declaration lives in the kit and `kit_hash` pins
 * it). Such an N/A must still carry a fallback and at least one check, all holding: the fallback
 * branch verifies the refusal, so a kit cannot declare its way past the test.
 */
export const DECLARED_NA: readonly ConformanceTestId[] = [16];

/** Tests with neither a gating cap nor a declared refusal: never N/A. */
export const NEVER_NA: readonly ConformanceTestId[] =
  ALL_CONFORMANCE_TEST_IDS.filter(
    (id) => GATING_CAP[id] === undefined && !DECLARED_NA.includes(id),
  );

/**
 * Unattended work requires these **passed** (§15). Each can never be N/A (NEVER_NA), so there is
 * no third state to argue about: a certifiable run either passed them or it did not.
 */
export const NON_NEGOTIABLE_TESTS: readonly ConformanceTestId[] = [9, 10, 14];

/**
 * …and these **not failed** (§15): an N/A qualifies, a failure does not. A different rule because
 * these tests can legitimately be N/A — test 15 observes two live sessions, which a single-session
 * credential cannot give it, and admission enforces that limit instead (§5.1). Only a runner that
 * ran the test and contended on home state is refused. Before test 14 was split this half was
 * inside a non-negotiable test; keeping it out of the unattended rule would have given that away
 * by refactoring rather than by decision (§15, page v33).
 */
export const MUST_NOT_FAIL_TESTS: readonly ConformanceTestId[] = [15];

/** Caps no test verifies: the report shows them as "declared, unverified". */
export const UNVERIFIED_CAPS: readonly (keyof RunnerCaps)[] = [
  "hooks",
  "pty",
  "sandboxModes",
  "imageInput",
  "subagents",
];

export const MAX_DETAIL_CHARS = 200;

export const ConformanceStatus = z.enum(["pass", "fail", "na", "incomplete"]);
export type ConformanceStatus = z.infer<typeof ConformanceStatus>;

/** Who implemented a port: the suite's offline reference, or the supervisor's production one. */
export const PortSource = z.enum(["reference", "supervisor"]);
export type PortSource = z.infer<typeof PortSource>;

/** One named check. `detail` never holds payload text, env or a token. */
export const ConformanceCheck = z.strictObject({
  name: z.string().min(1),
  ok: z.boolean(),
  detail: z.string().max(MAX_DETAIL_CHARS).nullable(),
});
export type ConformanceCheck = z.infer<typeof ConformanceCheck>;

export const ConformanceTestResult = z.strictObject({
  id: ConformanceTestId,
  name: z.string().min(1),
  status: ConformanceStatus,
  attempts: z.int().nonnegative(),
  duration_ms: z.int().nonnegative(),
  /** Set only on `na`: the fallback that was verified instead. */
  fallback: z.string().min(1).nullable(),
  checks: z.array(ConformanceCheck),
});
export type ConformanceTestResult = z.infer<typeof ConformanceTestResult>;

const Ids = z.array(ConformanceTestId);

export const ConformanceSummary = z.strictObject({
  passed: Ids,
  failed: Ids,
  na: Ids,
  incomplete: Ids,
  unverified_caps: z.array(RunnerCaps.keyof()),
  /** Supervisor ports only, and nothing incomplete: both columns below depend on it. */
  certifiable: z.boolean(),
  gate_eligible: z.boolean(),
  /** `conformance_passed_at`: tests 1, 9, 10 and 14 passed and test 15 not failed on a certifiable
   * run, on a container executor the image the pair ran inside was identified, and with compression
   * on test 17 passed — see summarize(). */
  unattended_allowed: z.boolean(),
});
export type ConformanceSummary = z.infer<typeof ConformanceSummary>;

const count = z.int().nonnegative();
const name = z.string().min(1);
/** A run's context compression (spec M12): its ruleset, or null with compression off. */
const Compression = z
  .strictObject({ ruleset: z.string().regex(/^[a-z][a-z0-9]{0,15}$/) })
  .nullable();

const Body = z.strictObject({
  schema: z.literal(1),
  suite_version: name,
  runner_id: name,
  runner_version: name,
  /** The model the suite spawned: a certificate holds for this model alone. Null for a
   * result stored before certification was per model, which therefore matches no model's key. */
  model: name.nullable().default(null),
  executor: z.strictObject({
    id: name,
    kind: z.enum(["local", "container", "remote"]),
    /** The executor's image identity when it has one — a container's built image id.
     * A rebuild that changes it decertifies the pair, the way a changed runner version does: the
     * certified runner lives *inside* that image, so a new image is a new subject. Null where the
     * executor has no image (local), and defaulted for results stored before this was pinned.
     * A *container* result with none pins nothing at all, so it is never `unattended_allowed`
     * (summarize()). */
    image_id: name.nullable().default(null),
  }),
  started_at: EpochMs,
  finished_at: EpochMs,
  /** sha-256 of the kit's canonical JSON (§8.1). */
  kit_hash: name,
  /**
   * Context compression (spec M12): the ruleset the run compressed with, or null for a run with it
   * off. A certificate holds for one of the two; with it on, test 17 runs and must pass for unattended
   * work. Defaulted for results stored before compression existed, which all ran with it off.
   */
  compression: Compression.default(null),
  ports: z.strictObject({
    ingest: PortSource,
    watchdog: PortSource,
    mcp: PortSource,
    workspace: PortSource,
  }),
  caps: RunnerCaps,
  spend: z.strictObject({
    tokens_in: count,
    tokens_out: count,
    cost_usd: z.number().nonnegative(),
  }),
  tests: z.array(ConformanceTestResult),
});

/** What the suite hands `certify`: any summary it carries is ignored; no `compression` is off. */
export const ConformanceDraft = Body.extend({
  compression: Compression.optional(),
  summary: ConformanceSummary.optional(),
});
export type ConformanceDraft = z.infer<typeof ConformanceDraft>;

/** `runner_certifications.result_json`, per (runner, executor, model). */
export const ConformanceResult = Body.extend({ summary: ConformanceSummary });
export type ConformanceResult = z.infer<typeof ConformanceResult>;

type Body = z.infer<typeof Body>;

const sameIds = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** Why one test's status contradicts its checks, its cap or its fallback; undefined if it holds. */
function statusProblem(
  t: ConformanceTestResult,
  caps: RunnerCaps,
): string | undefined {
  const cap = GATING_CAP[t.id];
  const allOk = t.checks.every((c) => c.ok);
  const declared = DECLARED_NA.includes(t.id);
  switch (t.status) {
    case "na":
      if (cap === undefined && !declared)
        return `test ${t.id} can never be N/A`;
      if (cap !== undefined && caps[cap])
        return `test ${t.id} is N/A but ${cap} is declared`;
      if (t.fallback === null) return `test ${t.id} is N/A with no fallback`;
      if (declared && t.checks.length === 0)
        return `test ${t.id} is N/A with no checks`;
      return allOk ? undefined : `test ${t.id} is N/A with a failed check`;
    case "pass":
      if (cap !== undefined && !caps[cap])
        return `test ${t.id} passed without ${cap}: it can only be N/A or fail`;
      if (t.checks.length === 0) return `test ${t.id} passed with no checks`;
      return allOk ? undefined : `test ${t.id} passed with a failed check`;
    case "fail":
      return allOk ? `test ${t.id} failed with every check ok` : undefined;
    case "incomplete":
      return undefined;
  }
}

function problemOf(d: Body): string | undefined {
  if (d.finished_at < d.started_at) return "finished_at is before started_at";
  const ids = d.tests.map((t) => t.id);
  const expected = expectedTestIds(d.compression !== null);
  if (!sameIds(ids, expected)) {
    return `tests must be 1–${String(expected.length)} in order${d.compression === null ? "" : " with compression on"}, got [${ids.join(", ")}]`;
  }
  for (const t of d.tests) {
    if (t.name !== CONFORMANCE_TEST_NAMES[t.id])
      return `test ${t.id} is named ${t.name}, not ${CONFORMANCE_TEST_NAMES[t.id]}`;
    const problem = statusProblem(t, d.caps);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function summarize(d: Body): ConformanceSummary {
  const ids = (status: ConformanceStatus) =>
    d.tests.filter((t) => t.status === status).map((t) => t.id);
  const passed = ids("pass");
  const failed = ids("fail");
  const incomplete = ids("incomplete");
  const certifiable =
    Object.values(d.ports).every((p) => p === "supervisor") &&
    incomplete.length === 0;
  return {
    passed,
    failed,
    na: ids("na"),
    incomplete,
    unverified_caps: UNVERIFIED_CAPS.filter((cap) => d.caps[cap]),
    certifiable,
    gate_eligible:
      certifiable && d.caps.structuredEvents && failed.length === 0,
    // Test 1 joins §15's non-negotiable trio here, and not by being added to it, because it earns
    // its place differently. 9, 10 and 14 are what the spec refuses unattended work
    // without, and 15 is what it refuses a *failure* of — an N/A there is a runner whose
    // credential serves one session, which admission enforces (MUST_NOT_FAIL_TESTS).
    //
    // Test 1 is what *pins* the pair: its health check's detail is the version a later
    // health pass compares against, so a pair whose test 1 failed pins nothing and can never
    // lapse — it would hold its passed_at against any drift, forever. An unfalsifiable
    // certification is not one.
    //
    // On a container executor the image id is the pin, and the only one: the
    // health pass reads that version *inside a session*, which it does not open, so it compares no
    // version there — `PairObservation.health_version` is null by construction. A container result
    // with no image id therefore pins nothing whatever test 1 did, and `unattended_allowed` must
    // refuse it for exactly the reason it refuses a failed test 1. It is refused here rather than
    // lapsed later, so the refusal is in the one pure function the suite, the report, the stored
    // flags and `staleCertification` all read: a stored container certification with no image id
    // (every one made before) no longer matches the flags certify() derives from it, and
    // the next boot or registration decertifies it.
    unattended_allowed:
      certifiable &&
      passed.includes(VERSION_TEST_ID) &&
      (d.executor.kind !== "container" || d.executor.image_id !== null) &&
      // Two rules, kept apart on purpose: what must have passed, and what must not have failed.
      NON_NEGOTIABLE_TESTS.every((id) => passed.includes(id)) &&
      MUST_NOT_FAIL_TESTS.every((id) => !failed.includes(id)) &&
      // With compression on, what it certifies is compression: test 17 must have passed (spec M12).
      (d.compression === null || passed.includes(COMPRESSION_TEST_ID)),
  };
}

/**
 * Validates a draft and recomputes its summary. A draft whose statuses contradict their checks,
 * caps or fallbacks (an N/A on a never-N/A test, a pass with a failed check, …) is refused.
 */
export function certify(draft: unknown): Result<ConformanceResult> {
  const parsed = ConformanceDraft.safeParse(draft);
  if (!parsed.success) {
    return err({
      class: "validation",
      message: `not a conformance draft: ${z.prettifyError(parsed.error)}`,
      retryable: false,
    });
  }
  const { summary, compression, ...rest } = parsed.data;
  void summary; // a stored summary is never trusted: summarize() recomputes it
  const body: Body = { ...rest, compression: compression ?? null };
  const problem = problemOf(body);
  return problem === undefined
    ? ok({ ...body, summary: summarize(body) })
    : err({ class: "validation", message: problem, retryable: false });
}

/** What a stored certification is pinned to (§8.1): a change of any of them lapses it. */
export interface CertificationKey {
  /** The model string the suite ran, as registered now under the certificate's
   * models row: a registration that renames it lapses the certificate. */
  readonly model: string;
  readonly runner_version: string;
  readonly suite_version: string;
  readonly kit_hash: string;
  readonly caps_hash: string;
}

const KEY_FIELDS = [
  "model",
  "runner_version",
  "caps_hash",
  "kit_hash",
  "suite_version",
] as const satisfies readonly (keyof CertificationKey)[];

/** `sha256:` of the caps' canonical JSON: what a certification's caps_hash pins. */
export async function capsHash(caps: RunnerCaps): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(caps))}`;
}

/** What changed between a stored certification and the runner as registered now; null if nothing. */
export function certificationDrift(
  stored: CertificationKey,
  current: CertificationKey,
): string | null {
  const changed = KEY_FIELDS.filter((k) => stored[k] !== current[k]);
  return changed.length === 0
    ? null
    : changed.map((k) => `${k} ${stored[k]} → ${current[k]}`).join("; ");
}

/** A pair's flags, from certify()'s summary alone: `passed_at` means unattended allowed. */
export function certificationFlags(r: ConformanceResult): {
  readonly gate_eligible: boolean;
  readonly passed_at: number | null;
} {
  return {
    gate_eligible: r.summary.gate_eligible,
    passed_at: r.summary.unattended_allowed ? r.finished_at : null,
  };
}

/** A `runner_certifications` row as far as its staleness goes. */
export interface StoredCertification extends CertificationKey {
  readonly result_json: string;
  readonly gate_eligible: number;
  readonly passed_at: number | null;
}

/** A stored `result_json`, recomputed through certify(): text that is not JSON is refused like any
 * other shape certify() does not know. Every reader of a stored result comes through here, so none
 * of them trusts what was written. */
export function certifyStored(result_json: string): Result<ConformanceResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result_json) as unknown;
  } catch {
    parsed = undefined;
  }
  return certify(parsed);
}

/**
 * Why a stored certification no longer holds; null if it does. Nothing stored is trusted: the
 * key must match the runner as registered now, the stored result must still certify and carry
 * that key, and the stored flags must be exactly what certify() derives from it.
 */
export async function staleCertification(
  stored: StoredCertification,
  current: CertificationKey,
): Promise<string | null> {
  const drift = certificationDrift(stored, current);
  if (drift !== null) return drift;
  const result = certifyStored(stored.result_json);
  if (!result.ok)
    return `the stored result does not certify: ${result.error.message}`;
  const r = result.value;
  if (!r.summary.certifiable) return "the stored result is not certifiable";
  // A result stored before certification was per model names none: its kit hash pinned the model
  // it was earned on, which the key's kit_hash comparison above has already held to the row's.
  const own = certificationDrift(stored, {
    model: r.model ?? stored.model,
    runner_version: r.runner_version,
    suite_version: r.suite_version,
    kit_hash: r.kit_hash,
    caps_hash: await capsHash(r.caps),
  });
  if (own !== null) return `the stored result is for another key: ${own}`;
  const flags = certificationFlags(r);
  return stored.gate_eligible === (flags.gate_eligible ? 1 : 0) &&
    stored.passed_at === flags.passed_at
    ? null
    : "the stored flags disagree with the stored result";
}
