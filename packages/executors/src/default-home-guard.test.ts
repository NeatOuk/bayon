import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  GUARDED_HOME,
  apiUrl,
  installHome,
  installPorts,
  keychainScope,
  readApiToken,
} from "./index.js";
import { expect, test } from "vitest";

// No test resolves the operator's default home (~/.foreman): vitest.setup.ts sets
// FRM_NO_DEFAULT_HOME, and the one rule every process uses to find its install (installHome, in
// packages/executors) honours it. So a test that names no FRM_HOME reads no live install file, no
// live Keychain service and no live bearer, and neither does any child it spawns.
const LIVE = join(userInfo().homedir, ".foreman");

test("every test worker runs under FRM_NO_DEFAULT_HOME", () => {
  expect(process.env.FRM_NO_DEFAULT_HOME).toBe("1");
});

test("a test that names no home resolves the guarded path, never ~/.foreman", async () => {
  expect(installHome({})).toBe(GUARDED_HOME);
  expect(installHome({})).not.toBe(LIVE);
  expect(keychainScope({})).toMatchObject({ owner: false });
  expect(keychainScope({}).service).not.toBe("foreman");
  // No install file there: the defaults, never the live install's ports.
  expect(installPorts({})).toMatchObject({ ok: true });
  expect(apiUrl({})).toEqual({ ok: true, value: "http://127.0.0.1:3010" });
  // No home named: the store is not asked at all (M3), so nothing can answer with a live bearer.
  expect(await readApiToken({})).toEqual({ ok: true, value: undefined });
});

test("a child a test spawns inherits the guard", () => {
  const seen = execFileSync(
    process.execPath,
    ["-e", "process.stdout.write(process.env.FRM_NO_DEFAULT_HOME ?? '')"],
    { encoding: "utf8" },
  );
  expect(seen).toBe("1");
});
