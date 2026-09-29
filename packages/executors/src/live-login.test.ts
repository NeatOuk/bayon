// The live-login reader and writer (§14) against real files in a real temp directory.
// The differential that matters: this kind requires the owner's write bit, where the secret-store
// reader next door refuses it — and neither ever puts a byte of a value in an error.
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  MAX_LOGIN_BYTES,
  readLiveLogin,
  writeLiveLogin,
} from "./live-login.js";
import { readSecretFile } from "./secret-file.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const VALUE = '{"tokens":{"refresh_token":"r-1"},"last_refresh":"2026-09-20"}';

function login(content = VALUE, mode = 0o600): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "frm-login-")));
  dirs.push(dir);
  const path = join(dir, "auth.json");
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}

test("a 0600 file reads verbatim, with the mode it was found at", () => {
  const path = login();
  expect(readLiveLogin(path)).toEqual({
    ok: true,
    value: { text: VALUE, mode: 0o600 },
  });
});

test("the write bit is required here and refused by the secret store: two kinds, not one", () => {
  const path = login(VALUE, 0o400);
  const live = readLiveLogin(path);
  expect(live).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(live.ok ? "" : live.error.message).toContain("writable by its owner");
  // The same file is exactly what the secret store wants: a secret nothing can rewrite.
  expect(readSecretFile(path)).toEqual({ ok: true, value: VALUE });
});

test.each([
  ["group-readable", 0o640],
  ["world-readable", 0o604],
  ["world-writable", 0o606],
])("a %s login is refused", (_what, mode) => {
  expect(readLiveLogin(login(VALUE, mode))).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("a symlink is refused rather than followed", () => {
  const path = login();
  const link = join(dirs[0] ?? "", "link.json");
  symlinkSync(path, link);
  const read = readLiveLogin(link);
  expect(read).toMatchObject({ ok: false });
  expect(read.ok ? "" : read.error.message).toContain("symbolic link");
});

test.each([
  ["missing", () => join(login(), "..", "nothing.json")],
  ["a directory", () => join(login(), "..")],
  ["empty", () => login("", 0o600)],
  ["oversized", () => login("x".repeat(MAX_LOGIN_BYTES + 1), 0o600)],
  ["relative", () => "auth.json"],
])("%s is refused, naming the path and nothing else", (_what, make) => {
  const read = readLiveLogin(make());
  expect(read).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(read.ok ? "" : read.error.message).not.toContain("refresh_token");
});

test("a write replaces the file atomically, keeps its mode and leaves no temp behind", () => {
  const path = login();
  const next = `${VALUE.slice(0, -1)},"added":"y"}`;
  expect(writeLiveLogin(path, next, 0o600)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(readFileSync(path, "utf8")).toBe(next);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(path, ".."))).toEqual(["auth.json"]);
});

test("a write to a path with no file creates nothing", () => {
  const path = join(login(), "..", "absent.json");
  expect(writeLiveLogin(path, VALUE, 0o600)).toMatchObject({ ok: false });
  expect(readdirSync(join(path, ".."))).toEqual(["auth.json"]);
});

test("an empty or oversized write is refused and the file is untouched", () => {
  const path = login();
  for (const bad of ["", "x".repeat(MAX_LOGIN_BYTES + 1)]) {
    expect(writeLiveLogin(path, bad, 0o600)).toMatchObject({ ok: false });
  }
  expect(readFileSync(path, "utf8")).toBe(VALUE);
});

test("a FIFO is refused at once, never waited on: the open does not block for a writer", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "frm-login-")));
  dirs.push(dir);
  const path = join(dir, "auth.json");
  execFileSync("mkfifo", ["-m", "600", path]);
  // Without O_NONBLOCK this open would hang the test (and the supervisor's event loop) forever.
  const out = readLiveLogin(path);
  expect(out).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(out.ok ? "" : out.error.message).toContain("not a regular file");
});

test("a file owned by another user is refused, naming the path and never a byte of it", () => {
  const path = login();
  const me = process.getuid?.() ?? 0;
  const out = readLiveLogin(path, me + 1);
  expect(out).toMatchObject({ ok: false, error: { class: "validation" } });
  const message = out.ok ? "" : out.error.message;
  expect(message).toContain(path);
  expect(message).toContain("owned by");
  expect(JSON.stringify(out)).not.toContain("refresh_token");
  // The same file, as its real owner reads it, passes.
  expect(readLiveLogin(path, me)).toMatchObject({ ok: true });
});
