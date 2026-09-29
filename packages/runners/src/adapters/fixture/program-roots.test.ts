// SpawnSpec.extraRoots in the fixture runner: reported in session_init,
// the only places besides the cwd an append may land (real path + path.relative, never a prefix),
// and each root that received an append is committed on its own.
import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  removeTempDirs,
  start,
  tempDir,
  untilTerminal,
} from "./program-harness.js";

afterEach(removeTempDirs);

const send = { op: "send", runId: "run-1", text: "go" };
const env = { PATH: process.env["PATH"] };
const IDENTITY = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@frm.invalid",
  "-c",
  "commit.gpgsign=false",
];
const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

/** A fresh repo with an empty first commit. */
function repo(): string {
  const dir = tempDir();
  git(dir, "init", "-q", "-b", "main");
  git(dir, ...IDENTITY, "commit", "-q", "--allow-empty", "-m", "base");
  return dir;
}

describe("extra roots (L5)", () => {
  test("session_init lists them; an append into one lands there, and the cwd and it are each committed", async () => {
    const cwd = repo();
    const lib = repo();
    const h = start({
      cwd,
      env,
      extraRoots: [lib],
      script: {
        runs: [
          {
            appends: [
              { path: "app.txt", text: "app\n" },
              { path: join(lib, "lib.txt"), text: "lib\n" },
            ],
            commit: "work",
          },
        ],
      },
    });
    h.op(send);
    const lines = await untilTerminal(h);
    expect(lines[0]).toMatchObject({
      kind: "session_init",
      payload: { extra_roots: [lib] },
    });
    expect(lines.at(-1)?.["payload"]).toMatchObject({ outcome: "ok" });
    expect(git(cwd, "show", "HEAD:app.txt")).toBe("app");
    expect(git(lib, "show", "HEAD:lib.txt")).toBe("lib");
    expect(git(lib, "log", "-1", "--format=%s")).toBe("work");
    h.eof();
    await h.exit;
  });

  test.each(["dotdot", "symlink"] as const)(
    "an append outside every root (%s) fails the run and writes nothing there",
    async (how) => {
      const cwd = repo();
      const outside = tempDir();
      symlinkSync(outside, join(cwd, "out"));
      const path =
        how === "dotdot"
          ? join("..", basename(outside), "x.txt")
          : join("out", "x.txt");
      const h = start({
        cwd,
        env,
        script: { runs: [{ appends: [{ path, text: "escape\n" }] }] },
      });
      h.op(send);
      const lines = await untilTerminal(h);
      expect(lines.at(-1)?.["payload"]).toMatchObject({
        outcome: "failed",
        error: {
          class: "validation",
          message: `append ${path} lands outside the session's roots`,
        },
      });
      expect(existsSync(join(outside, "x.txt"))).toBe(false);
      h.eof();
      await h.exit;
    },
  );

  test("without extra roots session_init carries no extra_roots", async () => {
    const h = start({ env });
    h.op(send);
    const lines = await untilTerminal(h);
    expect(lines[0]?.["payload"]).not.toHaveProperty("extra_roots");
    h.eof();
    await h.exit;
  });
});
