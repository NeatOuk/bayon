// The default home: `~/.foreman` when neither FRM_HOME nor FRM_DB is set, env first, and never
// the real one from a test (the guard).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { NO_DEFAULT_HOME_ENV, homeEnvOf, shownHome } from "./home.js";

const HOME = "/Users/op/.foreman";
const opts = { defaultHome: () => HOME, guard: {} };

describe("homeEnvOf", () => {
  test("neither set: FRM_HOME defaults to the account's ~/.foreman, and says so", () => {
    expect(homeEnvOf({ PATH: "/bin" }, opts)).toEqual({
      ok: true,
      value: { env: { PATH: "/bin", FRM_HOME: HOME }, defaulted: HOME },
    });
  });

  test("an empty FRM_HOME counts as unset", () => {
    const got = homeEnvOf({ FRM_HOME: "" }, opts);
    expect(got.ok && got.value.defaulted).toBe(HOME);
  });

  test("FRM_HOME wins over the default", () => {
    expect(homeEnvOf({ FRM_HOME: "/srv/frm" }, opts)).toEqual({
      ok: true,
      value: { env: { FRM_HOME: "/srv/frm" }, defaulted: null },
    });
  });

  test("FRM_DB alone wins too: no FRM_HOME is invented beside it", () => {
    expect(homeEnvOf({ FRM_DB: "/srv/frm/foreman.db" }, opts)).toEqual({
      ok: true,
      value: { env: { FRM_DB: "/srv/frm/foreman.db" }, defaulted: null },
    });
  });

  test("the guard refuses the default, naming what to set", () => {
    // Set in the process (vitest.setup.ts, frm smoke)…
    const inProcess = homeEnvOf(
      {},
      { defaultHome: () => HOME, guard: { [NO_DEFAULT_HOME_ENV]: "1" } },
    );
    expect(!inProcess.ok && inProcess.error.message).toMatch(
      /set FRM_HOME \(or FRM_DB\)/,
    );
    // …or in the env the command runs with.
    const inEnv = homeEnvOf({ [NO_DEFAULT_HOME_ENV]: "1" }, opts);
    expect(inEnv.ok).toBe(false);
  });

  test("the guard leaves an explicit home alone", () => {
    const got = homeEnvOf(
      { FRM_HOME: "/tmp/h" },
      { defaultHome: () => HOME, guard: { [NO_DEFAULT_HOME_ENV]: "1" } },
    );
    expect(got.ok).toBe(true);
  });
});

test("shownHome abbreviates the login home to ~", () => {
  expect(shownHome("/Users/op/.foreman", "/Users/op")).toBe("~/.foreman");
  expect(shownHome("/srv/frm", "/Users/op")).toBe("/srv/frm");
  expect(shownHome("/Users/opx/.foreman", "/Users/op")).toBe(
    "/Users/opx/.foreman",
  );
});

describe("no test can default onto the real home", () => {
  test("every vitest worker, and every child it spawns with its env, carries the guard", () => {
    expect(process.env[NO_DEFAULT_HOME_ENV]).toBe("1");
  });

  test("with the worker's own env and the real default, the default is refused", () => {
    const got = homeEnvOf({});
    expect(got.ok).toBe(false);
  });

  test("main.ts is the one caller of homeEnvOf: the run functions take the env they are given", () => {
    const src = fileURLToPath(new URL("./", import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const callers = walk(src)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => /\bhomeEnvOf\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(src.length));
    expect(callers.sort()).toEqual(["home.ts", "main.ts"]);
  });
});
