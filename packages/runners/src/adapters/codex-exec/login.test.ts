// Returning the operator's login (§14), on real files. Every refusal is checked the only
// way that means anything: the granted file is compared byte for byte, and its mtime with it. Only
// the session's own rotation goes back: `known` is the login the process was handed, or
// the one it last returned, and a home copy still equal to it leaves the file alone.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AUTH_FILE } from "./home.js";
import {
  LOGIN_WARNING,
  loginReturner,
  returnLogin,
  writeBackRefusal,
} from "./login.js";

const GRANTED =
  '{"OPENAI_API_KEY":null,"tokens":{"refresh_token":"r-1","id_token":"i-1"},"last_refresh":"2026-09-15T00:00:00Z"}';
const ROTATED =
  '{"OPENAI_API_KEY":null,"tokens":{"refresh_token":"r-2","id_token":"i-2"},"last_refresh":"2026-09-21T00:00:00Z"}';
/** The operator's own CLI's rotation, made outside the session. As long as ROTATED, so it would pass. */
const OPERATOR_ROTATED =
  '{"OPENAI_API_KEY":null,"tokens":{"refresh_token":"r-9","id_token":"i-9"},"last_refresh":"2026-09-22T00:00:00Z"}';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A granted login on disk and a session home, optionally holding a copy. */
function stage(copy?: string): { path: string; homeDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-login-back-")));
  roots.push(root);
  const path = join(root, "auth.json");
  writeFileSync(path, GRANTED, { mode: 0o600 });
  chmodSync(path, 0o600);
  const homeDir = join(root, "home");
  if (copy !== undefined) {
    mkdirSync(dirname(join(homeDir, AUTH_FILE)), { recursive: true });
    writeFileSync(join(homeDir, AUTH_FILE), copy, { mode: 0o600 });
  }
  return { path, homeDir };
}

const state = (path: string) => ({
  text: readFileSync(path, "utf8"),
  mtime: statSync(path, { bigint: true }).mtimeNs,
});

/** The operator's CLI rewrites their own file, as a refresh does, while the session runs. */
function rotateOutside(path: string, text = OPERATOR_ROTATED): void {
  writeFileSync(path, text, { mode: 0o600 });
}

test("a rotated copy replaces the granted file, mode kept", () => {
  const { path, homeDir } = stage(ROTATED);
  expect(returnLogin(homeDir, path, GRANTED)).toEqual({
    ok: true,
    value: { kind: "written", path },
  });
  expect(readFileSync(path, "utf8")).toBe(ROTATED);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test.each([
  ["truncated mid-token", ROTATED.slice(0, 40)],
  ["not JSON at all", "<html>502</html>"],
  ["an array", "[1,2,3]"],
  ["null", "null"],
  [
    "missing a key it had",
    '{"tokens":{"refresh_token":"r-2"},"pad":"'.padEnd(
      GRANTED.length + 10,
      "x",
    ) + '"}',
  ],
  [
    "shorter than what it replaces",
    '{"OPENAI_API_KEY":null,"tokens":{},"last_refresh":""}',
  ],
])("a copy that is %s leaves the granted file byte for byte", (_what, copy) => {
  const { path, homeDir } = stage(copy);
  const before = state(path);
  const out = returnLogin(homeDir, path, GRANTED);
  expect(out).toMatchObject({ ok: true, value: { kind: "refused" } });
  expect(state(path)).toEqual(before);
});

test("a copy still equal to what was placed is a no-op: the granted file is not even read", () => {
  const { path, homeDir } = stage(GRANTED);
  // Unreadable on purpose: a read of it would fail, so success is the proof it was not read.
  chmodSync(path, 0o000);
  expect(returnLogin(homeDir, path, GRANTED)).toEqual({
    ok: true,
    value: { kind: "unchanged", reason: "not-rotated" },
  });
  chmodSync(path, 0o600);
  expect(readFileSync(path, "utf8")).toBe(GRANTED);
});

test("a copy the file already holds is a no-op: nothing is written", () => {
  const { path, homeDir } = stage(ROTATED);
  rotateOutside(path, ROTATED);
  const before = state(path);
  expect(returnLogin(homeDir, path, GRANTED)).toEqual({
    ok: true,
    value: { kind: "unchanged", reason: "same" },
  });
  expect(state(path)).toEqual(before);
});

//, the bug: the session was handed GRANTED and never refreshed; the operator's own CLI
// then rotated their file. The session's copy is well formed and no shorter, so the old check let
// it overwrite the newer login with a refresh token the provider had already consumed.
test("a session that rotated nothing never overwrites a rotation the operator's CLI made", () => {
  const { path, homeDir } = stage(GRANTED);
  rotateOutside(path);
  const before = state(path);
  expect(returnLogin(homeDir, path, GRANTED)).toEqual({
    ok: true,
    value: { kind: "unchanged", reason: "not-rotated" },
  });
  expect(state(path)).toEqual(before);
  expect(readFileSync(path, "utf8")).toBe(OPERATOR_ROTATED);
});

test("a session that did rotate still returns its rotation", () => {
  const { path, homeDir } = stage(ROTATED);
  expect(returnLogin(homeDir, path, GRANTED)).toEqual({
    ok: true,
    value: { kind: "written", path },
  });
  expect(readFileSync(path, "utf8")).toBe(ROTATED);
});

// The race §14 concedes: the session and the operator's CLI both refreshed from GRANTED. This
// process did rotate, so its copy is judged against the operator's like any rotation: both are
// well formed and the same length here, so the session's replaces the operator's.
test("both rotated from the same login: the session's copy, validated, replaces the operator's (§14's conceded race)", () => {
  const { path, homeDir } = stage(ROTATED);
  rotateOutside(path);
  expect(returnLogin(homeDir, path, GRANTED)).toEqual({
    ok: true,
    value: { kind: "written", path },
  });
  expect(readFileSync(path, "utf8")).toBe(ROTATED);
});

test("once a process has returned its rotation, a later rotation by the operator's CLI is left alone", () => {
  const { path, homeDir } = stage(ROTATED);
  const returnOnce = loginReturner(homeDir, path, GRANTED);
  expect(returnOnce()).toEqual({ kind: "written", path });
  expect(readFileSync(path, "utf8")).toBe(ROTATED);
  // The home still holds ROTATED — already given back — when the operator's CLI rotates again.
  rotateOutside(path);
  const before = state(path);
  expect(returnOnce()).toEqual({ kind: "unchanged", reason: "not-rotated" });
  expect(state(path)).toEqual(before);
  expect(readFileSync(path, "utf8")).toBe(OPERATOR_ROTATED);
});

test("no copy in the home (the host unlinked it, or no login) is a no-op", () => {
  const { path, homeDir } = stage();
  const before = state(path);
  expect(returnLogin(homeDir, path, GRANTED)).toEqual({
    ok: true,
    value: { kind: "unchanged", reason: "no-copy" },
  });
  expect(state(path)).toEqual(before);
});

test("a granted file that has gone is never recreated", () => {
  const { path, homeDir } = stage(ROTATED);
  rmSync(path);
  expect(returnLogin(homeDir, path, GRANTED)).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect(() => statSync(path)).toThrow();
});

test("writeBackRefusal is pure and quotes neither value", () => {
  expect(writeBackRefusal(GRANTED, ROTATED)).toBeNull();
  // The three conditions §14 names, each on its own: a lost field, a shorter file, and not JSON.
  expect(
    writeBackRefusal('{"a":1,"b":2}', '{"a":1,"cccccccccccccc":"x"}'),
  ).toContain("every field");
  expect(writeBackRefusal('{"a":1,"b":22222}', '{"a":1,"b":2}')).toContain(
    "shorter",
  );
  expect(writeBackRefusal('{"a":1}', '"a string"')).toContain("JSON object");
  for (const bad of ["[]", "x", GRANTED.slice(0, 20)]) {
    const why = writeBackRefusal(GRANTED, bad);
    expect(why).not.toBeNull();
    expect(why ?? "").not.toContain("r-1");
    expect(why ?? "").not.toContain("r-2");
  }
});

test("a refusal is warned about, naming the path and no credential", async () => {
  const { path, homeDir } = stage("[]");
  const warned = new Promise<Error>((resolve) => {
    process.once("warning", resolve);
  });
  expect(loginReturner(homeDir, path, GRANTED)()).toMatchObject({
    kind: "refused",
  });
  const warning = await warned;
  expect(warning.name).toBe(LOGIN_WARNING);
  expect(warning.message).toContain(path);
  expect(warning.message).not.toContain("r-1");
});

test("a write-back that succeeds warns about nothing", async () => {
  const { path, homeDir } = stage(ROTATED);
  const warnings: Error[] = [];
  const listener = (w: Error) => warnings.push(w);
  process.on("warning", listener);
  try {
    expect(loginReturner(homeDir, path, GRANTED)()).toMatchObject({
      kind: "written",
    });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("warning", listener);
  }
  expect(warnings.filter((w) => w.name === LOGIN_WARNING)).toEqual([]);
});
