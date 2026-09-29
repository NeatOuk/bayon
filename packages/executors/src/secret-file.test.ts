import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DEFAULT_SECRETS_DIR,
  MAX_SECRET_BYTES,
  fileStoreEnvProblem,
  readNamedSecret,
  readSecretFile,
  secretPath,
  secretStoreKind,
  secretsDir,
} from "./secret-file.js";

// The file store's reader. A sentinel value is written into every file:
// no result, message or cause may ever contain it.
const SENTINEL = "s3cr3t-sentinel-0123456789abcdef";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "frm-secret-file-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function secret(name: string, content: string, mode = 0o440): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

const leaks = (result: unknown): boolean =>
  JSON.stringify(result).includes(SENTINEL);

describe("readSecretFile", () => {
  test.each([0o400, 0o440])(
    "accepts mode %o and strips one newline",
    (mode) => {
      const path = secret("T", `${SENTINEL}\n`, mode);
      expect(readSecretFile(path)).toEqual({ ok: true, value: SENTINEL });
    },
  );

  test("strips a CR LF, and only one line end", () => {
    expect(readSecretFile(secret("A", `${SENTINEL}\r\n`))).toEqual({
      ok: true,
      value: SENTINEL,
    });
    expect(readSecretFile(secret("B", `${SENTINEL}\n\n`))).toEqual({
      ok: true,
      value: `${SENTINEL}\n`,
    });
  });

  test.each([
    ["world-readable", 0o444],
    ["owner-writable", 0o640],
    ["group-writable", 0o460],
    ["open to others", 0o404],
  ])(
    "refuses a file that is %s, naming the mode and never the value",
    (_n, mode) => {
      const result = readSecretFile(secret("T", SENTINEL, mode));
      expect(result).toMatchObject({
        ok: false,
        error: { class: "validation" },
      });
      expect(JSON.stringify(result)).toContain(mode.toString(8));
      expect(leaks(result)).toBe(false);
    },
  );

  test("a missing file is a validation error with cause ENOENT", () => {
    expect(readSecretFile(join(dir, "nope"))).toMatchObject({
      ok: false,
      error: { class: "validation", cause: { code: "ENOENT" } },
    });
  });

  test("a symlink is never followed", () => {
    const target = secret("REAL", SENTINEL);
    symlinkSync(target, join(dir, "LINK"));
    const result = readSecretFile(join(dir, "LINK"));
    expect(result).toMatchObject({
      ok: false,
      error: { cause: { code: "ELOOP" } },
    });
    expect(leaks(result)).toBe(false);
  });

  test("a directory, an empty file and an oversized file are refused", () => {
    mkdirSync(join(dir, "D"));
    expect(readSecretFile(join(dir, "D")).ok).toBe(false);
    expect(readSecretFile(secret("E", "")).ok).toBe(false);
    expect(readSecretFile(secret("N", "\n")).ok).toBe(false);
    const big = readSecretFile(secret("BIG", "x".repeat(MAX_SECRET_BYTES + 1)));
    expect(big).toMatchObject({ ok: false, error: { class: "validation" } });
  });
});

describe("secretStoreKind (FRM_SECRET_STORE)", () => {
  test("unset, empty or keychain is the Keychain; file is the files", () => {
    for (const value of [undefined, "", "keychain"])
      expect(secretStoreKind({ FRM_SECRET_STORE: value })).toEqual({
        ok: true,
        value: "keychain",
      });
    expect(secretStoreKind({ FRM_SECRET_STORE: "file" })).toEqual({
      ok: true,
      value: "file",
    });
  });

  test("anything else is refused", () => {
    expect(secretStoreKind({ FRM_SECRET_STORE: "vault" })).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });
});

describe("fileStoreEnvProblem", () => {
  test("names every forbidden variable, sorted, and never a value", () => {
    const problem = fileStoreEnvProblem({
      FRM_SECRET_X: SENTINEL,
      FRM_WEB_PASSWORD_HASH: SENTINEL,
      FRM_API_TOKEN: SENTINEL,
      FRM_HOME: "/h",
      FRM_SECRET_STORE: "file",
      FRM_SECRETS_DIR: "/run/secrets",
    });
    expect(problem).toMatch(
      /unset FRM_API_TOKEN, FRM_SECRET_X, FRM_WEB_PASSWORD_HASH$/,
    );
    expect(problem).not.toContain(SENTINEL);
  });

  test("FRM_SECRET_STORE and FRM_SECRETS_DIR are settings, not secrets", () => {
    expect(
      fileStoreEnvProblem({ FRM_SECRET_STORE: "file", FRM_SECRETS_DIR: "/s" }),
    ).toBeNull();
  });
});

describe("secretsDir and secretPath", () => {
  test("FRM_SECRETS_DIR, else /run/secrets; a relative one is refused", () => {
    expect(secretsDir({})).toEqual({ ok: true, value: DEFAULT_SECRETS_DIR });
    expect(secretsDir({ FRM_SECRETS_DIR: "/s" })).toEqual({
      ok: true,
      value: "/s",
    });
    expect(secretsDir({ FRM_SECRETS_DIR: "s" }).ok).toBe(false);
  });

  test.each(["../x", ".hidden", "a/b", "", "a b"])(
    "refuses the name %j",
    (name) => {
      expect(secretPath("/s", name).ok).toBe(false);
    },
  );

  test("a plain name joins the directory", () => {
    expect(secretPath("/s", "FRM_BACKUP_KEY.0123abcd")).toEqual({
      ok: true,
      value: "/s/FRM_BACKUP_KEY.0123abcd",
    });
  });
});

describe("readNamedSecret", () => {
  test("reads the file under FRM_SECRETS_DIR", () => {
    secret("FRM_API_TOKEN", SENTINEL);
    expect(
      readNamedSecret(
        { FRM_SECRET_STORE: "file", FRM_SECRETS_DIR: dir },
        "FRM_API_TOKEN",
      ),
    ).toEqual({ ok: true, value: SENTINEL });
  });

  test("refuses when a secret is also in the environment", () => {
    secret("FRM_API_TOKEN", SENTINEL);
    const result = readNamedSecret(
      { FRM_SECRETS_DIR: dir, FRM_API_TOKEN: SENTINEL },
      "FRM_API_TOKEN",
    );
    expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(leaks(result)).toBe(false);
  });
});
