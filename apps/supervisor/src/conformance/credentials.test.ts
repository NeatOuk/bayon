// A conformance run's credentials, against a real temp database and real login files.
// The runner here needs one of two credentials, as a real one does; the host store is emptied or
// filled per test, so each test says which of the two sources the run's credential came from.
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, LOGIN_IN_PLACE_KEY } from "@bayon/core";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { SESSION_GIT_ENV } from "@bayon/executors";
import { afterAll, afterEach, expect, test } from "vitest";
import { envSecrets } from "../lifecycle/secrets.js";
import { suiteCredentials } from "./credentials.js";

const T0 = 1_700_000_000_000;
const t = unwrap(await tempDb(new FakeClock(T0)));
afterAll(() => t.cleanup());

const RUNNER = "a-runner";
/** The same credentials, from a runner whose registration does not say it reads a granted login. */
const UNREADING = "an-unreading-runner";
const PATH = "/usr/bin:/bin";
const VALUE = '{"tokens":{"refresh_token":"r-1"},"last_refresh":"2026-09-20"}';
const ROTATED =
  '{"tokens":{"refresh_token":"r-2"},"last_refresh":"2026-09-21"}';
const STORED_KEY = "sk-the-host-store-copy";
/** What every run's env holds besides its credentials: the session git floor, and PATH. */
const BASE = { ...SESSION_GIT_ENV, PATH };

unwrap(
  await seedRows(t.db, {
    runners: [
      {
        id: RUNNER,
        kind: "script",
        adapter: RUNNER,
        caps_json: "{}",
        defaults_json: JSON.stringify({
          secretEnvAnyOf: [["A_KEY"], ["A_LOGIN"]],
          readsGrantedLogin: true,
        }),
      },
      {
        id: UNREADING,
        kind: "script",
        adapter: UNREADING,
        caps_json: "{}",
        defaults_json: JSON.stringify({
          secretEnvAnyOf: [["A_KEY"], ["A_LOGIN"]],
        }),
      },
    ],
  }),
);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A login file on disk, 0600, as the runner's own CLI leaves it. */
function loginFile(content = VALUE): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "frm-cf-login-")));
  dirs.push(dir);
  const path = join(dir, "auth.json");
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

const grant = async (value: Record<string, string>) =>
  unwrap(
    await seedRows(t.db, {
      settings: [
        {
          key: LOGIN_IN_PLACE_KEY,
          value_json: JSON.stringify(value),
          updated_at: T0,
        },
      ],
    }),
  );

/** The host secret store: empty, or holding a copy of the runner's first credential. */
const emptyStore = envSecrets({});
const storeWithCopy = envSecrets({ FRM_SECRET_A_KEY: STORED_KEY });

const credentialsWith = (secrets: typeof emptyStore) =>
  suiteCredentials({ db: t.db, secrets }, RUNNER, PATH);

test("a grant with no copy in the host store: the run's credential is the granted file", async () => {
  const path = loginFile();
  await grant({ [RUNNER]: path });
  const run = unwrap(await credentialsWith(emptyStore));
  // No one-of secret was required, so none is in the env, and the login is not in it either.
  expect(run.env).toEqual(BASE);
  expect(JSON.stringify(run.env)).not.toContain("refresh_token");
  // The login rides beside the env, for SpawnSpec.grantedLogin, read from the granted file.
  expect(run.grantedLogin).toBeDefined();
  expect(await run.grantedLogin?.()).toEqual({
    ok: true,
    value: { path, value: VALUE, mode: 0o600 },
  });
});

test("the same empty store with no grant refuses, naming both alternatives: the grant is what made the difference", async () => {
  await grant({});
  const out = await credentialsWith(emptyStore);
  expect(out).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(out.ok ? "" : out.error.message).toContain("A_KEY | A_LOGIN");
});

test("a grant whose file is missing refuses the run, naming the setting, the runner and the path, and never falls back to the store's copy", async () => {
  const path = join(loginFile(), "..", "gone.json");
  await grant({ [RUNNER]: path });
  const out = await credentialsWith(storeWithCopy);
  expect(out).toMatchObject({ ok: false, error: { class: "validation" } });
  const message = out.ok ? "" : out.error.message;
  expect(message).toContain(LOGIN_IN_PLACE_KEY);
  expect(message).toContain(RUNNER);
  expect(message).toContain(path);
  expect(JSON.stringify(out)).not.toContain(STORED_KEY);
});

test.each([
  ["no grant", {}],
  ["a grant to another runner", { "other-runner": "/nowhere/auth.json" }],
])(
  "%s: the host store's credential, exactly as before",
  async (_what, grants) => {
    await grant(grants);
    const run = unwrap(await credentialsWith(storeWithCopy));
    expect(run).toEqual({
      env: { A_KEY: STORED_KEY, ...BASE },
      redact: [STORED_KEY],
    });
  },
);

test("the granted value is in the run's redaction list, beside every secret it holds", async () => {
  await grant({ [RUNNER]: loginFile() });
  const run = unwrap(
    await suiteCredentials(
      { db: t.db, secrets: envSecrets({ FRM_SECRET_A_KEY: STORED_KEY }) },
      RUNNER,
      PATH,
    ),
  );
  // With a grant the one-of is not required, so the store's copy is not taken either.
  expect(run.env).toEqual(BASE);
  expect(run.redact).toEqual([VALUE]);
});

test("each session reads the grant again: a rotation written back is what the next one gets", async () => {
  const path = loginFile();
  await grant({ [RUNNER]: path });
  const run = unwrap(await credentialsWith(emptyStore));
  writeFileSync(path, ROTATED, { mode: 0o600 });
  expect(await run.grantedLogin?.()).toEqual({
    ok: true,
    value: { path, value: ROTATED, mode: 0o600 },
  });
});

test("a session started after consent is withdrawn, or after the file is removed, is refused, naming why", async () => {
  const path = loginFile();
  await grant({ [RUNNER]: path });
  const run = unwrap(await credentialsWith(storeWithCopy));
  await grant({});
  const withdrawn = await run.grantedLogin?.();
  expect(withdrawn).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect(withdrawn?.ok === false ? withdrawn.error.message : "").toContain(
    `${LOGIN_IN_PLACE_KEY} no longer grants ${RUNNER}`,
  );
  await grant({ [RUNNER]: path });
  unlinkSync(path);
  const removed = await run.grantedLogin?.();
  expect(removed).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(removed?.ok === false ? removed.error.message : "").toContain(path);
  expect(JSON.stringify(removed)).not.toContain(STORED_KEY);
});

test("a grant to a runner that cannot read one refuses the run, naming the setting and the runner, and never reads the file or the store's copy", async () => {
  const path = loginFile();
  chmodSync(path, 0o000); // a read would fail with another cause: this proves it never happened
  await grant({ [UNREADING]: path });
  const out = await suiteCredentials(
    { db: t.db, secrets: storeWithCopy },
    UNREADING,
    PATH,
  );
  expect(out).toMatchObject({ ok: false, error: { class: "validation" } });
  const message = out.ok ? "" : out.error.message;
  expect(message).toContain(LOGIN_IN_PLACE_KEY);
  expect(message).toContain(UNREADING);
  expect(message).toContain("cannot read a login in place");
  expect(JSON.stringify(out)).not.toContain(STORED_KEY);
});
