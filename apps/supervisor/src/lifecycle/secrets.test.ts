import { expect, test } from "vitest";
import {
  envSecrets,
  firstOf,
  keychainSecrets,
  resolveSecrets,
} from "./secrets.js";

test("envSecrets reads FRM_SECRET_<NAME>; a miss names the secret, never a value", async () => {
  const store = envSecrets({ FRM_SECRET_API_KEY: "s3cret" });
  expect(await store.get("API_KEY")).toEqual({ ok: true, value: "s3cret" });
  const missing = await store.get("OTHER");
  expect(missing).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(JSON.stringify(missing)).toContain("OTHER");
  expect(JSON.stringify(missing)).not.toContain("s3cret");
});

test("firstOf takes the first store that has the secret", async () => {
  const store = firstOf(envSecrets({}), envSecrets({ FRM_SECRET_A: "2" }));
  expect(await store.get("A")).toEqual({ ok: true, value: "2" });
  expect(await store.get("B")).toMatchObject({ ok: false });
});

test("keychainSecrets reports an absent entry, or no keychain at all, as missing", async () => {
  const store = keychainSecrets("frm-test-no-such-service");
  expect(await store.get("NOPE")).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

// A one-of rule by name only (Invariant 1): KEY_A and TOKEN_B stand in for a runner's alternatives.
const ONE_OF = [["KEY_A"], ["TOKEN_B"]];

test.each([
  ["the first alternative", { FRM_SECRET_KEY_A: "a" }, [["KEY_A", "a"]]],
  ["the second alternative", { FRM_SECRET_TOKEN_B: "b" }, [["TOKEN_B", "b"]]],
  [
    "both: the declared order wins, and only it is injected",
    { FRM_SECRET_KEY_A: "a", FRM_SECRET_TOKEN_B: "b" },
    [["KEY_A", "a"]],
  ],
])("resolveSecrets with %s", async (_, env, want) => {
  expect(await resolveSecrets(envSecrets(env), [], ONE_OF)).toEqual({
    ok: true,
    value: want,
  });
});

test("resolveSecrets with neither fails naming every alternative, never a value", async () => {
  const none = await resolveSecrets(
    envSecrets({ FRM_SECRET_OTHER: "s3cret" }),
    ["OTHER"],
    ONE_OF,
  );
  expect(none).toMatchObject({
    ok: false,
    error: { class: "validation", retryable: false },
  });
  const why = none.ok ? "" : none.error.message;
  expect(why).toContain(
    "none of the secrets KEY_A | TOKEN_B is in the secret store",
  );
  // The other door (§14), named because a stale copy and no copy look alike here.
  expect(why).toContain("runners.login_in_place");
  expect(JSON.stringify(none)).not.toContain("s3cret");
});

test("resolveSecrets needs every required name, and a whole alternative", async () => {
  const store = envSecrets({
    FRM_SECRET_A: "1",
    FRM_SECRET_C: "3",
    FRM_SECRET_R: "r",
  });
  expect(await resolveSecrets(store, ["R"], [["A", "B"], ["C"]])).toEqual({
    ok: true,
    value: [
      ["R", "r"],
      ["C", "3"],
    ],
  });
  expect(await resolveSecrets(store, ["R"], [["A", "B"]])).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining(
        "none of the secrets A + B is in the secret store",
      ),
    },
  });
  expect(await resolveSecrets(store, ["MISSING"], [["C"]])).toMatchObject({
    ok: false,
    error: { message: "secret MISSING is not in the secret store" },
  });
  expect(await resolveSecrets(store, ["R"], [])).toEqual({
    ok: true,
    value: [["R", "r"]],
  });
});
