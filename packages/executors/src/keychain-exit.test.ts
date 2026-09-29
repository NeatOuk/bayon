import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import {
  envSecrets,
  getSourced,
  isSecretMissing,
  keychainSecrets,
} from "./secrets.js";

// A Keychain miss (security exits 44: no such item) is told apart from a Keychain that could not
// be read (any other exit): only a miss may read as "not set up" (M5).

// Real child processes: more than the default 5 s on a loaded host.
vi.setConfig({ testTimeout: 30_000 });

const dir = mkdtempSync(join(tmpdir(), "frm-keychain-exit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function standIn(name: string, exit: number): string {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\nexit ${exit}\n`);
  chmodSync(bin, 0o700);
  return bin;
}

test("exit 44: a miss", async () => {
  const got = await keychainSecrets("svc", { bin: standIn("miss", 44) }).get(
    "FRM_BACKUP_KEY",
  );
  expect(got.ok).toBe(false);
  if (!got.ok) expect(isSecretMissing(got.error)).toBe(true);
});

test("any other exit: the Keychain could not be read, not a miss", async () => {
  const got = await keychainSecrets("svc", { bin: standIn("locked", 51) }).get(
    "FRM_BACKUP_KEY",
  );
  expect(got.ok).toBe(false);
  if (!got.ok) {
    expect(isSecretMissing(got.error)).toBe(false);
    expect(got.error.message).toContain("could not be read");
  }
});

test("getSourced passes the host store's own error on: a miss stays a miss, a failure a failure", async () => {
  const env = envSecrets({});
  const miss = await getSourced(
    {
      env,
      host: keychainSecrets("svc", { bin: standIn("m2", 44) }),
      hostSource: "keychain",
    },
    "FRM_BACKUP_KEY",
  );
  expect(!miss.ok && isSecretMissing(miss.error)).toBe(true);
  const broken = await getSourced(
    {
      env,
      host: keychainSecrets("svc", { bin: standIn("b2", 1) }),
      hostSource: "keychain",
    },
    "FRM_BACKUP_KEY",
  );
  expect(!broken.ok && isSecretMissing(broken.error)).toBe(false);
});
