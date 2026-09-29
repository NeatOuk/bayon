import { describe, expect, test } from "vitest";
import { trustRefusal, type TrustCheck } from "./trust.js";

const check = (over: Partial<TrustCheck> = {}): TrustCheck => ({
  role: "builder",
  untrustedInput: false,
  untrustedRoles: ["investigator"],
  executorId: "local",
  trust: "trusted",
  ...over,
});

describe("the trust rule (rule 4)", () => {
  test("an investigator on a trusted executor is refused, with the reason", () => {
    expect(trustRefusal(check({ role: "investigator" }))).toBe(
      "role investigator is in executors.untrusted_roles: it needs a trust='untrusted' executor, and local is trusted",
    );
  });

  test("a spawn flagged untrusted_input on a trusted executor is refused", () => {
    expect(trustRefusal(check({ untrustedInput: true }))).toMatch(
      /^the spawn is flagged untrusted_input: it needs a trust='untrusted' executor/,
    );
  });

  test("an untrusted executor takes either", () => {
    for (const over of [{ role: "investigator" }, { untrustedInput: true }]) {
      expect(
        trustRefusal(
          check({ ...over, executorId: "ctr-lab", trust: "untrusted" }),
        ),
      ).toBeNull();
    }
  });

  test("any other role, unflagged, runs anywhere", () => {
    expect(trustRefusal(check())).toBeNull();
    expect(trustRefusal(check({ untrustedRoles: [] }))).toBeNull();
  });
});
