import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { unwrap } from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test } from "vitest";
import { SOCKET_PATH_MAX_BYTES, openControlSocket } from "./socket.js";

// Short on purpose: unix socket paths are capped at 104 bytes.
const dir = mkdtempSync("/tmp/frm-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const log = pino({ level: "silent" });

/** Sends one line, resolves with the first line of the reply. */
function request(path: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(path);
    let buffer = "";
    conn.on("error", reject);
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        conn.end();
        resolve(buffer.slice(0, nl));
      }
    });
    conn.write(line);
  });
}

test("listens at mode 0600; a wake op calls onWake; junk gets an error", async () => {
  const path = join(dir, "a.sock");
  let wakes = 0;
  const socket = unwrap(
    await openControlSocket({ path, log, onWake: () => (wakes += 1) }),
  );
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await request(path, '{"op":"wake"}\n'))).toEqual({
    ok: true,
  });
  expect(wakes).toBe(1);
  const junk = JSON.parse(await request(path, "not json\n")) as {
    ok: boolean;
    error: { class: string };
  };
  expect(junk).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(wakes).toBe(1);
  await socket.close();
  expect(existsSync(path)).toBe(false);
});

test("a stale socket left by a killed process is replaced", async () => {
  const path = join(dir, "b.sock");
  const script =
    "require('net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))";
  const child = spawnSync(process.execPath, ["-e", script, path]);
  expect(child.signal).toBe("SIGKILL");
  expect(lstatSync(path).isSocket()).toBe(true);
  let wakes = 0;
  const socket = unwrap(
    await openControlSocket({ path, log, onWake: () => (wakes += 1) }),
  );
  await request(path, '{"op":"wake"}\n');
  expect(wakes).toBe(1);
  await socket.close();
});

test("a live socket is never replaced: a second supervisor is refused", async () => {
  const path = join(dir, "c.sock");
  let wakes = 0;
  const first = unwrap(
    await openControlSocket({ path, log, onWake: () => (wakes += 1) }),
  );
  const second = await openControlSocket({ path, log, onWake: () => {} });
  expect(second.ok ? null : second.error.class).toBe("conflict");
  await request(path, '{"op":"wake"}\n');
  expect(wakes).toBe(1);
  await first.close();
});

test("a regular file at the socket path is left alone", async () => {
  const path = join(dir, "d.sock");
  writeFileSync(path, "precious");
  const opened = await openControlSocket({ path, log, onWake: () => {} });
  expect(opened.ok ? null : opened.error.class).toBe("conflict");
  expect(readFileSync(path, "utf8")).toBe("precious");
});

test("a path over the 104-byte limit fails loudly, creating nothing", async () => {
  const path = join(dir, `${"x".repeat(SOCKET_PATH_MAX_BYTES)}.sock`);
  const opened = await openControlSocket({ path, log, onWake: () => {} });
  expect(opened.ok).toBe(false);
  if (opened.ok) return;
  expect(opened.error.class).toBe("validation");
  expect(opened.error.message).toContain("104");
  expect(existsSync(path)).toBe(false);
});
