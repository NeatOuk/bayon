import { randomBytes } from "node:crypto";
import {
  chmodSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@bayon/core";

// The host-only key the GUI's proxy sends to say "this browser is on the host" (§14 amendment,
//): 32 random bytes, hex, in `$FRM_HOME/local-browser.key`, mode 0600. Written once at the
// API's boot, atomically (a 0600 temp file renamed into place), and reused while it is well formed,
// so the dev proxy may read it whenever it starts. Only a process that can read the operator's
// FRM_HOME knows it; the production edge never reads it and strips the header.

export const LOCAL_KEY_FILE = "local-browser.key";
const KEY = /^[0-9a-f]{64}$/;

function readKey(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    return KEY.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** The key under `frmHome`, created if missing or malformed. */
export function ensureLocalKey(frmHome: string): Result<string> {
  const path = join(frmHome, LOCAL_KEY_FILE);
  try {
    const existing = readKey(path);
    if (existing !== null) {
      chmodSync(path, 0o600);
      return ok(existing);
    }
    const key = randomBytes(32).toString("hex");
    const temp = `${path}.${process.pid}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, `${key}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    return ok(key);
  } catch (e) {
    return err({
      class: "internal",
      message: `could not write ${path}: ${e instanceof Error ? e.message : String(e)}`,
      retryable: false,
    });
  }
}
