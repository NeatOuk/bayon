import type { Registration } from "@bayon/runners";
import { FIXTURE_CAPS, FIXTURE_RUNNER_ID } from "@bayon/runners/fixture";
import { expect, test } from "vitest";
import { chooseRunner } from "./runner.js";

const withDefaults = (defaults: Record<string, unknown>): Registration => ({
  models: [],
  runner: {
    id: "some-sdk",
    kind: "llm_sdk",
    adapter: "some-sdk",
    versionDetected: "1",
    caps: FIXTURE_CAPS,
    defaults,
  },
});
const sdk = withDefaults({ secretEnv: ["TEST_KEY"] });
// A one-of rule by name only (Invariant 1): KEY_A and TOKEN_B stand in for a runner's alternatives.
const oneOf = withDefaults({
  secretEnvAnyOf: [["KEY_A"], ["TOKEN_B"]],
  secretHints: { TOKEN_B: "run `some-cli mint-token`" },
});
const REAL = { FRM_REAL_RUNNER: "1" };
const message = (r: ReturnType<typeof chooseRunner>) =>
  r.ok ? null : r.error.message;

test("fixture needs nothing", () => {
  expect(chooseRunner("fixture", {}, [])).toEqual({
    ok: true,
    value: FIXTURE_RUNNER_ID,
  });
});

test("sdk fails fast without FRM_REAL_RUNNER=1, then without its secrets", () => {
  expect(message(chooseRunner("sdk", {}, [sdk]))).toMatch(/FRM_REAL_RUNNER=1/);
  expect(message(chooseRunner("sdk", REAL, [sdk]))).toBe(
    "--runner sdk needs TEST_KEY from the secret store: set FRM_SECRET_TEST_KEY",
  );
  expect(
    chooseRunner("sdk", { ...REAL, FRM_SECRET_TEST_KEY: "k" }, [sdk]),
  ).toEqual({ ok: true, value: "some-sdk" });
  expect(message(chooseRunner("sdk", REAL, []))).toMatch(/no llm_sdk runner/);
});

test.each([
  ["the first", { FRM_SECRET_KEY_A: "a" }],
  ["the second", { FRM_SECRET_TOKEN_B: "b" }],
  ["both", { FRM_SECRET_KEY_A: "a", FRM_SECRET_TOKEN_B: "b" }],
])("sdk accepts %s one-of alternative from FRM_SECRET_<NAME>", (_, env) => {
  expect(chooseRunner("sdk", { ...REAL, ...env }, [oneOf])).toEqual({
    ok: true,
    value: "some-sdk",
  });
});

test("with neither, sdk lists every alternative, how to get it, and the Keychain commands", () => {
  expect(message(chooseRunner("sdk", REAL, [oneOf]))).toBe(
    [
      "--runner sdk needs one of KEY_A | TOKEN_B from the secret store, first match wins",
      "  set FRM_SECRET_KEY_A",
      "  set FRM_SECRET_TOKEN_B: run `some-cli mint-token`",
      "  keep it in the Keychain: security add-generic-password -s foreman -a <NAME> -w",
      '  then: export FRM_SECRET_<NAME>="$(security find-generic-password -s foreman -a <NAME> -w)"',
    ].join("\n"),
  );
});

test("an alternative needs all its names, and required names come first", () => {
  const both = withDefaults({
    secretEnv: ["R"],
    secretEnvAnyOf: [["A", "B"], ["C"]],
  });
  expect(message(chooseRunner("sdk", REAL, [both]))).toBe(
    "--runner sdk needs R from the secret store: set FRM_SECRET_R",
  );
  const partial = { ...REAL, FRM_SECRET_R: "r", FRM_SECRET_A: "a" };
  expect(message(chooseRunner("sdk", partial, [both]))).toMatch(
    /^--runner sdk needs one of A \+ B \| C from the secret store/,
  );
  expect(
    chooseRunner("sdk", { ...partial, FRM_SECRET_B: "b" }, [both]),
  ).toMatchObject({ ok: true });
});

test("malformed runner defaults are refused, not read as needing nothing", () => {
  const bad = withDefaults({ secretEnvAnyOf: ["KEY_A"] });
  expect(message(chooseRunner("sdk", REAL, [bad]))).toMatch(
    /^--runner sdk: some-sdk defaults:/,
  );
});

test("the registered sdk adapter names the secrets it needs and how to store them", () => {
  const text = message(chooseRunner("sdk", REAL)) ?? "";
  expect(text).toMatch(
    /^--runner sdk needs one of \w+( \| \w+)+ from the secret store/,
  );
  expect(text).toMatch(/set FRM_SECRET_\w+: \S/);
  expect(text).toContain(
    "security add-generic-password -s foreman -a <NAME> -w",
  );
});
