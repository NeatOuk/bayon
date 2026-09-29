import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { LOCAL_KEY_FILE, ensureLocalKey } from "./local-key.js";

// The host-only key (§14 amendment): 32 random bytes as hex, 0600, written once and
// reused, so the GUI's proxy can read it whenever it starts.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "frm-key-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const file = () => join(home, LOCAL_KEY_FILE);

test("writes a 64-hex key, readable by the owner only", () => {
  const key = ensureLocalKey(home);
  expect(key.ok && /^[0-9a-f]{64}$/.test(key.value)).toBe(true);
  expect(readFileSync(file(), "utf8").trim()).toBe(key.ok ? key.value : "");
  expect(statSync(file()).mode & 0o777).toBe(0o600);
});

test("reuses the key already there, and tightens its mode", () => {
  const first = ensureLocalKey(home);
  chmodSync(file(), 0o644);
  const second = ensureLocalKey(home);
  expect(second).toEqual(first);
  expect(statSync(file()).mode & 0o777).toBe(0o600);
});

test("a malformed key is replaced", () => {
  writeFileSync(file(), "not a key\n");
  const key = ensureLocalKey(home);
  expect(key.ok && key.value !== "not a key").toBe(true);
  expect(readFileSync(file(), "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
});

test("a home that cannot be written is an error, never a key", () => {
  expect(ensureLocalKey(join(home, "missing", "deeper")).ok).toBe(false);
});
