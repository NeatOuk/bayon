// A container executor's host key, pinned once and only from a file the operator already trusts
// (moved out of tools/frm/src/executor.ts for, so `frm executor add` and
// `POST /executors` call one implementation, never two that can drift). No network call happens
// here, ever: this reads a local known_hosts file and nothing else.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import { z } from "zod";

/** A container executor's id: `frm executor add`'s own shape, shared with the API's writer. */
export const EXECUTOR_ID = /^[a-z0-9-]{1,32}$/;

/**
 * Copies `host`'s entries from the operator's known_hosts (`from`, already pinned by a verified
 * first connection) into `to` (0600, its directory 0700). Never scans: an absent host is refused.
 */
export function pinKnownHosts(o: {
  readonly from: string;
  readonly host: string;
  readonly port: number;
  readonly to: string;
}): Result<number> {
  const entry = o.port === 22 ? o.host : `[${o.host}]:${o.port}`;
  let found = "";
  try {
    found = execFileSync("ssh-keygen", ["-F", entry, "-f", o.from], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    // ssh-keygen -F exits 1 when the host is not in the file; anything else is a real failure.
    const status = z.object({ status: z.number() }).safeParse(e);
    if (!status.success || status.data.status !== 1) {
      return err({
        class: "internal",
        message: `ssh-keygen -F ${entry} -f ${o.from} failed: ${e instanceof Error ? e.message : String(e)}`,
        retryable: false,
      });
    }
  }
  const keys = found
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
  if (keys.length === 0) {
    return err({
      class: "validation",
      message: `${entry} is not in ${o.from}: connect once with ssh and check its fingerprint first (frm never scans host keys)`,
      retryable: false,
    });
  }
  mkdirSync(dirname(o.to), { recursive: true, mode: 0o700 });
  writeFileSync(o.to, `${keys.join("\n")}\n`, { mode: 0o600 });
  chmodSync(o.to, 0o600);
  return ok(keys.length);
}
