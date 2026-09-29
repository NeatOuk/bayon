import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keychainScope } from "@bayon/executors";
import {
  installFakeSecurity,
  type FakeSecurity,
} from "@bayon/executors/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  API_DEFAULTS,
  NO_TOKEN_MESSAGE,
  loadConfig,
  loadDbPath,
  loadRuntimeDir,
  loadWorkRoot,
} from "./config.js";

describe("loadRuntimeDir", () => {
  test("FRM_RUNTIME_DIR wins, else FRM_HOME/runtime, else none", () => {
    expect(loadRuntimeDir({ FRM_RUNTIME_DIR: "/r", FRM_HOME: "/h" })).toBe(
      "/r",
    );
    expect(loadRuntimeDir({ FRM_HOME: "/h" })).toBe("/h/runtime");
    expect(loadRuntimeDir({})).toBeNull();
    expect(loadRuntimeDir({ FRM_RUNTIME_DIR: "", FRM_HOME: "" })).toBeNull();
  });
});

describe("loadWorkRoot", () => {
  test("FRM_HOME/work, where the supervisor roots each session's worktrees; else none", () => {
    expect(loadWorkRoot({ FRM_HOME: "/h", FRM_RUNTIME_DIR: "/r" })).toBe(
      "/h/work",
    );
    expect(loadWorkRoot({})).toBeNull();
    expect(loadWorkRoot({ FRM_HOME: "" })).toBeNull();
  });
});

describe("loadDbPath", () => {
  test("FRM_DB wins, else FRM_HOME/foreman.db, as in the db CLI", () => {
    expect(loadDbPath({ FRM_DB: "/x/a.db", FRM_HOME: "/h" })).toEqual({
      ok: true,
      value: "/x/a.db",
    });
    expect(loadDbPath({ FRM_HOME: "/h" })).toEqual({
      ok: true,
      value: "/h/foreman.db",
    });
  });

  test("neither is a validation error", () => {
    for (const env of [{}, { FRM_DB: "" }]) {
      expect(loadDbPath(env)).toMatchObject({
        ok: false,
        error: { class: "validation" },
      });
    }
  });
});

const token = "t".repeat(32);

// Every case runs on a temp home with a stand-in `security`: never the default home's Keychain.
let home: string;
let kc: FakeSecurity;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "frm-api-config-"));
  kc = installFakeSecurity(join(home, "kc"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});
const load = (env: Record<string, string>) =>
  loadConfig({ FRM_HOME: home, ...env }, { keychain: { bin: kc.bin } });

describe("loadConfig", () => {
  test("reads the token and defaults to 127.0.0.1:3010", async () => {
    expect(await load({ FRM_API_TOKEN: token })).toEqual({
      ok: true,
      value: { token, host: API_DEFAULTS.host, port: API_DEFAULTS.port },
    });
  });

  test("takes host and port from the environment", async () => {
    const result = await load({
      FRM_API_TOKEN: token,
      FRM_API_HOST: "0.0.0.0",
      FRM_API_PORT: "0",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { host: "0.0.0.0", port: 0 },
    });
  });

  test("no token in the env: this home's Keychain service, which frm init fills", async () => {
    const service = keychainScope({ FRM_HOME: home }).service;
    writeFileSync(join(kc.kc, `${service}.FRM_API_TOKEN`), token);
    expect(await load({})).toMatchObject({ ok: true, value: { token } });
  });

  test("no token anywhere: the message names frm init", async () => {
    const result = await load({});
    expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
    if (!result.ok) expect(result.error.message).toContain(NO_TOKEN_MESSAGE);
    expect(NO_TOKEN_MESSAGE).toContain("pnpm frm init");
  });

  test("the port and host come from the home's install.json when the env names none", async () => {
    writeFileSync(
      join(home, "install.json"),
      JSON.stringify({
        version: 1,
        api: { host: "127.0.0.1", port: 3011 },
        web: { port: 5174 },
      }),
    );
    expect(await load({ FRM_API_TOKEN: token })).toMatchObject({
      ok: true,
      value: { host: "127.0.0.1", port: 3011 },
    });
    expect(
      await load({ FRM_API_TOKEN: token, FRM_API_PORT: "3020" }),
    ).toMatchObject({ ok: true, value: { port: 3020 } });
  });

  test("a short token is a validation error that never echoes it", async () => {
    const result = await load({ FRM_API_TOKEN: "short-secret" });
    expect(result).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    expect(JSON.stringify(result)).not.toContain("short-secret");
  });

  test("a bad port is a validation error", async () => {
    for (const port of ["-1", "65536", "http", "1.5"]) {
      expect(
        await load({ FRM_API_TOKEN: token, FRM_API_PORT: port }),
      ).toMatchObject({ ok: false, error: { class: "validation" } });
    }
  });
});
