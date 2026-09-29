// Consent to a login used in place (§14), against a real temp database and real files.
// The differential the ticket asks for: with no consent the granted path is never read — proved by
// making it unreadable — and with consent the runner's one-of credentials are no longer required.
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, LOGIN_IN_PLACE_KEY } from "@bayon/core";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import type { SpawnSpec } from "@bayon/runners";
import { afterAll, afterEach, expect, test } from "vitest";
import {
  buildEnv,
  grantedLoginFor,
  redactionList,
  resolveCredentials,
} from "./home.js";
import type { SessionPaths } from "./paths.js";
import type { SessionConfig } from "./profile.js";
import { envSecrets } from "./secrets.js";
import { DEFAULT_SETTINGS } from "./settings.js";

const T0 = 1_700_000_000_000;
const t = unwrap(await tempDb(new FakeClock(T0)));
afterAll(() => t.cleanup());

const RUNNER = "a-runner";
const VALUE = '{"tokens":{"refresh_token":"r-1"},"last_refresh":"2026-09-20"}';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A login file on disk, 0600 unless told otherwise. */
function loginFile(mode = 0o600): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "frm-consent-")));
  dirs.push(dir);
  const path = join(dir, "auth.json");
  writeFileSync(path, VALUE, { mode });
  chmodSync(path, mode);
  return path;
}

const grant = (value: unknown) =>
  seedRows(t.db, {
    settings: [
      {
        key: LOGIN_IN_PLACE_KEY,
        value_json: JSON.stringify(value),
        updated_at: T0,
      },
    ],
  });

const paths: SessionPaths = {
  root: "/frm/work/S1",
  dir: "/frm/runtime/sessions/S1",
  home: "/frm/runtime/sessions/S1/home",
  tmp: "/frm/runtime/sessions/S1/tmp",
  logs: "/frm/runtime/sessions/S1/logs",
  prompts: "/frm/runtime/sessions/S1/prompts",
  rawLog: "/frm/runtime/sessions/S1/logs/raw.jsonl",
  remote: false,
};
const config: SessionConfig = {
  input: {},
  flags: {},
  env: {},
  secretNames: [],
  secretAnyOf: [["A_KEY"], ["A_LOGIN"]],
  hashInputs: [],
  baselineTokens: 0,
  toolAllowlist: [],
  // The runner here declares that it reads a granted login.
  readsGrantedLogin: true,
};
const ctx = {
  db: t.db,
  secrets: envSecrets({}),
  settings: DEFAULT_SETTINGS,
  path: "/usr/bin:/bin",
  homeTag: "tag",
};

test("no row: nothing is granted, and a login on disk is not read", async () => {
  // Unreadable on purpose — a read of it would fail, so success is the proof it was not read.
  loginFile(0o000);
  expect(await grantedLoginFor(t.db, RUNNER)).toEqual({
    ok: true,
    value: undefined,
  });
});

test("a grant to another runner grants this one nothing", async () => {
  unwrap(await grant({ "other-runner": loginFile() }));
  expect(await grantedLoginFor(t.db, RUNNER)).toEqual({
    ok: true,
    value: undefined,
  });
});

test("a grant names the runner and the path, and the file comes back with its mode", async () => {
  const path = loginFile();
  unwrap(await grant({ [RUNNER]: path }));
  expect(await grantedLoginFor(t.db, RUNNER)).toEqual({
    ok: true,
    value: { path, value: VALUE, mode: 0o600 },
  });
});

test("a grant whose file is missing is refused, naming the setting, the runner and the path", async () => {
  const path = join(loginFile(), "..", "gone.json");
  unwrap(await grant({ [RUNNER]: path }));
  const out = await grantedLoginFor(t.db, RUNNER);
  expect(out).toMatchObject({ ok: false, error: { class: "validation" } });
  const message = out.ok ? "" : out.error.message;
  expect(message).toContain(LOGIN_IN_PLACE_KEY);
  expect(message).toContain(RUNNER);
  expect(message).toContain(path);
  expect(message).not.toContain("refresh_token");
});

test("a grant whose file anyone could read is refused", async () => {
  unwrap(await grant({ [RUNNER]: loginFile(0o644) }));
  expect(await grantedLoginFor(t.db, RUNNER)).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test.each([
  ["not a map", 1],
  ["a relative path", { [RUNNER]: "auth.json" }],
  ["a path with ..", { [RUNNER]: "/home/op/../op/auth.json" }],
  ["a runner id that is not one", { "Not An Id": "/tmp/auth.json" }],
])("a row that is %s is refused, never read as off", async (_what, value) => {
  unwrap(await grant(value));
  expect(await grantedLoginFor(t.db, RUNNER)).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("with a grant the runner's one-of credentials are no longer required", async () => {
  // Without it, an empty store is a refusal that names both alternatives and the other door.
  unwrap(await grant({}));
  const without = await resolveCredentials(ctx, RUNNER, config);
  expect(without).toMatchObject({ ok: false, error: { class: "validation" } });
  const why = without.ok ? "" : without.error.message;
  expect(why).toContain("A_KEY | A_LOGIN");
  expect(why).toContain(LOGIN_IN_PLACE_KEY);
  // With it, the grant is the credential and the spawn proceeds.
  const path = loginFile();
  unwrap(await grant({ [RUNNER]: path }));
  const credentials = unwrap(await resolveCredentials(ctx, RUNNER, config));
  expect(credentials).toEqual({
    secrets: [],
    granted: { path, value: VALUE, mode: 0o600 },
  });
  // And it never enters the child's environment.
  const env = buildEnv(ctx, "S1", config, paths, credentials);
  expect(JSON.stringify(env)).not.toContain("refresh_token");
});

test("a grant that cannot be used refuses, and never falls back to a store that holds the credential", async () => {
  const path = join(loginFile(), "..", "gone.json");
  unwrap(await grant({ [RUNNER]: path }));
  const out = await resolveCredentials(
    { ...ctx, secrets: envSecrets({ FRM_SECRET_A_KEY: "sk-in-the-store" }) },
    RUNNER,
    config,
  );
  expect(out).toMatchObject({ ok: false, error: { class: "validation" } });
  const message = out.ok ? "" : out.error.message;
  expect(message).toContain(LOGIN_IN_PLACE_KEY);
  expect(message).toContain(RUNNER);
  expect(message).toContain(path);
});

test("no grant: the store's first present alternative, alone, as before", async () => {
  unwrap(await grant({}));
  const store = envSecrets({
    FRM_SECRET_A_LOGIN: "login-in-the-store",
    FRM_SECRET_A_KEY: "sk-key",
  });
  expect(
    await resolveCredentials({ ...ctx, secrets: store }, RUNNER, config),
  ).toEqual({
    ok: true,
    value: { secrets: [["A_KEY", "sk-key"]], granted: undefined },
  });
});

test("a grant to a runner that cannot read one is refused at spawn, naming the setting and the runner, and its file is never read", async () => {
  // Unreadable on purpose: a read of it would fail with a different cause, so this one proves the
  // refusal came first. The store holds a copy of the one-of, and that is not used either.
  const path = loginFile(0o000);
  unwrap(await grant({ [RUNNER]: path }));
  const cannot: SessionConfig = { ...config, readsGrantedLogin: false };
  // A runner row that never mentions it, as most adapters' rows do not.
  const undeclared: SessionConfig = {
    input: {},
    flags: {},
    env: {},
    secretNames: [],
    secretAnyOf: config.secretAnyOf,
    hashInputs: [],
    baselineTokens: 0,
    toolAllowlist: [],
  };
  for (const names of [cannot, undeclared]) {
    const out = await resolveCredentials(
      { ...ctx, secrets: envSecrets({ FRM_SECRET_A_KEY: "sk-in-the-store" }) },
      RUNNER,
      names,
    );
    expect(out).toMatchObject({ ok: false, error: { class: "validation" } });
    const message = out.ok ? "" : out.error.message;
    expect(message).toContain(LOGIN_IN_PLACE_KEY);
    expect(message).toContain(RUNNER);
    expect(message).toContain("cannot read a login in place");
    expect(message).not.toContain("cannot be used");
    expect(JSON.stringify(out)).not.toContain("sk-in-the-store");
  }
});

test("a granted login is redacted from the session's records, as an env secret is", () => {
  const spec = {
    sessionId: "S1",
    cwd: "/w",
    homeDir: paths.home,
    env: { A_KEY: "" },
    model: "m",
    flags: {},
    grantedLogin: { path: "/op/auth.json", value: VALUE, mode: 0o600 },
  } satisfies SpawnSpec;
  expect(redactionList(spec, config)).toEqual([VALUE]);
});
