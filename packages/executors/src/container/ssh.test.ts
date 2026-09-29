import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  assertPrivateDir,
  classifySsh,
  clientArgs,
  controlArgs,
  controlPath,
  masterArgs,
  parseIdentityRef,
  sshEnv,
  SshTransport,
  SUN_PATH_MAX,
  type SshTarget,
} from "./ssh.js";

const target: SshTarget = {
  host: "192.0.2.10",
  port: 22,
  user: "ops",
  knownHosts: "/frm/executors/ctr-lab/known_hosts",
  identity: { kind: "file", path: "/frm/keys/ctr-lab" },
  controlPath: "/tmp/frm-502/0123456789ab.sock",
};
const optionsOf = (args: readonly string[]) =>
  args.flatMap((arg, i) => (args[i - 1] === "-o" ? [arg] : []));
const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "frm-ssh-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return "accepted";
};

describe("ssh arguments", () => {
  test("a client is hermetic, pinned, multiplexed, and never connects directly", () => {
    const args = clientArgs(target, "exec node x run 0123456789abcdef /r");
    expect(args.slice(0, 5)).toEqual(["-F", "none", "-T", "-x", "-a"]);
    expect(optionsOf(args)).toEqual([
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "UpdateHostKeys=no",
      "UserKnownHostsFile=/frm/executors/ctr-lab/known_hosts",
      "GlobalKnownHostsFile=/dev/null",
      "ControlPath=/tmp/frm-502/0123456789ab.sock",
      "ConnectTimeout=5",
      "ServerAliveInterval=5",
      "ServerAliveCountMax=3",
      "LogLevel=ERROR",
      "IdentitiesOnly=yes",
      "ControlMaster=no",
      "ProxyCommand=false",
    ]);
    expect(args.slice(-3)).toEqual([
      "ops@192.0.2.10",
      "--",
      "exec node x run 0123456789abcdef /r",
    ]);
    expect(args).toEqual(
      expect.arrayContaining(["-i", "/frm/keys/ctr-lab", "-p", "22"]),
    );
  });

  test("the master is the one connection: no ProxyCommand, no persistence of its own", () => {
    const args = masterArgs(target);
    expect(args).toEqual(expect.arrayContaining(["-M", "-N"]));
    expect(optionsOf(args)).toEqual(
      expect.arrayContaining(["ControlMaster=yes", "ControlPersist=no"]),
    );
    expect(optionsOf(args).some((o) => o.startsWith("ProxyCommand"))).toBe(
      false,
    );
    expect(controlArgs(target, "check")).toEqual([
      "-F",
      "none",
      "-o",
      "ControlPath=/tmp/frm-502/0123456789ab.sock",
      "-O",
      "check",
      "ops@192.0.2.10",
    ]);
  });

  test("the ControlPath fits sun_path with ssh's bind suffix, whatever FRM_HOME is", () => {
    const long = `/Users/someone/${"x".repeat(200)}/frm-home`;
    const path = controlPath(long, "ctr-lab", 502);
    expect(path).toMatch(/^\/tmp\/frm-502\/[0-9a-f]{12}\.sock$/);
    expect(path.length + 17).toBeLessThanOrEqual(SUN_PATH_MAX);
    expect(controlPath(long, "ctr-9", 502)).not.toBe(path);
    expect(controlPath("/other", "ctr-lab", 502)).not.toBe(path);
    expect(controlPath(long, "ctr-lab", 502)).toBe(path);
  });

  test("identity_ref: file: or agent:, and the agent socket only for agent:", () => {
    expect(parseIdentityRef("file:/k/id")).toEqual({
      kind: "file",
      path: "/k/id",
    });
    expect(parseIdentityRef("agent:/k/id.pub")).toEqual({
      kind: "agent",
      path: "/k/id.pub",
    });
    expect(refused(() => parseIdentityRef("secret://x"))).toMatchObject({
      class: "validation",
    });
    const from = { SSH_AUTH_SOCK: "/tmp/agent.sock", AWS_SECRET: "nope" };
    expect(sshEnv({ kind: "file", path: "/k" }, from)).not.toHaveProperty(
      "SSH_AUTH_SOCK",
    );
    const agent = sshEnv({ kind: "agent", path: "/k.pub" }, from);
    expect(agent).toMatchObject({
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      LC_ALL: "C",
    });
    expect(Object.keys(agent).sort()).toEqual([
      "HOME",
      "LC_ALL",
      "PATH",
      "SSH_AUTH_SOCK",
    ]);
  });

  test("failures are classified: host keys and auth are final, the rest retryable", () => {
    expect(classifySsh("Host key verification failed.\n", "h")).toMatchObject({
      class: "spawn_failed",
      retryable: false,
    });
    expect(
      classifySsh("ops@h: Permission denied (publickey).", "h"),
    ).toMatchObject({ class: "spawn_failed", retryable: false });
    expect(classifySsh('Load key "/k": bad permissions', "h")).toMatchObject({
      class: "validation",
    });
    expect(
      classifySsh("ssh: connect to host h port 22: Operation timed out", "h"),
    ).toMatchObject({ class: "timeout", retryable: true });
  });
});

describe("the ControlPath directory", () => {
  const uid = process.getuid?.() ?? 0;

  test("is created 0700 when missing", () => {
    const dir = join(scratch(), "frm-cp");
    assertPrivateDir(dir, uid);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    assertPrivateDir(dir, uid);
  });

  test("is refused when open to others, a symlink, or someone else's", () => {
    const open = join(scratch(), "open");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(refused(() => assertPrivateDir(open, uid))).toMatchObject({
      class: "internal",
    });
    const real = join(scratch(), "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(scratch(), "link");
    symlinkSync(real, link);
    expect(refused(() => assertPrivateDir(link, uid))).toMatchObject({
      class: "internal",
    });
    expect(refused(() => assertPrivateDir(real, uid + 1))).toMatchObject({
      class: "internal",
    });
  });
});

describe("SshTransport credentials", () => {
  const base = {
    host: "127.0.0.1",
    port: 22,
    user: "frm",
    control_persist_ms: 1000,
    max_channels: 2,
  };

  test("a missing pinned known_hosts is refused before any connection", async () => {
    const home = scratch();
    const key = join(home, "id");
    writeFileSync(key, "k", { mode: 0o600 });
    const t = new SshTransport({
      executorId: "ctr-t",
      frmHome: home,
      ssh: { ...base, identity_ref: `file:${key}` },
    });
    await expect(
      t.start("true", AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({
      class: "validation",
    });
  });

  test("an identity file open to others is refused", async () => {
    const home = scratch();
    const key = join(home, "id");
    const known = join(home, "known_hosts");
    writeFileSync(key, "k", { mode: 0o644 });
    chmodSync(key, 0o644);
    writeFileSync(known, "");
    const t = new SshTransport({
      executorId: "ctr-t",
      frmHome: home,
      ssh: { ...base, identity_ref: `file:${key}`, known_hosts: known },
    });
    await expect(
      t.start("true", AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({
      class: "validation",
    });
  });

  test("a deadline that has passed rejects `timeout` at once", async () => {
    const home = scratch();
    const t = new SshTransport({
      executorId: "ctr-t",
      frmHome: home,
      ssh: { ...base, identity_ref: `file:${join(home, "id")}` },
    });
    await expect(t.start("true", AbortSignal.abort())).rejects.toMatchObject({
      class: "timeout",
    });
    expect(t.rttMs()).toBeNull();
    t.observeRtt(100);
    t.observeRtt(200);
    expect(t.rttMs()).toBe(120);
    await t.close(AbortSignal.timeout(1_000));
  });
});
