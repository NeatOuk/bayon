import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import type { SshTarget } from "./ssh.js";
import { backoffMs, McpTunnel, tunnelArgs } from "./tunnel.js";

// Real ssh stand-ins restarted with backoff: more than the default 5 s on a loaded host. It must
// also stay above WAIT below — at 5 s the test died before waitFor's own 10 s budget could report
// what never happened, so a genuine hang and a busy machine looked identical.
vi.setConfig({ testTimeout: 30_000 });

const dir = mkdtempSync(join(tmpdir(), "frm-tunnel-"));
const bin = join(dir, "bin");
mkdirSync(bin);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TARGET: SshTarget = {
  host: "192.0.2.10",
  port: 22,
  user: "ops",
  knownHosts: "/frm/executors/ctr-lab/known_hosts",
  identity: { kind: "file", path: "/keys/id" },
  controlPath: "/tmp/frm-501/abc.sock",
};
const SOCKET = "/home/ops/frm/run/mcp.sock";
const API = { host: "127.0.0.1", port: 3010 };
const WAIT = { timeout: 10_000, interval: 10 };

test("its own connection, pinned, failing when the forward cannot bind", () => {
  const args = tunnelArgs(TARGET, SOCKET, API);
  const options = args.flatMap((a, i) => (args[i - 1] === "-o" ? [a] : []));
  for (const option of [
    "BatchMode=yes",
    "StrictHostKeyChecking=yes",
    "UserKnownHostsFile=/frm/executors/ctr-lab/known_hosts",
    "GlobalKnownHostsFile=/dev/null",
    "ControlPath=none",
    "ControlMaster=no",
    "ExitOnForwardFailure=yes",
    "IdentitiesOnly=yes",
  ]) {
    expect(options).toContain(option);
  }
  expect(args).toContain("-N");
  expect(args).toContain("-a");
  expect(args.slice(-3)).toEqual([
    "-R",
    "/home/ops/frm/run/mcp.sock:127.0.0.1:3010",
    "ops@192.0.2.10",
  ]);
  expect(() => tunnelArgs(TARGET, SOCKET, { host: "a b", port: 1 })).toThrow(
    /tunnel target/,
  );
});

test("backoff doubles from 1 s and stops at 60 s", () => {
  expect([0, 1, 2, 3, 5, 6, 7, 40].map((n) => backoffMs(n))).toEqual([
    1_000, 2_000, 4_000, 8_000, 32_000, 60_000, 60_000, 60_000,
  ]);
});

/** A stand-in ssh: records each start, then stays up (FAKE_STAY) or fails at once. */
function fakeSsh(): { log: string; env: Record<string, string> } {
  const log = join(dir, `starts-${Math.random().toString(16).slice(2)}`);
  writeFileSync(
    join(bin, "ssh"),
    '#!/bin/sh\necho start >> "$FAKE_LOG"\n[ -n "$FAKE_STAY" ] && exec sleep 30\nexit 255\n',
  );
  chmodSync(join(bin, "ssh"), 0o755);
  writeFileSync(log, "");
  return { log, env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_LOG: log } };
}
const starts = (log: string) =>
  readFileSync(log, "utf8").split("\n").filter(Boolean).length;

test("a tunnel that fails is restarted with backoff, the stale socket reset first; stop ends it", async () => {
  const ssh = fakeSsh();
  let resets = 0;
  const tunnel = new McpTunnel({
    target: TARGET,
    env: ssh.env,
    socket: SOCKET,
    api: API,
    log: join(dir, "logs", "tunnel.log"),
    reset: async () => {
      resets += 1;
    },
    backoff: { minMs: 20, maxMs: 80, stableMs: 60_000 },
  });
  tunnel.start();
  await vi.waitFor(
    () => expect(starts(ssh.log)).toBeGreaterThanOrEqual(4),
    WAIT,
  );
  expect(resets).toBeGreaterThanOrEqual(4);
  tunnel.stop();
  const stopped = starts(ssh.log);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(starts(ssh.log)).toBeLessThanOrEqual(stopped + 1);
  expect(tunnel.state()).toBe("down");
});

test("a live tunnel is up; killed, it is down until its restart brings it back", async () => {
  const ssh = fakeSsh();
  const tunnel = new McpTunnel({
    target: TARGET,
    env: { ...ssh.env, FAKE_STAY: "1" },
    socket: SOCKET,
    api: API,
    log: join(dir, "logs", "tunnel.log"),
    reset: async () => undefined,
    backoff: { minMs: 200, maxMs: 200, stableMs: 60_000 },
  });
  tunnel.start();
  tunnel.start();
  await vi.waitFor(() => {
    expect(tunnel.state()).toBe("up");
    expect(starts(ssh.log)).toBe(1);
  }, WAIT);
  const pid = tunnel.pid();
  expect(pid).not.toBeNull();
  process.kill(pid ?? 0, "SIGKILL");
  await vi.waitFor(() => expect(tunnel.state()).toBe("down"), WAIT);
  await vi.waitFor(() => {
    expect(tunnel.state()).toBe("up");
    expect(tunnel.pid()).not.toBe(pid);
    expect(starts(ssh.log)).toBe(2);
  }, WAIT);
  tunnel.stop();
  expect(tunnel.state()).toBe("down");
});
