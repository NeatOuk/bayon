import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketDir } from "@bayon/executors";
import { afterEach, beforeEach, expect, test } from "vitest";
import { RELAY_SOCKET, trustedRelayPath } from "./relay-path.js";

// The API trusts the relay socket only in this user's own closed directory (M4).

let root: string;
let shortRoot: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "frm-relay-path-"));
  shortRoot = mkdtempSync("/tmp/frm-rp-");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(shortRoot, { recursive: true, force: true });
});

test("a short home: the socket in the home, as the default install has it", () => {
  const home = join(root, "h");
  mkdirSync(home);
  expect(trustedRelayPath(home)).toEqual({
    ok: true,
    value: join(home, RELAY_SOCKET),
  });
});

test("a long home: the short dir, once the supervisor made it this user's own", () => {
  const home = join(root, "x".repeat(150));
  const dir = socketDir(home, { root: shortRoot });
  expect(trustedRelayPath(home, { root: shortRoot }).ok).toBe(false);
  mkdirSync(dir, { mode: 0o700 });
  expect(trustedRelayPath(home, { root: shortRoot })).toEqual({
    ok: true,
    value: join(dir, RELAY_SOCKET),
  });
});

test("an open dir, or something that is not a socket at the path, turns the relay off", () => {
  const home = join(root, "y".repeat(150));
  const dir = socketDir(home, { root: shortRoot });
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, RELAY_SOCKET), "planted");
  expect(trustedRelayPath(home, { root: shortRoot }).ok).toBe(false);
  rmSync(join(dir, RELAY_SOCKET));
  chmodSync(dir, 0o777);
  const open = trustedRelayPath(home, { root: shortRoot });
  expect(open.ok).toBe(false);
  if (!open.ok) expect(open.error.message).toContain("open to others");
});
