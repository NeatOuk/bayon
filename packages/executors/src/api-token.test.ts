import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { API_TOKEN_NAME, readApiToken } from "./api-token.js";
import { keychainScope } from "./keychain-scope.js";
import {
  installFakeSecurity,
  type FakeSecurity,
} from "./testing/fake-security.js";

// The API's bearer: FRM_API_TOKEN in the environment, else this home's own store — the
// file store on a server, the Keychain under this home's service on a Mac. Never another install's.

const TOKEN = "ab".repeat(32);
let root: string;
let kc: FakeSecurity;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "frm-api-token-"));
  kc = installFakeSecurity(join(root, "kc"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const store = (home: string, value: string) =>
  writeFileSync(
    join(
      kc.kc,
      `${keychainScope({ FRM_HOME: home }).service}.${API_TOKEN_NAME}`,
    ),
    value,
  );

describe("readApiToken", () => {
  test("the environment wins, and the Keychain is not asked", async () => {
    const home = join(root, "h");
    store(home, "cd".repeat(32));
    expect(
      await readApiToken(
        { FRM_HOME: home, FRM_API_TOKEN: TOKEN },
        { keychain: { bin: kc.bin } },
      ),
    ).toEqual({ ok: true, value: TOKEN });
    expect(readFileSync(kc.argv, "utf8")).toBe("");
  });

  test("no env: this home's service, never the live install's", async () => {
    const home = join(root, "h");
    store(home, TOKEN);
    expect(
      await readApiToken({ FRM_HOME: home }, { keychain: { bin: kc.bin } }),
    ).toEqual({ ok: true, value: TOKEN });
    const argv = readFileSync(kc.argv, "utf8");
    expect(argv).toContain(
      `-s ${keychainScope({ FRM_HOME: home }).service} -a FRM_API_TOKEN`,
    );
    expect(argv).not.toMatch(/-s foreman /);
  });

  test("another home's token is not this one's", async () => {
    store(join(root, "other"), TOKEN);
    expect(
      await readApiToken(
        { FRM_HOME: join(root, "h") },
        { keychain: { bin: kc.bin } },
      ),
    ).toEqual({ ok: true, value: undefined });
  });

  test("an empty FRM_API_TOKEN reads as unset", async () => {
    const home = join(root, "h");
    store(home, TOKEN);
    expect(
      await readApiToken(
        { FRM_HOME: home, FRM_API_TOKEN: "" },
        { keychain: { bin: kc.bin } },
      ),
    ).toEqual({ ok: true, value: TOKEN });
  });

  test("the file store: the file, and a token in the environment is refused", async () => {
    const dir = join(root, "secrets");
    mkdirSync(dir);
    const path = join(dir, API_TOKEN_NAME);
    writeFileSync(path, `${TOKEN}\n`);
    chmodSync(path, 0o440);
    expect(
      await readApiToken({ FRM_SECRET_STORE: "file", FRM_SECRETS_DIR: dir }),
    ).toEqual({ ok: true, value: TOKEN });
    const refused = await readApiToken({
      FRM_SECRET_STORE: "file",
      FRM_SECRETS_DIR: dir,
      FRM_API_TOKEN: TOKEN,
    });
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toContain(TOKEN);
  });

  test("inside an agent session (session id or home tag in the env): the store is never asked", async () => {
    const home = join(root, "h");
    store(home, TOKEN);
    for (const marker of ["FRM_SESSION_ID", "FRM_HOME_TAG"]) {
      expect(
        await readApiToken(
          { FRM_HOME: home, [marker]: "x" },
          { keychain: { bin: kc.bin } },
        ),
      ).toEqual({ ok: true, value: undefined });
    }
    expect(readFileSync(kc.argv, "utf8")).toBe("");
    // A token the session was handed explicitly is still its own to use.
    expect(
      await readApiToken(
        { FRM_HOME: home, FRM_SESSION_ID: "x", FRM_API_TOKEN: TOKEN },
        { keychain: { bin: kc.bin } },
      ),
    ).toEqual({ ok: true, value: TOKEN });
  });

  test("no FRM_HOME and no FRM_DB: the store is never asked, so a bare run never gets the live bearer", async () => {
    expect(
      await readApiToken(
        { FRM_NO_DEFAULT_HOME: "" },
        { keychain: { bin: kc.bin } },
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(readFileSync(kc.argv, "utf8")).toBe("");
  });

  test("FRM_DB alone names the home: its store is read", async () => {
    const home = join(root, "h");
    mkdirSync(home);
    store(home, TOKEN);
    expect(
      await readApiToken(
        { FRM_DB: join(home, "foreman.db") },
        { keychain: { bin: kc.bin } },
      ),
    ).toEqual({ ok: true, value: TOKEN });
  });
});
