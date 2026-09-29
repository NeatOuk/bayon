import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keychainScope } from "@bayon/executors";
import {
  installFakeSecurity,
  type FakeSecurity,
} from "@bayon/executors/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { apiEnvOf, apiTokenOf } from "./api-access.js";
import { homeEnvOf } from "./home.js";

// Which home's bearer frm reads (M3): the default home's only once homeEnvOf named it explicitly;
// a bare env that names no home never reads a stored bearer at all.

const TOKEN = "b".repeat(64);
let root: string;
let kc: FakeSecurity;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "frm-api-access-"));
  kc = installFakeSecurity(join(root, "kc"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const storeFor = (home: string) => {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(kc.kc, `${keychainScope({ FRM_HOME: home }).service}.FRM_API_TOKEN`),
    TOKEN,
  );
};

describe("apiEnvOf and the stored bearer", () => {
  test("the default home, resolved by homeEnvOf: FRM_HOME is named, so its bearer is read", async () => {
    const owner = join(root, "dot-foreman");
    storeFor(owner);
    const env = apiEnvOf({}, () =>
      homeEnvOf({}, { guard: {}, defaultHome: () => owner }),
    );
    expect(env.FRM_HOME).toBe(owner);
    expect(await apiTokenOf(env, { bin: kc.bin })).toEqual({
      ok: true,
      value: TOKEN,
    });
  });

  test("a bare env with no home resolver: nothing is read, not even the default home's", async () => {
    expect(await apiTokenOf(apiEnvOf({}, undefined), { bin: kc.bin })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(readFileSync(kc.argv, "utf8")).toBe("");
  });

  test("the default home refused (FRM_NO_DEFAULT_HOME): nothing is read", async () => {
    const env = apiEnvOf({}, () =>
      homeEnvOf({}, { guard: { FRM_NO_DEFAULT_HOME: "1" } }),
    );
    expect(await apiTokenOf(env, { bin: kc.bin })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(readFileSync(kc.argv, "utf8")).toBe("");
  });

  test("an env that names a token, a home or an API never resolves the default home", () => {
    for (const env of [
      { FRM_API_TOKEN: "t" },
      { FRM_HOME: "/h" },
      { FRM_DB: "/h/foreman.db" },
      { FRM_API_URL: "http://api:3010" },
    ]) {
      let asked = false;
      expect(
        apiEnvOf(env, () => {
          asked = true;
          return { ok: true, value: { env: {}, defaulted: null } };
        }),
      ).toBe(env);
      expect(asked).toBe(false);
    }
  });
});
