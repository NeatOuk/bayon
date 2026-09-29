import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DEFAULT_PORTS,
  INSTALL_FILE,
  apiUrl,
  installPorts,
  mcpUrl,
  readInstallFile,
  writeInstallFile,
} from "./install.js";

// Ports belong to the home: an install.json beside the database, read by the API, the GUI's dev
// server, the supervisor (its sessions' MCP URL) and frm (its API URL). No file: the defaults.

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "frm-install-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const withFile = (body: unknown) =>
  writeFileSync(join(home, INSTALL_FILE), JSON.stringify(body));

describe("installPorts", () => {
  test("no file and no env: 127.0.0.1:3010 and 5173, the default install's", () => {
    expect(installPorts({ FRM_HOME: home })).toEqual({
      ok: true,
      value: {
        apiHost: "127.0.0.1",
        apiHostFrom: "default",
        apiPort: 3010,
        webPort: 5173,
      },
    });
    expect(DEFAULT_PORTS).toEqual({ api: 3010, web: 5173 });
  });

  test("the home's file names its ports", () => {
    withFile({
      version: 1,
      api: { host: "127.0.0.1", port: 3011 },
      web: { port: 5174 },
    });
    const ports = installPorts({ FRM_HOME: home });
    expect(ports.ok && ports.value).toEqual({
      apiHost: "127.0.0.1",
      apiHostFrom: "file",
      apiPort: 3011,
      webPort: 5174,
    });
  });

  test("the environment wins over the file", () => {
    withFile({
      version: 1,
      api: { host: "127.0.0.1", port: 3011 },
      web: { port: 5174 },
    });
    const ports = installPorts({
      FRM_HOME: home,
      FRM_API_HOST: "0.0.0.0",
      FRM_API_PORT: "3020",
      FRM_WEB_PORT: "5180",
    });
    expect(ports.ok && ports.value).toEqual({
      apiHost: "0.0.0.0",
      apiHostFrom: "env",
      apiPort: 3020,
      webPort: 5180,
    });
  });

  test("FRM_DB alone: the file beside the database", () => {
    withFile({
      version: 1,
      api: { host: "127.0.0.1", port: 3012 },
      web: { port: 5175 },
    });
    const ports = installPorts({ FRM_DB: join(home, "foreman.db") });
    expect(ports.ok && ports.value.apiPort).toBe(3012);
  });

  test("a malformed file is an error naming it, never a silent default", () => {
    writeFileSync(join(home, INSTALL_FILE), "{not json");
    const bad = installPorts({ FRM_HOME: home });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toContain(INSTALL_FILE);
    withFile({
      version: 1,
      api: { host: "127.0.0.1", port: 70_000 },
      web: { port: 5174 },
    });
    expect(installPorts({ FRM_HOME: home }).ok).toBe(false);
  });

  test("a bad port in the environment is refused", () => {
    const bad = installPorts({ FRM_HOME: home, FRM_API_PORT: "nope" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toContain("FRM_API_PORT");
  });
});

describe("apiUrl and mcpUrl", () => {
  test("no file: the old defaults, exactly", () => {
    expect(apiUrl({ FRM_HOME: home })).toEqual({
      ok: true,
      value: "http://127.0.0.1:3010",
    });
    expect(mcpUrl({ FRM_HOME: home })).toEqual({
      ok: true,
      value: "http://127.0.0.1:3010/mcp",
    });
  });

  test("derived from the home's port", () => {
    withFile({
      version: 1,
      api: { host: "127.0.0.1", port: 3011 },
      web: { port: 5174 },
    });
    expect(apiUrl({ FRM_HOME: home })).toEqual({
      ok: true,
      value: "http://127.0.0.1:3011",
    });
    expect(mcpUrl({ FRM_HOME: home })).toEqual({
      ok: true,
      value: "http://127.0.0.1:3011/mcp",
    });
  });

  test("FRM_API_PORT alone moves both, as a second install started with one setting", () => {
    expect(apiUrl({ FRM_HOME: home, FRM_API_PORT: "3011" })).toEqual({
      ok: true,
      value: "http://127.0.0.1:3011",
    });
    expect(mcpUrl({ FRM_HOME: home, FRM_API_PORT: "3011" })).toEqual({
      ok: true,
      value: "http://127.0.0.1:3011/mcp",
    });
  });

  test("a wildcard bind host is reached on loopback; an IPv6 host is bracketed", () => {
    expect(apiUrl({ FRM_HOME: home, FRM_API_HOST: "0.0.0.0" })).toEqual({
      ok: true,
      value: "http://127.0.0.1:3010",
    });
    expect(apiUrl({ FRM_HOME: home, FRM_API_HOST: "::" })).toEqual({
      ok: true,
      value: "http://[::1]:3010",
    });
    expect(apiUrl({ FRM_HOME: home, FRM_API_HOST: "::1" })).toEqual({
      ok: true,
      value: "http://[::1]:3010",
    });
  });

  test("FRM_API_URL and FRM_MCP_URL win, trailing slashes dropped", () => {
    withFile({
      version: 1,
      api: { host: "127.0.0.1", port: 3011 },
      web: { port: 5174 },
    });
    expect(apiUrl({ FRM_HOME: home, FRM_API_URL: "http://api:3010/" })).toEqual(
      {
        ok: true,
        value: "http://api:3010",
      },
    );
    expect(
      mcpUrl({ FRM_HOME: home, FRM_MCP_URL: "http://api:3010/mcp" }),
    ).toEqual({
      ok: true,
      value: "http://api:3010/mcp",
    });
  });
});

describe("the install file", () => {
  test("absent reads as null; written 0600 and read back", () => {
    expect(readInstallFile(home)).toEqual({ ok: true, value: null });
    const written = writeInstallFile(home, {
      version: 1,
      api: { host: "127.0.0.1", port: 3011 },
      web: { port: 5174 },
    });
    expect(written.ok).toBe(true);
    const path = join(home, INSTALL_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      api: { host: "127.0.0.1", port: 3011 },
      web: { port: 5174 },
    });
    expect(readInstallFile(home)).toEqual({
      ok: true,
      value: {
        version: 1,
        api: { host: "127.0.0.1", port: 3011 },
        web: { port: 5174 },
      },
    });
  });

  test("a directory in its place is an error", () => {
    mkdirSync(join(home, INSTALL_FILE));
    expect(readInstallFile(home).ok).toBe(false);
  });
});

describe("the file's API host (M2): this machine unless the operator says otherwise", () => {
  test.each(["127.0.0.1", "::1", "localhost"])("%s is accepted", (host) => {
    withFile({ version: 1, api: { host, port: 3011 }, web: { port: 5174 } });
    const ports = installPorts({ FRM_HOME: home });
    expect(ports.ok && ports.value).toMatchObject({
      apiHost: host,
      apiHostFrom: "file",
    });
    expect(apiUrl({ FRM_HOME: home }).ok).toBe(true);
  });

  test.each(["0.0.0.0", "::"])(
    "%s only with expose: true, and is dialled on loopback",
    (host) => {
      withFile({ version: 1, api: { host, port: 3011 }, web: { port: 5174 } });
      expect(installPorts({ FRM_HOME: home }).ok).toBe(false);
      withFile({
        version: 1,
        api: { host, port: 3011, expose: true },
        web: { port: 5174 },
      });
      const url = apiUrl({ FRM_HOME: home });
      expect(url.ok && url.value).toMatch(
        /^http:\/\/(127\.0\.0\.1|\[::1\]):3011$/,
      );
    },
  );

  test.each(["10.0.0.5", "api.example.com", "192.168.1.2"])(
    "%s is refused from the file, even with expose",
    (host) => {
      withFile({
        version: 1,
        api: { host, port: 3011, expose: true },
        web: { port: 5174 },
      });
      const ports = installPorts({ FRM_HOME: home });
      expect(ports.ok).toBe(false);
      if (!ports.ok) expect(ports.error.message).toContain("FRM_API_HOST");
      expect(apiUrl({ FRM_HOME: home }).ok).toBe(false);
    },
  );

  test("any address from FRM_API_HOST, the operator's own env; FRM_API_URL and FRM_MCP_URL still win", () => {
    expect(apiUrl({ FRM_HOME: home, FRM_API_HOST: "10.0.0.5" })).toEqual({
      ok: true,
      value: "http://10.0.0.5:3010",
    });
    withFile({
      version: 1,
      api: { host: "10.0.0.5", port: 3011 },
      web: { port: 5174 },
    });
    expect(apiUrl({ FRM_HOME: home, FRM_API_URL: "http://api:3010" })).toEqual({
      ok: true,
      value: "http://api:3010",
    });
    expect(
      mcpUrl({ FRM_HOME: home, FRM_MCP_URL: "http://api:3010/mcp" }),
    ).toEqual({
      ok: true,
      value: "http://api:3010/mcp",
    });
  });
});
