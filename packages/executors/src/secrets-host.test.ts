import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fileSecrets, getSourced, hostSecrets } from "./secrets.js";

vi.setConfig({ testTimeout: 30_000 });

// The Linux host store and the one selector. A sentinel value sits in every
// secret: no result or message may ever carry it.
const SENTINEL = "a1b2c3d4e5f6".repeat(4);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "frm-secrets-host-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function put(name: string, value: string, mode = 0o440): void {
  const path = join(dir, name);
  writeFileSync(path, `${value}\n`);
  chmodSync(path, mode);
}

describe("fileSecrets", () => {
  test("reads <dir>/<NAME> on every get: a rotated file is seen at once", async () => {
    const store = fileSecrets(dir);
    put("RUNNER_TOKEN", SENTINEL);
    expect(await store.get("RUNNER_TOKEN")).toEqual({
      ok: true,
      value: SENTINEL,
    });
    rmSync(join(dir, "RUNNER_TOKEN"));
    put("RUNNER_TOKEN", "rotated-value-000000");
    expect(await store.get("RUNNER_TOKEN")).toEqual({
      ok: true,
      value: "rotated-value-000000",
    });
  });

  test("a missing file is a plain miss, as the Keychain's", async () => {
    const miss = await fileSecrets(dir).get("ABSENT");
    expect(miss).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(JSON.stringify(miss)).toContain(
      "secret ABSENT is not in the secret store",
    );
  });

  test("a bad mode is its own error, naming the file and never the value", async () => {
    put("OPEN", SENTINEL, 0o644);
    const result = await fileSecrets(dir).get("OPEN");
    expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(JSON.stringify(result)).toContain("0644");
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  test("a name that could leave the directory is refused", async () => {
    expect((await fileSecrets(dir).get("../etc")).ok).toBe(false);
  });
});

describe("hostSecrets", () => {
  const o = { keychain: { bin: "/nonexistent/security" } };

  test("unset: the environment, then the Keychain (today's order)", async () => {
    const selected = hostSecrets({ FRM_SECRET_FRM_BACKUP_KEY: SENTINEL }, o);
    if (!selected.ok) throw new Error(selected.error.message);
    expect(selected.value.kind).toBe("keychain");
    expect(selected.value.stores.hostSource).toBe("keychain");
    expect(await selected.value.spawn.get("FRM_BACKUP_KEY")).toEqual({
      ok: true,
      value: SENTINEL,
    });
  });

  test("file: only the files, and the source says file", async () => {
    put("FRM_BACKUP_KEY", SENTINEL);
    const selected = hostSecrets(
      { FRM_SECRET_STORE: "file", FRM_SECRETS_DIR: dir },
      o,
    );
    if (!selected.ok) throw new Error(selected.error.message);
    expect(selected.value.kind).toBe("file");
    expect(await getSourced(selected.value.stores, "FRM_BACKUP_KEY")).toEqual({
      ok: true,
      value: { value: SENTINEL, source: "file" },
    });
    expect(await selected.value.spawn.get("FRM_BACKUP_KEY")).toEqual({
      ok: true,
      value: SENTINEL,
    });
  });

  test.each([
    ["FRM_SECRET_FRM_BACKUP_KEY"],
    ["FRM_API_TOKEN"],
    ["FRM_WEB_PASSWORD_HASH"],
  ])("file: %s in the environment is refused, by name only", (name) => {
    const selected = hostSecrets(
      { FRM_SECRET_STORE: "file", FRM_SECRETS_DIR: dir, [name]: SENTINEL },
      o,
    );
    expect(selected).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    expect(JSON.stringify(selected)).toContain(name);
    expect(JSON.stringify(selected)).not.toContain(SENTINEL);
  });

  test("an unknown store or a relative directory is refused", () => {
    expect(hostSecrets({ FRM_SECRET_STORE: "vault" }, o).ok).toBe(false);
    expect(
      hostSecrets({ FRM_SECRET_STORE: "file", FRM_SECRETS_DIR: "rel" }, o).ok,
    ).toBe(false);
  });
});

// which Keychain service a process queries, seen through a stand-in `security` that
// records every argv line and answers a dummy value. The real Keychain is never asked.
describe("hostSecrets: the Keychain belongs to its install", () => {
  const DUMMY = "dummy-value-not-a-secret";

  function recorder(): { bin: string; calls: () => string[][] } {
    const bin = join(dir, "security");
    const log = join(dir, "security.argv");
    writeFileSync(
      bin,
      `#!/bin/sh\necho "$*" >> "${log}"\nprintf '%s\\n' '${DUMMY}'\n`,
    );
    chmodSync(bin, 0o700);
    return {
      bin,
      calls: () =>
        existsSync(log)
          ? readFileSync(log, "utf8")
              .trim()
              .split("\n")
              .map((line) => line.split(" "))
          : [],
    };
  }

  const serviceOf = (argv: readonly string[]): string | undefined =>
    argv[argv.indexOf("-s") + 1];

  test("a temp FRM_HOME queries its own derived service, never foreman", async () => {
    const shim = recorder();
    const home = join(dir, "scratch-home");
    const selected = hostSecrets(
      { FRM_HOME: home },
      { keychain: { bin: shim.bin } },
    );
    if (!selected.ok) throw new Error(selected.error.message);
    expect(selected.value.keychain?.owner).toBe(false);
    expect(await selected.value.spawn.get("JIRA_API_TOKEN")).toEqual({
      ok: true,
      value: DUMMY,
    });
    const calls = shim.calls();
    expect(calls).toHaveLength(1);
    const service = serviceOf(calls[0] ?? []);
    expect(service).toBe(selected.value.keychain?.service);
    expect(service).toMatch(/^foreman-[0-9a-f]{12}$/);
    expect(calls.flat()).not.toContain("foreman");
  });

  test("the default home queries foreman", async () => {
    const shim = recorder();
    // `{}` alone is guarded under vitest (FRM_NO_DEFAULT_HOME): the default home only by name here.
    for (const env of [{ FRM_HOME: join(userInfo().homedir, ".foreman") }]) {
      const selected = hostSecrets(env, { keychain: { bin: shim.bin } });
      if (!selected.ok) throw new Error(selected.error.message);
      expect(selected.value.keychain).toEqual({
        service: "foreman",
        owner: true,
      });
      await selected.value.spawn.get("JIRA_API_TOKEN");
    }
    expect(shim.calls().map(serviceOf)).toEqual(["foreman"]);
  });

  test("no home named, under the test guard: never the live install's service", () => {
    const selected = hostSecrets({});
    if (!selected.ok) throw new Error(selected.error.message);
    expect(selected.value.keychain?.owner).toBe(false);
    expect(selected.value.keychain?.service).not.toBe("foreman");
  });

  test("FRM_SECRET_<NAME> still wins, and security is never run", async () => {
    const shim = recorder();
    const selected = hostSecrets(
      {
        FRM_HOME: join(dir, "scratch-home"),
        FRM_SECRET_JIRA_API_TOKEN: SENTINEL,
      },
      { keychain: { bin: shim.bin } },
    );
    if (!selected.ok) throw new Error(selected.error.message);
    expect(await selected.value.spawn.get("JIRA_API_TOKEN")).toEqual({
      ok: true,
      value: SENTINEL,
    });
    expect(shim.calls()).toEqual([]);
  });

  test("the file store has no Keychain scope", () => {
    const selected = hostSecrets(
      { FRM_SECRET_STORE: "file", FRM_SECRETS_DIR: dir },
      { keychain: { bin: "/nonexistent/security" } },
    );
    if (!selected.ok) throw new Error(selected.error.message);
    expect(selected.value.keychain).toBeNull();
  });
});
