import { describe, expect, test } from "vitest";
import {
  assertExecutorId,
  formatRef,
  mintToken,
  parseRef,
  shortContainerId,
} from "./ref.js";

const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return "accepted";
};

describe("container refs", () => {
  test("round-trip for a container and for the docker host", () => {
    const token = mintToken();
    expect(token).toMatch(/^[0-9a-f]{16}$/);
    expect(mintToken()).not.toBe(token);
    const ref = formatRef({
      executorId: "ctr-lab",
      container: "0123456789ab",
      token,
    });
    expect(ref).toBe(`ctr:ctr-lab:0123456789ab:${token}`);
    expect(parseRef(ref, "ctr-lab")).toEqual({
      executorId: "ctr-lab",
      container: "0123456789ab",
      token,
    });
    const host = formatRef({ executorId: "ctr-lab", container: null, token });
    expect(parseRef(host, "ctr-lab").container).toBeNull();
  });

  test.each([
    ["another executor's", "ctr:ctr-9:0123456789ab:0123456789abcdef"],
    ["a local", "local:123:456"],
    ["a truncated", "ctr:ctr-lab:0123456789ab:0123"],
    ["a named-container", "ctr:ctr-lab:frm-x:0123456789abcdef"],
  ])("refuses %s ref", (_what, ref) => {
    expect(refused(() => parseRef(ref, "ctr-lab"))).toMatchObject({
      class: "validation",
    });
  });

  test("executor ids and container ids are checked", () => {
    expect(assertExecutorId("ctr-lab")).toBe("ctr-lab");
    expect(refused(() => assertExecutorId("Ctr 172"))).toMatchObject({
      class: "validation",
    });
    expect(shortContainerId(`${"a".repeat(64)}\n`)).toBe("a".repeat(12));
    expect(
      refused(() => shortContainerId("Error: no such image")),
    ).toMatchObject({ class: "internal" });
  });
});
