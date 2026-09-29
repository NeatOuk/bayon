import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARDED_HOME, keychainScope } from "@bayon/executors";
import {
  installFakeSecurity,
  type FakeSecurity,
} from "@bayon/executors/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  PREVIEW_PORT,
  devSetup,
  refuseTakenPort,
  takenPortMessage,
} from "./dev-config.js";

// The GUI's dev server follows its home: the default install keeps 5173 and
// 127.0.0.1:3010; a second install its own ports and its own bearer; a taken port is refused.

const TOKEN = "t".repeat(40);
let home: string;
let kc: FakeSecurity;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "frm-web-dev-"));
  kc = installFakeSecurity(join(home, "kc"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const setup = (env: Record<string, string>, readToken = true) =>
  devSetup(
    { FRM_HOME: home, ...env },
    { readToken, keychain: { bin: kc.bin } },
  );

describe("devSetup", () => {
  test("no install file: 5173 and the API on 127.0.0.1:3010, as always", async () => {
    const s = await setup({ FRM_API_TOKEN: TOKEN });
    expect(s.ok && s.value).toMatchObject({
      apiTarget: "http://127.0.0.1:3010",
      devPort: 5173,
      token: TOKEN,
    });
    if (s.ok) {
      expect(s.value.allowedOrigins).toEqual(
        new Set([
          "http://localhost:5173",
          "http://127.0.0.1:5173",
          `http://localhost:${PREVIEW_PORT}`,
          `http://127.0.0.1:${PREVIEW_PORT}`,
        ]),
      );
    }
  });

  test("a second install: its own ports, and its own stored bearer", async () => {
    writeFileSync(
      join(home, "install.json"),
      JSON.stringify({
        version: 1,
        api: { host: "127.0.0.1", port: 3011 },
        web: { port: 5174 },
      }),
    );
    const service = keychainScope({ FRM_HOME: home }).service;
    writeFileSync(join(kc.kc, `${service}.FRM_API_TOKEN`), TOKEN);
    const s = await setup({ FRM_WEB_ORIGINS: "http://10.0.0.2:5174" });
    expect(s.ok && s.value).toMatchObject({
      apiTarget: "http://127.0.0.1:3011",
      devPort: 5174,
      token: TOKEN,
    });
    if (s.ok) {
      expect(s.value.allowedOrigins.has("http://localhost:5174")).toBe(true);
      expect(s.value.allowedOrigins.has("http://10.0.0.2:5174")).toBe(true);
      expect(s.value.allowedOrigins.has("http://localhost:5173")).toBe(false);
    }
  });

  test("the home the local-browser key is read from is the install's own; never ~/.foreman in tests", async () => {
    const s = await setup({ FRM_API_TOKEN: TOKEN });
    expect(s.ok && s.value.home).toBe(home);
    const bare = await devSetup(
      { FRM_API_TOKEN: TOKEN },
      { readToken: true, keychain: { bin: kc.bin } },
    );
    expect(bare.ok && bare.value.home).toBe(GUARDED_HOME);
  });

  test("FRM_WEB_PORT and FRM_API_PORT win; a build reads no bearer", async () => {
    const s = await setup(
      { FRM_WEB_PORT: "5180", FRM_API_PORT: "3020" },
      false,
    );
    expect(s.ok && s.value).toMatchObject({
      apiTarget: "http://127.0.0.1:3020",
      devPort: 5180,
      token: undefined,
    });
  });
});

describe("refuseTakenPort", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))),
    );
  });

  test("a port another install holds on 0.0.0.0 is refused with one plain line", async () => {
    const port = await new Promise<number>((resolve) => {
      const server = createServer();
      servers.push(server);
      server.listen(0, "0.0.0.0", () => {
        const address = server.address();
        resolve(
          typeof address === "object" && address !== null ? address.port : 0,
        );
      });
    });
    await expect(refuseTakenPort(port)).rejects.toThrow(takenPortMessage(port));
    expect(takenPortMessage(port)).toContain("FRM_WEB_PORT");
    expect(takenPortMessage(port)).not.toContain("\n");
  });

  test("a free port passes", async () => {
    await expect(refuseTakenPort(1, async () => true)).resolves.toBeUndefined();
  });
});
