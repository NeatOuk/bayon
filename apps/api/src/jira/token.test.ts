// Where the API finds the Jira token, on each host: the Keychain store (the API's own
// FRM_SECRET_JIRA_API_TOKEN first) and the file store (the file under FRM_SECRETS_DIR, the
// environment refused), each present and absent. The real Keychain is never asked: `security` is a
// shim that finds nothing.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { jiraTokenStatus, jiraTokenStore, storeTokenHint } from "./token.js";

/** A scratch API's home: never the default one, so never the live install's service. */
const SCRATCH = { FRM_HOME: join(tmpdir(), "jira-token-scratch-home") };
const SCRATCH_SERVICE = /^foreman-[0-9a-f]{12}$/;

const VALUE = "token-value-never-shown-7e1f";
const dir = mkdtempSync(join(tmpdir(), "jira-token-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A `security` that has nothing: exit 44, as it does for an absent item. */
const shim = join(dir, "security");
writeFileSync(shim, "#!/bin/sh\nexit 44\n");
chmodSync(shim, 0o700);
const keychain = { bin: shim };

function secretsDir(withToken: boolean): string {
  const d = mkdtempSync(join(dir, "secrets-"));
  if (withToken) {
    const file = join(d, "JIRA_API_TOKEN");
    writeFileSync(file, `${VALUE}\n`);
    chmodSync(file, 0o440);
  }
  return d;
}

test.each([
  [
    "the API's environment",
    { ...SCRATCH, FRM_SECRET_JIRA_API_TOKEN: VALUE },
    true,
  ],
  ["neither the environment nor the Keychain", SCRATCH, false],
])("the Keychain store: %s", async (_name, env, present) => {
  const store = jiraTokenStore(env, keychain);
  expect(store.kind).toBe("keychain");
  const status = await jiraTokenStatus(store);
  expect(status).toEqual({
    secret: "JIRA_API_TOKEN",
    store: "keychain",
    keychain: { service: expect.stringMatching(SCRATCH_SERVICE), owner: false },
    present,
  });
  expect(JSON.stringify(status)).not.toContain(VALUE);
});

test.each([
  ["the file there", true],
  ["no file", false],
])("the file store: %s", async (_name, withToken) => {
  const store = jiraTokenStore({
    FRM_SECRET_STORE: "file",
    FRM_SECRETS_DIR: secretsDir(withToken),
  });
  expect(await jiraTokenStatus(store)).toEqual({
    secret: "JIRA_API_TOKEN",
    store: "file",
    keychain: null,
    present: withToken,
  });
  const read = await store.secrets.get("JIRA_API_TOKEN");
  expect(read.ok ? read.value : null).toBe(withToken ? VALUE : null);
});

test("the file store refuses the environment: a token there is not found, and the refusal says why", async () => {
  const store = jiraTokenStore({
    FRM_SECRET_STORE: "file",
    FRM_SECRETS_DIR: secretsDir(true),
    FRM_SECRET_JIRA_API_TOKEN: VALUE,
  });
  expect(store.kind).toBe("file");
  expect((await jiraTokenStatus(store)).present).toBe(false);
  const read = await store.secrets.get("JIRA_API_TOKEN");
  expect(read.ok).toBe(false);
  if (!read.ok) {
    expect(read.error.message).toContain("unset FRM_SECRET_JIRA_API_TOKEN");
    expect(read.error.message).not.toContain(VALUE);
  }
});

test("a store the environment misnames is the Keychain's, and finds nothing", async () => {
  const store = jiraTokenStore(
    { ...SCRATCH, FRM_SECRET_STORE: "vault", FRM_SECRET_JIRA_API_TOKEN: VALUE },
    keychain,
  );
  expect(await jiraTokenStatus(store)).toEqual({
    secret: "JIRA_API_TOKEN",
    store: "keychain",
    keychain: { service: expect.stringMatching(SCRATCH_SERVICE), owner: false },
    present: false,
  });
});

test("the default home's API reads the live install's service; a scratch home's never does", () => {
  expect(
    jiraTokenStore({ FRM_HOME: join(userInfo().homedir, ".foreman") }, keychain)
      .keychain,
  ).toEqual({ service: "foreman", owner: true });
  // No home named: under the test guard (FRM_NO_DEFAULT_HOME) never the live install's service.
  expect(jiraTokenStore({}, keychain).keychain?.service).not.toBe("foreman");
  const scratch = jiraTokenStore(SCRATCH, keychain).keychain;
  expect(scratch?.owner).toBe(false);
  expect(scratch?.service).not.toBe("foreman");
  // An API on FRM_DB alone belongs to that database's directory, not to the default home.
  expect(
    jiraTokenStore({ FRM_DB: join(SCRATCH.FRM_HOME, "foreman.db") }, keychain)
      .keychain,
  ).toEqual(scratch);
});

const OWNER = {
  kind: "keychain",
  keychain: { service: "foreman", owner: true },
} as const;
const OTHER = {
  kind: "keychain",
  keychain: { service: "foreman-0123456789ab", owner: false },
} as const;
const FILE = { kind: "file", keychain: null } as const;

test("each store's hint names its own door and service, and that no restart is needed", () => {
  expect(storeTokenHint(OWNER)).toBe(
    'copy the token, then run `security add-generic-password -U -s foreman -a JIRA_API_TOKEN -w "$(pbpaste)"` and check that `security find-generic-password -s foreman -a JIRA_API_TOKEN -w | wc -c` prints about 190, not 129 (or set FRM_SECRET_JIRA_API_TOKEN in the API\'s environment); the next sync reads it, no restart needed',
  );
  expect(storeTokenHint(OTHER)).toBe(
    "not ~/.foreman's Keychain: copy the token, then run `security add-generic-password -U -s foreman-0123456789ab -a JIRA_API_TOKEN -w \"$(pbpaste)\"` and check that `security find-generic-password -s foreman-0123456789ab -a JIRA_API_TOKEN -w | wc -c` prints about 190, not 129 (or set FRM_SECRET_JIRA_API_TOKEN in the API's environment); the next sync reads it, no restart needed",
  );
  // The whole missing-token message fits the audit row's 500 characters, so the GUI shows it whole.
  for (const store of [OWNER, OTHER]) {
    expect(
      `JIRA_API_TOKEN could not be read from the host secret store (secret JIRA_API_TOKEN is not in the secret store): ${storeTokenHint(store)}`
        .length,
    ).toBeLessThanOrEqual(500);
  }
  expect(storeTokenHint(FILE)).toBe(
    "store it with `sudo /srv/bayon/<deployment>/secrets.sh put <deployment> api JIRA_API_TOKEN` (the value on stdin); the next sync reads it, no restart needed",
  );
});
