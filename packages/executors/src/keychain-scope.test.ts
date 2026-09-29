import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  GUARDED_HOME,
  OWNER_KEYCHAIN_SERVICE,
  defaultHome,
  installHome,
  keychainScope,
} from "./keychain-scope.js";

// The Keychain store belongs to its install: only the account's default home reads the
// live install's service; every other home reads its own.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "frm-keychain-scope-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("keychainScope", () => {
  test("the default home is the login home's .foreman, from the password database", () => {
    expect(defaultHome()).toBe(join(userInfo().homedir, ".foreman"));
  });

  test("a rig that points HOME at a temp dir does not move the default home", () => {
    const before = defaultHome();
    vi.stubEnv("HOME", dir);
    try {
      expect(defaultHome()).toBe(before);
      expect(keychainScope({ FRM_HOME: join(dir, ".foreman") }).owner).toBe(
        false,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("no FRM_HOME and no FRM_DB: the default home, service foreman", () => {
    expect(keychainScope({}, defaultHome(), {})).toEqual({
      service: "foreman",
      owner: true,
    });
    expect(OWNER_KEYCHAIN_SERVICE).toBe("foreman");
  });

  test("FRM_HOME at the login home's .foreman: foreman, whatever HOME says", () => {
    expect(keychainScope({ FRM_HOME: defaultHome(), HOME: dir })).toEqual({
      service: "foreman",
      owner: true,
    });
  });

  test("a symlink to the owner's home is the owner's home", () => {
    const owner = join(dir, "live");
    mkdirSync(owner);
    const link = join(dir, "link");
    symlinkSync(owner, link);
    expect(keychainScope({ FRM_HOME: link }, owner)).toEqual({
      service: "foreman",
      owner: true,
    });
  });

  test("a temp home: a derived service, never foreman, stable, one per home", () => {
    const a = keychainScope({ FRM_HOME: join(dir, "a") });
    const b = keychainScope({ FRM_HOME: join(dir, "b") });
    expect(a.owner).toBe(false);
    expect(a.service).toMatch(/^foreman-[0-9a-f]{12}$/);
    expect(a.service).not.toBe("foreman");
    expect(b.service).not.toBe(a.service);
    expect(keychainScope({ FRM_HOME: join(dir, "a") })).toEqual(a);
  });

  test("a temp home named .foreman is not the owner's", () => {
    const fake = join(dir, ".foreman");
    mkdirSync(fake);
    expect(keychainScope({ FRM_HOME: fake, HOME: dir }).owner).toBe(false);
  });

  test("an empty FRM_HOME falls through, as unset", () => {
    expect(keychainScope({ FRM_HOME: "" }, defaultHome(), {}).owner).toBe(true);
  });
});

describe("installHome", () => {
  test("FRM_HOME first", () => {
    expect(installHome({ FRM_HOME: "/h", FRM_DB: "/d/foreman.db" })).toBe("/h");
  });

  test("without FRM_HOME, FRM_DB's directory: an FRM_DB-only scratch API is not the owner", () => {
    const db = join(dir, "foreman.db");
    expect(installHome({ FRM_DB: db })).toBe(dir);
    expect(keychainScope({ FRM_DB: db }).owner).toBe(false);
    expect(
      keychainScope({ FRM_DB: join(defaultHome(), "foreman.db") }).owner,
    ).toBe(true);
  });

  test("neither: the default home", () => {
    expect(installHome({ FRM_DB: "" }, {})).toBe(defaultHome());
  });

  test("neither, under FRM_NO_DEFAULT_HOME: a path that cannot exist, never ~/.foreman", () => {
    expect(installHome({}, { FRM_NO_DEFAULT_HOME: "1" })).toBe(GUARDED_HOME);
    expect(installHome({ FRM_NO_DEFAULT_HOME: "1" }, {})).toBe(GUARDED_HOME);
    expect(
      keychainScope({}, defaultHome(), { FRM_NO_DEFAULT_HOME: "1" }),
    ).toMatchObject({
      owner: false,
    });
    // A named home is used as named, guard or not.
    expect(installHome({ FRM_HOME: "/h" }, { FRM_NO_DEFAULT_HOME: "1" })).toBe(
      "/h",
    );
  });
});
