import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  LONGEST_SOCKET_NAME_BYTES,
  SOCKET_PATH_MAX_BYTES,
  darwinUserTempDir,
  ensureSocketDir,
  socketDir,
  socketsFit,
  verifySocketDir,
  verifySocketFile,
} from "./socket-dir.js";

// A unix socket path must fit in 104 bytes (macOS). A home too long for its sockets gets a short,
// private directory derived from the home alone, so the API finds the supervisor's relay socket.

let root: string;
let shortRoot: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "frm-sockdir-"));
  // Not $TMPDIR: a short root of our own for the fallback directories.
  shortRoot = mkdtempSync("/tmp/frm-sd-");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(shortRoot, { recursive: true, force: true });
});

const longHome = () => join(root, "x".repeat(150));

describe("socketDir", () => {
  test("a short home keeps its sockets in the home, as the default install does", () => {
    const home = join(root, "h");
    expect(socketDir(home)).toBe(home);
    expect(socketDir("/Users/someone/.foreman")).toBe(
      "/Users/someone/.foreman",
    );
  });

  test("a home too long for its longest socket gets a short dir, stable, one per home", () => {
    const home = longHome();
    const dir = socketDir(home, { root: shortRoot });
    expect(dir.startsWith(`${shortRoot}/frm-`)).toBe(true);
    expect(dir).toMatch(/\/frm-\d+-[0-9a-f]{12}$/);
    expect(
      Buffer.byteLength(join(dir, "x".repeat(LONGEST_SOCKET_NAME_BYTES))),
    ).toBeLessThan(SOCKET_PATH_MAX_BYTES);
    expect(socketDir(home, { root: shortRoot })).toBe(dir);
    expect(socketDir(`${home}y`, { root: shortRoot })).not.toBe(dir);
  });

  test("the same dir before and after the home is created, through a symlinked parent", () => {
    const linked = join(root, "link");
    symlinkSync(root, linked);
    const home = join(linked, "y".repeat(150));
    const before = socketDir(home, { root: shortRoot });
    mkdirSync(home);
    expect(socketDir(home, { root: shortRoot })).toBe(before);
    expect(socketDir(join(root, "y".repeat(150)), { root: shortRoot })).toBe(
      before,
    );
  });

  test("the default base: the account's own temp dir on macOS, else /tmp; never $TMPDIR", () => {
    const own = darwinUserTempDir();
    const dir = socketDir(longHome());
    if (process.platform === "darwin") {
      expect(own).not.toBeNull();
      expect(dir).toBe(join(own ?? "", dir.slice((own ?? "").length + 1)));
      expect(dir).toMatch(/\/frm-[0-9a-f]{12}$/);
      expect(lstatSync(own ?? "").mode & 0o077).toBe(0);
    } else {
      expect(dir).toMatch(/^\/tmp\/frm-\d+-[0-9a-f]{12}$/);
    }
    expect(socketsFit(dir)).toBe(true);
  });

  test("measured at the real path too: a short link to a long home moves", () => {
    const long = longHome();
    mkdirSync(long);
    const link = join(shortRoot, "l");
    symlinkSync(long, link);
    expect(socketsFit(link)).toBe(true);
    expect(socketDir(link, { root: shortRoot })).not.toBe(link);
  });

  test("the boundary: the home whose longest socket just fits stays; one byte more moves", () => {
    const fits = SOCKET_PATH_MAX_BYTES - 2 - LONGEST_SOCKET_NAME_BYTES;
    const base = "/a/";
    const exact = base + "b".repeat(fits - base.length);
    expect(socketDir(exact, { root: shortRoot })).toBe(exact);
    expect(socketDir(`${exact}c`, { root: shortRoot })).not.toBe(`${exact}c`);
  });
});

describe("ensureSocketDir", () => {
  test("the home itself: nothing to do", () => {
    const home = join(root, "h");
    mkdirSync(home);
    expect(ensureSocketDir(home, home)).toEqual({ ok: true, value: undefined });
  });

  test("creates the short dir 0700, and accepts it again", () => {
    const home = longHome();
    const dir = socketDir(home, { root: shortRoot });
    expect(ensureSocketDir(dir, home).ok).toBe(true);
    const st = lstatSync(dir);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
    expect(ensureSocketDir(dir, home).ok).toBe(true);
  });

  test("a symlink in its place is refused, in plain words", () => {
    const home = longHome();
    const dir = socketDir(home, { root: shortRoot });
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, dir);
    const refused = ensureSocketDir(dir, home);
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(refused.error.message).toMatch(/not a directory of its own/);
  });

  test("a dir others can open is refused", () => {
    const home = longHome();
    const dir = socketDir(home, { root: shortRoot });
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const refused = ensureSocketDir(dir, home);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/0755/);
  });
});

describe("verifySocketDir and verifySocketFile: read-only, for the API", () => {
  test("the home itself passes; a missing short dir does not, and nothing is created", () => {
    const home = longHome();
    expect(verifySocketDir(home, home).ok).toBe(true);
    const dir = socketDir(home, { root: shortRoot });
    expect(verifySocketDir(dir, home).ok).toBe(false);
    expect(() => lstatSync(dir)).toThrow();
  });

  test("this user's 0700 dir passes; an open one or a symlink is refused", () => {
    const home = longHome();
    const dir = socketDir(home, { root: shortRoot });
    mkdirSync(dir, { mode: 0o700 });
    expect(verifySocketDir(dir, home).ok).toBe(true);
    chmodSync(dir, 0o750);
    expect(verifySocketDir(dir, home).ok).toBe(false);
    rmSync(dir, { recursive: true });
    mkdirSync(join(root, "real"), { mode: 0o700 });
    symlinkSync(join(root, "real"), dir);
    expect(verifySocketDir(dir, home).ok).toBe(false);
  });

  test("a socket file: absent passes, this user's socket passes, a plain file is refused", async () => {
    const path = join(shortRoot, "r.sock");
    expect(verifySocketFile(path).ok).toBe(true);
    const server = createServer();
    await new Promise<void>((r) => server.listen(path, r));
    try {
      expect(verifySocketFile(path).ok).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
    writeFileSync(path, "not a socket");
    expect(verifySocketFile(path).ok).toBe(false);
  });
});
