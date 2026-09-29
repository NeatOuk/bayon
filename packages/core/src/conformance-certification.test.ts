// What a stored certification is pinned to, and why it lapses: the key drift, the
// flags derived from certify() alone, and staleCertification, which trusts nothing stored.
import { describe, expect, test } from "vitest";
import {
  CONFORMANCE_TEST_IDS,
  CONFORMANCE_TEST_NAMES,
  SUITE_VERSION,
  capsHash,
  certificationDrift,
  certificationFlags,
  certify,
  staleCertification,
  type CertificationKey,
  type ConformanceDraft,
  type ConformanceResult,
  type ConformanceTestId,
  type ConformanceTestResult,
  type StoredCertification,
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

const failing: Partial<ConformanceTestResult> = {
  status: "fail",
  checks: [{ name: "x", ok: false, detail: null }],
};

function result(
  o: Partial<ConformanceDraft> & {
    readonly change?: Partial<
      Record<ConformanceTestId, Partial<ConformanceTestResult>>
    >;
  } = {},
): ConformanceResult {
  const { change = {}, ...rest } = o;
  const tests = CONFORMANCE_TEST_IDS.map((id): ConformanceTestResult => {
    const na = id === 12 || id === 13;
    return {
      id,
      name: CONFORMANCE_TEST_NAMES[id],
      status: na ? "na" : "pass",
      attempts: 1,
      duration_ms: 1,
      fallback: na ? "the fallback held" : null,
      checks: [{ name: "held", ok: true, detail: null }],
      ...change[id],
    };
  });
  const certified = certify({
    schema: 1,
    suite_version: SUITE_VERSION,
    runner_id: "fixture",
    runner_version: "1",
    model: "m-cheap",
    executor: { id: "local", kind: "local" },
    started_at: 1_000,
    finished_at: 2_000,
    kit_hash: "sha256:kit",
    ports: {
      ingest: "supervisor",
      watchdog: "supervisor",
      mcp: "supervisor",
      workspace: "supervisor",
    },
    caps: CAPS,
    spend: { tokens_in: 1, tokens_out: 1, cost_usd: 0 },
    tests,
    ...rest,
  });
  if (!certified.ok) throw new Error(certified.error.message);
  return certified.value;
}

async function keyOf(r: ConformanceResult): Promise<CertificationKey> {
  return {
    model: r.model ?? "none",
    runner_version: r.runner_version,
    suite_version: r.suite_version,
    kit_hash: r.kit_hash,
    caps_hash: await capsHash(r.caps),
  };
}

async function stored(
  r: ConformanceResult,
  o: Partial<StoredCertification> = {},
): Promise<StoredCertification> {
  const flags = certificationFlags(r);
  return {
    ...(await keyOf(r)),
    result_json: JSON.stringify(r),
    gate_eligible: flags.gate_eligible ? 1 : 0,
    passed_at: flags.passed_at,
    ...o,
  };
}

describe("the certification key", () => {
  test("capsHash is sha256 of the canonical caps: key order does not matter, a flipped cap does", async () => {
    const reordered = Object.fromEntries(
      Object.entries(CAPS).toReversed(),
    ) as RunnerCaps;
    expect(await capsHash(CAPS)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await capsHash(reordered)).toBe(await capsHash(CAPS));
    expect(await capsHash({ ...CAPS, hooks: true })).not.toBe(
      await capsHash(CAPS),
    );
  });

  test("certificationDrift names every changed field, in a fixed order", () => {
    const key: CertificationKey = {
      model: "m",
      runner_version: "1",
      suite_version: "1",
      kit_hash: "sha256:a",
      caps_hash: "sha256:c",
    };
    expect(certificationDrift(key, key)).toBeNull();
    expect(
      certificationDrift(key, {
        ...key,
        suite_version: "2",
        runner_version: "9",
      }),
    ).toBe("runner_version 1 → 9; suite_version 1 → 2");
    expect(certificationDrift(key, { ...key, kit_hash: "sha256:b" })).toBe(
      "kit_hash sha256:a → sha256:b",
    );
    expect(certificationDrift(key, { ...key, caps_hash: "sha256:d" })).toBe(
      "caps_hash sha256:c → sha256:d",
    );
    expect(certificationDrift(key, { ...key, model: "m2" })).toBe(
      "model m → m2",
    );
  });
});

describe("certificationFlags come from certify()'s summary alone", () => {
  test("a clean run: gate eligible, unattended from its finish", () => {
    expect(certificationFlags(result())).toEqual({
      gate_eligible: true,
      passed_at: 2_000,
    });
  });

  test("a failed non-negotiable test: neither", () => {
    expect(certificationFlags(result({ change: { 9: failing } }))).toEqual({
      gate_eligible: false,
      passed_at: null,
    });
  });

  test("any other failure: unattended still, never gate eligible", () => {
    expect(certificationFlags(result({ change: { 4: failing } }))).toEqual({
      gate_eligible: false,
      passed_at: 2_000,
    });
  });
});

describe("staleCertification trusts nothing stored", () => {
  test("a fresh certification holds", async () => {
    const r = result();
    expect(
      await staleCertification(await stored(r), await keyOf(r)),
    ).toBeNull();
  });

  test("a changed version, caps, kit or suite lapses it", async () => {
    const r = result();
    const key = await keyOf(r);
    const s = await stored(r);
    expect(await staleCertification(s, { ...key, runner_version: "2" })).toBe(
      "runner_version 1 → 2",
    );
    expect(
      await staleCertification(s, {
        ...key,
        caps_hash: await capsHash({ ...CAPS, hooks: true }),
      }),
    ).toMatch(/^caps_hash /);
    expect(
      await staleCertification(s, { ...key, kit_hash: "sha256:other" }),
    ).toMatch(/^kit_hash /);
    expect(await staleCertification(s, { ...key, suite_version: "99" })).toBe(
      "suite_version 2 → 99",
    );
    // The model registered under the certificate's row was renamed: a new subject.
    expect(await staleCertification(s, { ...key, model: "m-cheaper" })).toBe(
      "model m-cheap → m-cheaper",
    );
  });

  test("a result stored before certification was per model holds for the model its row names, its kit hash pinning it (spec v67)", async () => {
    const r = result();
    const key = await keyOf(r);
    const legacy = { ...r } as Partial<ConformanceResult>;
    delete legacy.model;
    const s = await stored(r, { result_json: JSON.stringify(legacy) });
    expect(await staleCertification(s, key)).toBeNull();
    // Another model's key hashes the kit with that model: a different kit_hash, so it lapses.
    expect(
      await staleCertification(s, {
        ...key,
        model: "m-opus",
        kit_hash: "sha256:kit-with-m-opus",
      }),
    ).toMatch(/^model m-cheap → m-opus; kit_hash /);
  });

  test("a row keyed to another model than its result's lapses", async () => {
    const r = result();
    const other = { ...(await keyOf(r)), model: "m-opus" };
    expect(await staleCertification(await stored(r, other), other)).toBe(
      "the stored result is for another key: model m-opus → m-cheap",
    );
  });

  test("a stored result that no longer certifies, or never could, lapses it", async () => {
    const r = result();
    const key = await keyOf(r);
    expect(
      await staleCertification(await stored(r, { result_json: "{" }), key),
    ).toMatch(/^the stored result does not certify: /);
    const reference = result({
      ports: {
        ingest: "reference",
        watchdog: "supervisor",
        mcp: "supervisor",
        workspace: "supervisor",
      },
    });
    expect(
      await staleCertification(await stored(reference), await keyOf(reference)),
    ).toBe("the stored result is not certifiable");
  });

  test("a row whose key is not its result's lapses", async () => {
    const r = result();
    const other = { ...(await keyOf(r)), runner_version: "2" };
    expect(await staleCertification(await stored(r, other), other)).toBe(
      "the stored result is for another key: runner_version 2 → 1",
    );
  });

  test("stored flags that are not what certify() derives lapse it", async () => {
    const r = result({ change: { 9: failing } });
    const key = await keyOf(r);
    const disagree = "the stored flags disagree with the stored result";
    expect(
      await staleCertification(await stored(r, { gate_eligible: 1 }), key),
    ).toBe(disagree);
    expect(
      await staleCertification(await stored(r, { passed_at: 2_000 }), key),
    ).toBe(disagree);
  });
});
