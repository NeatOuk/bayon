// Which runners may be granted a login in place (§14): a registration fact read from a
// runner row's defaults. Anything but an explicit `true` is "cannot read one" — the safe reading.
import { expect, test } from "vitest";
import { READS_GRANTED_LOGIN, readsGrantedLogin } from "./login-in-place.js";

test("a runner reads a granted login only when its defaults say so, exactly", () => {
  expect(readsGrantedLogin({ [READS_GRANTED_LOGIN]: true })).toBe(true);
});

test.each([
  ["no defaults", undefined],
  ["null", null],
  ["an array", [true]],
  ["defaults that do not mention it", { secretEnvAnyOf: [["A"]] }],
  ["false", { [READS_GRANTED_LOGIN]: false }],
  ["a truthy string", { [READS_GRANTED_LOGIN]: "true" }],
  ["a truthy number", { [READS_GRANTED_LOGIN]: 1 }],
])("%s: it cannot", (_what, defaults) => {
  expect(readsGrantedLogin(defaults)).toBe(false);
});
