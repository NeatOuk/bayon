import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { API_DEFAULTS, loadConfig } from "./config.js";

// The bearer from the file store: FRM_SECRET_STORE=file reads the file
// FRM_API_TOKEN under FRM_SECRETS_DIR, and a token in the environment is then a boot error.
const TOKEN = "f".repeat(40);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "frm-api-secrets-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function put(value: string, mode = 0o440): void {
  const path = join(dir, "FRM_API_TOKEN");
  writeFileSync(path, `${value}\n`);
  chmodSync(path, mode);
}

describe("loadConfig with the file store", () => {
  test("reads the token from the file", async () => {
    put(TOKEN);
    expect(
      await loadConfig({
        FRM_HOME: dir,
        FRM_SECRET_STORE: "file",
        FRM_SECRETS_DIR: dir,
      }),
    ).toEqual({
      ok: true,
      value: { token: TOKEN, host: API_DEFAULTS.host, port: API_DEFAULTS.port },
    });
  });

  test.each(["FRM_API_TOKEN", "FRM_SECRET_X", "FRM_WEB_PASSWORD_HASH"])(
    "refuses %s in the environment, never echoing it",
    async (name) => {
      put(TOKEN);
      const result = await loadConfig({
        FRM_HOME: dir,
        FRM_SECRET_STORE: "file",
        FRM_SECRETS_DIR: dir,
        [name]: TOKEN,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { class: "validation" },
      });
      expect(JSON.stringify(result)).toContain(name);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    },
  );

  test("a missing, open or short token file is refused without its content", async () => {
    const missing = await loadConfig({
      FRM_HOME: dir,
      FRM_SECRET_STORE: "file",
      FRM_SECRETS_DIR: dir,
    });
    expect(missing).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    put(TOKEN, 0o644);
    const open = await loadConfig({
      FRM_HOME: dir,
      FRM_SECRET_STORE: "file",
      FRM_SECRETS_DIR: dir,
    });
    expect(open.ok).toBe(false);
    expect(JSON.stringify(open)).not.toContain(TOKEN);
    rmSync(join(dir, "FRM_API_TOKEN"));
    put("short");
    expect(
      (
        await loadConfig({
          FRM_HOME: dir,
          FRM_SECRET_STORE: "file",
          FRM_SECRETS_DIR: dir,
        })
      ).ok,
    ).toBe(false);
  });

  test("the Keychain mode (unset) still reads FRM_API_TOKEN from the environment", async () => {
    expect((await loadConfig({ FRM_HOME: dir, FRM_API_TOKEN: TOKEN })).ok).toBe(
      true,
    );
  });
});
