import { expect, test } from "vitest";
import { detailEntries } from "@/executors/detail-list";

test("nested objects flatten to dotted keys; lists join; null, booleans and empty lists read plainly", () => {
  expect(
    detailEntries({
      rtt_ms: 312,
      docker: null,
      image_present: true,
      failures: ["disk: 12 % free", "tunnel down"],
      reclaimed: [],
      ssh: { host: "10.0.0.2", port: 22 },
      limits: [{ cpu: 4 }],
    }),
  ).toEqual([
    ["rtt_ms", "312"],
    ["docker", "—"],
    ["image_present", "yes"],
    ["failures", "disk: 12 % free; tunnel down"],
    ["reclaimed", "none"],
    ["ssh.host", "10.0.0.2"],
    ["ssh.port", "22"],
    ["limits", '{"cpu":4}'],
  ]);
});

test("a value that is not an object reads as one entry; an empty object as none", () => {
  expect(detailEntries("ok")).toEqual([["value", "ok"]]);
  expect(detailEntries({})).toEqual([]);
});
