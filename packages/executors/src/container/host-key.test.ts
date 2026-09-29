import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { pinKnownHosts } from "./host-key.js";

// Moved from tools/frm/src/executor.test.ts: pinKnownHosts is shared with
// POST /executors now, so its own test lives beside it, not owned by the CLI.

const dir = mkdtempSync(join(tmpdir(), "frm-host-key-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HOST = "192.0.2.10";

// A real key line, so ssh-keygen -F reads the file as it would the operator's.
execFileSync("ssh-keygen", [
  "-q",
  "-t",
  "ed25519",
  "-N",
  "",
  "-f",
  join(dir, "k"),
]);
const pub = readFileSync(join(dir, "k.pub"), "utf8")
  .split(" ")
  .slice(0, 2)
  .join(" ");
const operatorKnownHosts = join(dir, "known_hosts");
writeFileSync(
  operatorKnownHosts,
  [
    `other.example.com ${pub}`,
    `${HOST} ${pub}`,
    `[${HOST}]:2222 ${pub}`,
    "",
  ].join("\n"),
);

function unwrapOk<T>(
  r: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("pinKnownHosts", () => {
  test("copies only that host's entry, 0600 in a 0700 directory", () => {
    const to = join(dir, "home", "executors", "ctr-lab", "known_hosts");
    expect(
      pinKnownHosts({ from: operatorKnownHosts, host: HOST, port: 22, to }),
    ).toEqual({
      ok: true,
      value: 1,
    });
    expect(readFileSync(to, "utf8")).toBe(`${HOST} ${pub}\n`);
    expect(statSync(to).mode & 0o777).toBe(0o600);
    expect(statSync(join(to, "..")).mode & 0o777).toBe(0o700);
  });

  test("a non-default port is looked up as [host]:port", () => {
    const to = join(dir, "port", "known_hosts");
    unwrapOk(
      pinKnownHosts({ from: operatorKnownHosts, host: HOST, port: 2222, to }),
    );
    expect(readFileSync(to, "utf8")).toBe(`[${HOST}]:2222 ${pub}\n`);
  });

  test("a host the operator never pinned is refused, and nothing is written", () => {
    const to = join(dir, "none", "known_hosts");
    const pinned = pinKnownHosts({
      from: operatorKnownHosts,
      host: "10.9.9.9",
      port: 22,
      to,
    });
    expect(pinned.ok ? "pinned" : pinned.error.message).toContain(
      "frm never scans host keys",
    );
    expect(existsSync(to)).toBe(false);
  });
});
