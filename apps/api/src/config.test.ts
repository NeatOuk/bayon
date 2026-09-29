import { describe, expect, test } from "vitest";
import {
  API_DEFAULTS,
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

describe("loadConfig", () => {
  test("reads the token and defaults to 127.0.0.1:3010", () => {
    expect(loadConfig({ FRM_API_TOKEN: token })).toEqual({
      ok: true,
      value: { token, host: API_DEFAULTS.host, port: API_DEFAULTS.port },
    });
  });

  test("takes host and port from the environment", () => {
    const result = loadConfig({
      FRM_API_TOKEN: token,
      FRM_API_HOST: "0.0.0.0",
      FRM_API_PORT: "0",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { host: "0.0.0.0", port: 0 },
    });
  });

  test("a missing or short token is a validation error that never echoes it", () => {
    for (const env of [{}, { FRM_API_TOKEN: "short-secret" }]) {
      const result = loadConfig(env);
      expect(result).toMatchObject({
        ok: false,
        error: { class: "validation" },
      });
      expect(JSON.stringify(result)).not.toContain("short-secret");
    }
  });

  test("a bad port is a validation error", () => {
    for (const port of ["-1", "65536", "http", "1.5"]) {
      expect(
        loadConfig({ FRM_API_TOKEN: token, FRM_API_PORT: port }),
      ).toMatchObject({ ok: false, error: { class: "validation" } });
    }
  });
});
