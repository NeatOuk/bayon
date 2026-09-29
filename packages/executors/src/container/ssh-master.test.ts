// The owned ControlMaster's lifecycle against a stand-in ssh: masters sleep,
// `-O check` succeeds while the master lives, clients run their command with the local shell.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { SshTransport } from "./ssh.js";
import { runRemote } from "./transport.js";

const WAIT = { timeout: 5_000, interval: 20 };
const home = mkdtempSync(join(tmpdir(), "frm-ssh-master-"));
const key = join(home, "id");
const knownHosts = join(home, "known_hosts");
writeFileSync(key, "k", { mode: 0o600 });
writeFileSync(knownHosts, "h ssh-ed25519 AAAA\n");

/** A stand-in ssh whose master either lives (`sleep`) or fails with `failure` on stderr. */
function standIn(
  name: string,
  failure?: string,
): { path: string; state: string } {
  const bin = join(home, name, "bin");
  const state = join(home, name, "state");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  const master =
    failure === undefined
      ? `echo $$ > ${state}/master; exec sleep 600`
      : `echo "${failure}" >&2; exit 255`;
  writeFileSync(
    join(bin, "ssh"),
    `#!/bin/sh
mode=client; op=""; cmd=""
while [ $# -gt 0 ]; do
  case "$1" in
    -M) mode=master; shift;;
    -O) mode=control; op="$2"; shift 2;;
    --) cmd="$2"; break;;
    -F|-o|-i|-p) shift 2;;
    *) shift;;
  esac
done
pid=$(cat ${state}/master 2>/dev/null)
case "$mode" in
  master) ${master};;
  control)
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || exit 255
    [ "$op" = exit ] && { kill "$pid"; rm -f ${state}/master; }
    exit 0;;
  *)
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || { echo "Control socket connect: no master" >&2; exit 255; }
    exec /bin/sh -c "$cmd";;
esac
`,
  );
  chmodSync(join(bin, "ssh"), 0o755);
  return { path: `${bin}:/usr/bin:/bin`, state };
}

const masterPid = (state: string): number | null => {
  const file = join(state, "master");
  return existsSync(file) ? Number(readFileSync(file, "utf8")) : null;
};
const alive = (pid: number | null): boolean => {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function transport(path: string, persistMs = 60_000): SshTransport {
  return new SshTransport({
    executorId: "ctr-t",
    frmHome: join(home, path.split(":")[0] ?? ""),
    ssh: {
      host: "h",
      port: 22,
      user: "frm",
      identity_ref: `file:${key}`,
      known_hosts: knownHosts,
      control_persist_ms: persistMs,
      max_channels: 2,
    },
    path,
  });
}

const run = (t: SshTransport, command: string) =>
  runRemote(t, command, { what: command, signal: AbortSignal.timeout(10_000) });

const spawned: string[] = [];
afterAll(() => {
  for (const state of spawned) {
    const pid = masterPid(state);
    if (alive(pid) && pid !== null) process.kill(pid, "SIGKILL");
  }
  rmSync(home, { recursive: true, force: true });
});

describe("the owned ControlMaster", { timeout: 20_000 }, () => {
  test("one master carries every call; a dead one is replaced before the next", async () => {
    const { path, state } = standIn("live");
    spawned.push(state);
    const t = transport(path);
    expect(await run(t, "echo hi")).toMatchObject({ code: 0, stdout: "hi\n" });
    const first = masterPid(state);
    expect(alive(first)).toBe(true);
    expect(await run(t, "exit 3")).toMatchObject({ code: 3 });
    expect(masterPid(state)).toBe(first);
    if (first !== null) process.kill(first, "SIGKILL");
    await vi.waitFor(() => expect(alive(first)).toBe(false), WAIT);
    expect(await run(t, "echo again")).toMatchObject({ stdout: "again\n" });
    const second = masterPid(state);
    expect(second).not.toBe(first);
    expect(alive(second)).toBe(true);
    expect(t.rttMs()).toEqual(expect.any(Number));
    await t.close(AbortSignal.timeout(5_000));
    await vi.waitFor(() => expect(alive(second)).toBe(false), WAIT);
  });

  test("an idle master closes after control_persist_ms", async () => {
    const { path, state } = standIn("idle");
    spawned.push(state);
    const t = transport(path, 200);
    await run(t, "true");
    const pid = masterPid(state);
    expect(alive(pid)).toBe(true);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), WAIT);
  });

  test("a master that cannot connect: the error is classified, then callers fail fast", async () => {
    const { path } = standIn("hostkey", "Host key verification failed.");
    const t = transport(path);
    await expect(run(t, "true")).rejects.toMatchObject({
      class: "spawn_failed",
      retryable: false,
    });
    const began = Date.now();
    await expect(run(t, "true")).rejects.toMatchObject({
      class: "spawn_failed",
    });
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(
      t.transportError(
        { code: 255, signal: null },
        "ssh: connect to host h port 22: Connection refused",
      ),
    ).toMatchObject({ class: "timeout", retryable: true });
    expect(t.transportError({ code: 1, signal: null }, "")).toBeNull();
    await t.close(AbortSignal.timeout(5_000));
  });
});
