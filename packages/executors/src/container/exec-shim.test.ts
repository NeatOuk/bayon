// The exec-shim itself, under this machine's node, with no docker and no ssh.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import type { Argv } from "../types.js";
import {
  encodeFrame,
  encodeJson,
  FrameDecoder,
  FrameType,
  payloadJson,
  type Frame,
} from "./frames.js";
import { mintToken } from "./ref.js";

const SHIM = fileURLToPath(new URL("./exec-shim.mjs", import.meta.url));
const WAIT = { timeout: 5_000, interval: 10 };
const node = (source: string): Argv => [process.execPath, "-e", source];
const runDir = mkdtempSync(join(tmpdir(), "frm-shim-"));
const started: ChildProcess[] = [];
afterEach(() => {
  for (const child of started.splice(0)) child.kill("SIGKILL");
});
afterAll(() => rmSync(runDir, { recursive: true, force: true }));

interface Hello {
  readonly argv: Argv;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: "pipe" | "ignore";
  readonly deadmanMs?: number;
}

function shim(token = mintToken()) {
  const child = spawn(process.execPath, [SHIM, "run", token, runDir], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  started.push(child);
  const frames: Frame[] = [];
  const decoder = new FrameDecoder();
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) =>
    frames.push(...decoder.push(chunk)),
  );
  const exit = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  const send = (frame: Buffer) => child.stdin.write(frame);
  const hello = (h: Hello) =>
    send(
      encodeJson(FrameType.hello, {
        v: 1,
        cwd: runDir,
        env: {},
        stdin: "pipe",
        killGraceMs: 500,
        deadmanMs: 10_000,
        heartbeatMs: 1_000,
        ...h,
      }),
    );
  const frame = (type: FrameType) =>
    vi.waitFor(() => {
      const found = frames.find((f) => f.type === type);
      if (found === undefined) throw new Error(`no frame ${type} yet`);
      return found;
    }, WAIT);
  return {
    token,
    child,
    frames,
    send,
    hello,
    frame,
    exit,
    stdout: () => stdout,
    exitStatus: async () => payloadJson(await frame(FrameType.exit)),
  };
}

const ctl = (token: string, op: string) =>
  spawnSync(process.execPath, [SHIM, "ctl", runDir, token, op], {
    encoding: "utf8",
  });
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};
/** A group is there while any member is, a zombie included; macOS then answers EPERM, not ESRCH. */
const groupThere = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
};
// Exits leaving its group holding only a zombie: a helper moves to its own group (same session),
// forks a child that joins the program's group and dies there, and never reaps it. The program
// prints the helper's pid, for cleanup, once that child is gone.
const ZOMBIE_LEFT_IN_GROUP = [
  "use POSIX ();",
  "my $leader = $$;",
  'pipe(my $r, my $w) or die "pipe: $!";',
  'my $helper = fork() // die "fork: $!";',
  "if ($helper == 0) {",
  '  POSIX::setpgid(0, 0) or die "setpgid: $!";',
  '  my $z = fork() // die "fork: $!";',
  '  if ($z == 0) { POSIX::setpgid(0, $leader) or die "join: $!"; POSIX::_exit(0); }',
  "  close $w;",
  '  open STDOUT, ">", "/dev/null"; open STDERR, ">", "/dev/null";',
  "  sleep 60; POSIX::_exit(0);",
  "}",
  "close $w;",
  "my $eof = <$r>;",
  "print $helper;",
].join("\n");

describe("exec-shim run", { timeout: 15_000 }, () => {
  test("the program gets exactly the hello's env; its stdout is its own", async () => {
    const s = shim();
    s.hello({
      argv: node("process.stdout.write(JSON.stringify(process.env))"),
      env: { FOO: "bar" },
    });
    expect(payloadJson(await s.frame(FrameType.started))).toMatchObject({
      pgid: expect.any(Number),
    });
    expect(await s.exitStatus()).toEqual({ code: 0, signal: null, oom: false });
    expect(await s.exit).toBe(0);
    const env = JSON.parse(s.stdout()) as Record<string, string>;
    // macOS adds __CF_USER_TEXT_ENCODING to every process; Linux (a container) adds nothing.
    const added = process.platform === "darwin" ? /^__CF_/ : /^$/;
    expect(
      Object.fromEntries(Object.entries(env).filter(([k]) => !added.test(k))),
    ).toEqual({ FOO: "bar" });
  });

  test.each([
    ["a missing program", { argv: ["/nonexistent/frm-no-such"] as Argv }],
    ["a missing cwd", { argv: node("0"), cwd: "/nonexistent-frm-dir" }],
  ])("%s is a failed frame and exit 127", async (_what, hello) => {
    const s = shim();
    s.hello(hello);
    expect(payloadJson(await s.frame(FrameType.failed))).toMatchObject({
      errno: "ENOENT",
    });
    expect(await s.exit).toBe(127);
  });

  test("a malformed hello is refused", async () => {
    const s = shim();
    s.send(encodeFrame(FrameType.hello, "{"));
    expect(payloadJson(await s.frame(FrameType.failed))).toMatchObject({
      errno: "EPROTO",
    });
    expect(await s.exit).toBe(127);
  });

  test("data frames reach stdin and are acked; stderr comes back framed", async () => {
    const s = shim();
    s.hello({
      argv: node(
        "process.stdin.on('data', (c) => process.stdout.write(c)); process.stdin.on('end', () => process.stderr.write('done'))",
      ),
    });
    await s.frame(FrameType.started);
    const input = Buffer.alloc(300 * 1024, 7);
    for (let at = 0; at < input.length; at += 64 * 1024) {
      s.send(encodeFrame(FrameType.data, input.subarray(at, at + 64 * 1024)));
    }
    s.send(encodeFrame(FrameType.eof));
    expect(await s.exitStatus()).toMatchObject({ code: 0 });
    const acked = s.frames
      .filter((f) => f.type === FrameType.ack)
      .reduce(
        (sum, f) => sum + Number((payloadJson(f) as { bytes: number }).bytes),
        0,
      );
    expect(acked).toBe(input.length);
    expect(s.stdout().length).toBe(input.length);
    const errText = s.frames
      .filter((f) => f.type === FrameType.stderr)
      .map((f) => f.payload.toString())
      .join("");
    expect(errText).toBe("done");
  });

  test("a kill frame reaches the whole group, even behind stdin the program never reads", async () => {
    const s = shim();
    s.hello({
      argv: node(
        "const c = require('node:child_process').spawn('sleep', ['60'], { stdio: 'ignore' }); process.stdout.write(String(c.pid)); setInterval(() => {}, 1e9)",
      ),
    });
    await s.frame(FrameType.started);
    await vi.waitFor(() => expect(s.stdout()).toMatch(/^\d+$/), WAIT);
    const grandchild = Number(s.stdout());
    for (let i = 0; i < 8; i += 1) {
      s.send(encodeFrame(FrameType.data, Buffer.alloc(256 * 1024)));
    }
    s.send(encodeFrame(FrameType.kill, "SIGTERM"));
    expect(await s.exitStatus()).toEqual({
      code: null,
      signal: "SIGTERM",
      oom: false,
    });
    await vi.waitFor(() => expect(gone(grandchild)).toBe(true), WAIT);
  });

  test("a group left holding only a zombie still gets its exit frame", async () => {
    // The shim signals the group once more after the program exits. An orphan there that init has
    // not reaped yet is such a zombie: under load the kill test above met one and lost its frame.
    const s = shim();
    s.hello({
      argv: ["perl", "-e", ZOMBIE_LEFT_IN_GROUP],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    const { pgid } = payloadJson(await s.frame(FrameType.started)) as {
      pgid: number;
    };
    await vi.waitFor(() => expect(s.stdout()).toMatch(/^\d+$/), WAIT);
    try {
      expect(await s.exitStatus()).toEqual({
        code: 0,
        signal: null,
        oom: false,
      });
      expect(groupThere(pgid)).toBe(true);
      expect(await s.exit).toBe(0);
    } finally {
      process.kill(Number(s.stdout()), "SIGKILL");
    }
  });

  test("the dead-man: stdin EOF from a lost channel ends the program", async () => {
    const s = shim();
    s.hello({ argv: node("setInterval(() => {}, 1e9)") });
    await s.frame(FrameType.started);
    s.child.stdin.end();
    expect(await s.exitStatus()).toMatchObject({ signal: "SIGTERM" });
  });

  test("the dead-man: silence ends the program", async () => {
    const s = shim();
    s.hello({ argv: node("setInterval(() => {}, 1e9)"), deadmanMs: 300 });
    await s.frame(FrameType.started);
    expect(await s.exitStatus()).toMatchObject({ signal: "SIGTERM" });
  });
});

describe("exec-shim ctl, the record and sweep", { timeout: 15_000 }, () => {
  test("the record names the group, never the env; ctl probes and signals it", async () => {
    const canary = mintToken() + mintToken();
    const s = shim();
    s.hello({
      argv: node("setInterval(() => {}, 1e9)"),
      env: { FRM_CANARY: canary },
    });
    const { pgid } = payloadJson(await s.frame(FrameType.started)) as {
      pgid: number;
    };
    const record = join(runDir, `${s.token}.json`);
    const text = readFileSync(record, "utf8");
    expect(text).not.toContain(canary);
    expect(JSON.parse(text)).toMatchObject({ pgid, shimPid: s.child.pid });
    expect(ctl(s.token, "probe")).toMatchObject({
      status: 0,
      stdout: "alive\n",
    });
    expect(ctl(s.token, "TERM")).toMatchObject({ status: 0 });
    expect(await s.exitStatus()).toMatchObject({ signal: "SIGTERM" });
    await s.exit;
    expect(existsSync(record)).toBe(false);
    expect(ctl(s.token, "probe")).toMatchObject({
      status: 3,
      stdout: "dead\n",
    });
    expect(ctl(s.token, "KILL")).toMatchObject({ status: 3 });
    expect(ctl(s.token, "STOP")).toMatchObject({ status: 2 });
  });

  test("sweep refuses to run outside an frm container", () => {
    const ran = spawnSync(
      process.execPath,
      [SHIM, "sweep", runDir, mintToken()],
      { encoding: "utf8" },
    );
    expect(ran.status).toBe(2);
    expect(ran.stdout).toContain("refused");
  });

  test("anything else is a usage error", () => {
    for (const args of [
      [],
      ["run", "nothex", runDir],
      ["ctl", "rel", "x", "probe"],
    ]) {
      const ran = spawnSync(process.execPath, [SHIM, ...args], {
        encoding: "utf8",
      });
      expect(ran.status).toBe(2);
      expect(ran.stderr).toContain("usage");
    }
  });
});
