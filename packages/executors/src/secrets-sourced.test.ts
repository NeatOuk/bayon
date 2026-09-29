import { expect, test } from "vitest";
import { envSecrets, getSourced, type HostSecretStores } from "./secrets.js";

// getSourced (security review): firstOf's order, saying which store answered, so a
// backup-key reader can warn when the environment overrides the host store.
const VALUE = "0123456789abcdef".repeat(4);
const keychain = envSecrets({ FRM_SECRET_FRM_BACKUP_KEY: VALUE });

test("the environment answers first and says so", async () => {
  const stores: HostSecretStores = {
    env: envSecrets({ FRM_SECRET_FRM_BACKUP_KEY: "e" }),
    host: keychain,
    hostSource: "keychain",
  };
  expect(await getSourced(stores, "FRM_BACKUP_KEY")).toEqual({
    ok: true,
    value: { value: "e", source: "env" },
  });
});

test("else the host store, named by its kind; a miss in both names the secret, never a value", async () => {
  for (const hostSource of ["keychain", "file"] as const) {
    const stores: HostSecretStores = {
      env: envSecrets({}),
      host: keychain,
      hostSource,
    };
    expect(await getSourced(stores, "FRM_BACKUP_KEY")).toEqual({
      ok: true,
      value: { value: VALUE, source: hostSource },
    });
    const missing = await getSourced(stores, "OTHER");
    expect(missing).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    expect(JSON.stringify(missing)).toContain("OTHER");
    expect(JSON.stringify(missing)).not.toContain(VALUE);
  }
});
