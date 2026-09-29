// The exec-shim's docker-host route: the
// host exec is confined by real path on the host itself, so a symlink under remote_root cannot lead
// it into a session root or out of remote_root; and the sweep's keepalive is chosen by
// /proc/<pid>/exe alone. The pure functions are imported; the shim also runs in `host` mode.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import { confineHost, keepaliveOf, physical } from "./exec-shim.mjs";
import {
  encodeJson,
  FrameDecoder,
  FrameType,
  payloadJson,
  type Frame,
} from "./frames.js";
import { mintToken } from "./ref.js";

const SHIM = fileURLToPath(new URL("./exec-shim.mjs", import.meta.url));
const WAIT = { timeout: 5_000, interval: 10 };
const base = realpathSync(mkdtempSync(join(tmpdir(), "frm-host-")));
const root = join(base, "remote");
const outside = join(base, "outside");
for (const dir of ["mirror/repo.git", "bin", "run", "work/ses-1"]) {
  mkdirSync(join(root, dir), { recursive: true });
}
mkdirSync(outside);
// Links an operator (never a session: mirror is read-only to them) might leave, pointing out.
symlinkSync("../work/ses-1", join(root, "mirror", "to-session"));
symlinkSync(outside, join(root, "mirror", "to-outside"));
symlinkSync("../work/ses-1/planted", join(root, "mirror", "dangling"));
// A remote_root whose mirror directory itself is a link out.
const bent = join(base, "bent");
mkdirSync(join(bent, "run"), { recursive: true });
symlinkSync(outside, join(bent, "mirror"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const mirror = join(root, "mirror");
const confine = (
  argv: readonly string[],
  cwd = mirror,
  env: Record<string, string> = {},
) => confineHost(root, { argv, cwd, env });

describe("the docker host route, by real path", () => {
  test("allows chores in mirror, bin and run, and paths that stay in remote_root", () => {
    expect(confine(["git", "fetch", "origin"])).toBeNull();
    // A system program by absolute path is what a bare name finds on PATH: allowed.
    expect(confine([process.execPath, "-e", "0"])).toBeNull();
    expect(
      confine(
        ["git", `--git-dir=${join(mirror, "repo.git")}`, "log"],
        join(root, "run"),
        { PATH: "/usr/bin:/bin", HOME: "/home/ops" },
      ),
    ).toBeNull();
    expect(confine(["tee", "-a", "/dev/null"])).toBeNull();
    expect(
      confine(["mkdir", "-p", "new/deeper"], join(root, "bin")),
    ).toBeNull();
  });

  test.each([
    ["a cwd through a link into a session", ["ls"], join(mirror, "to-session")],
    ["a cwd in a session", ["ls"], join(root, "work", "ses-1")],
    ["remote_root itself", ["ls"], root],
    ["an argument through a link into a session", ["cat", "to-session/x"]],
    ["an argument through a link out of remote_root", ["cat", "to-outside/x"]],
    ["a dangling link whose target a write would create", ["tee", "dangling"]],
    ["a .. after a link, which the kernel follows", ["tee", "to-session/../x"]],
    ["a --flag= value through a link", ["git", "--git-dir=to-session/.git"]],
    ["a program through a link", ["./to-session/evil"]],
    ["a bare program naming a link into a session", ["to-session"]],
    [
      "an absolute program under a session root",
      [join(root, "work", "ses-1", "evil")],
    ],
  ] as const)("refuses %s", (_what, argv, cwd = mirror) => {
    expect(confine(argv, cwd)).toEqual(expect.any(String));
  });

  test("refuses an env value through a link into a session", () => {
    expect(
      confine(["git", "log"], mirror, {
        GIT_DIR: join(mirror, "to-session"),
      }),
    ).toMatch(/env GIT_DIR/);
  });

  test("refuses a mirror directory that is itself a link out, and a missing remote_root", () => {
    expect(
      confineHost(bent, { argv: ["ls"], cwd: join(bent, "mirror"), env: {} }),
    ).toMatch(/leads to/);
    expect(
      confineHost(join(base, "missing"), {
        argv: ["ls"],
        cwd: mirror,
        env: {},
      }),
    ).toMatch(/does not exist/);
  });

  test("physical resolves links component by component and appends what does not exist", () => {
    // Template strings: join() would fold the `..` lexically before physical() saw it.
    expect(physical(`${mirror}/to-session/..`)).toBe(join(root, "work"));
    expect(physical(`${mirror}/new/../x`)).toBe(join(mirror, "x"));
    expect(physical(join(mirror, "dangling"))).toBe(
      join(root, "work", "ses-1", "planted"),
    );
  });
});

function hostShim(remoteRoot: string) {
  const token = mintToken();
  const child = spawn(process.execPath, [SHIM, "host", token, remoteRoot], {
    stdio: ["pipe", "pipe", "pipe"],
  });
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
  const hello = (h: { argv: readonly string[]; cwd: string }) =>
    child.stdin.write(
      encodeJson(FrameType.hello, {
        v: 1,
        env: {},
        stdin: "ignore",
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
  return { child, hello, frame, exit, stdout: () => stdout };
}

describe("exec-shim host mode", { timeout: 15_000 }, () => {
  test("runs an allowed chore, recorded under remote_root/run", async () => {
    const s = hostShim(root);
    s.hello({
      argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"],
      cwd: mirror,
    });
    await s.frame(FrameType.started);
    expect(payloadJson(await s.frame(FrameType.exit))).toMatchObject({
      code: 0,
    });
    expect(s.stdout()).toBe(mirror);
  });

  test("a symlink escape is a failed frame (EACCES) and exit 127: nothing starts", async () => {
    const s = hostShim(root);
    s.hello({ argv: ["tee", "dangling"], cwd: mirror });
    expect(payloadJson(await s.frame(FrameType.failed))).toMatchObject({
      errno: "EACCES",
    });
    expect(await s.exit).toBe(127);
    s.child.stdin.end();
    expect(existsSync(join(root, "work", "ses-1", "planted"))).toBe(false);
    const cwd = hostShim(root);
    cwd.hello({ argv: ["ls"], cwd: join(mirror, "to-session") });
    expect(payloadJson(await cwd.frame(FrameType.failed))).toMatchObject({
      errno: "EACCES",
    });
    expect(await cwd.exit).toBe(127);
    cwd.child.stdin.end();
  });
});

describe("the sweep's keepalive (security review)", () => {
  test("is the lowest pid under PID 1 whose exe is sleep", () => {
    expect(
      keepaliveOf([
        { pid: 9, ppid: 1, exe: "/usr/bin/sleep" },
        { pid: 5, ppid: 1, exe: "/bin/sleep" },
        { pid: 3, ppid: 2, exe: "/bin/sleep" },
      ]),
    ).toBe(5);
  });

  test("never a process whose argv says sleep but whose exe does not, nor an unreadable exe", () => {
    expect(
      keepaliveOf([
        { pid: 4, ppid: 1, exe: "/usr/local/bin/node" },
        { pid: 6, ppid: 1, exe: "" },
      ]),
    ).toBeUndefined();
  });
});
