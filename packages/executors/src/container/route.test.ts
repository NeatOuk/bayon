import { describe, expect, test } from "vitest";
import type { Argv } from "../types.js";
import {
  CONTAINER_PATHS,
  layoutOf,
  normalPath,
  routeExec,
  type Route,
} from "./route.js";

const layout = layoutOf("/home/ops/frm");
const route = (
  argv: Argv,
  cwd: string,
  env: Record<string, string> = {},
): Route => routeExec(layout, CONTAINER_PATHS, argv, cwd, env);
const refusal = (argv: Argv, cwd: string, env: Record<string, string> = {}) => {
  try {
    route(argv, cwd, env);
  } catch (err) {
    return err;
  }
  return "routed";
};

describe("exec routing", () => {
  test("a cwd in a session root runs in that session's container", () => {
    expect(route(["git", "status"], "/frm/s/ses-1")).toEqual({
      kind: "container",
      sessionId: "ses-1",
    });
    expect(route(["make"], "/frm/s/ses-1/repo/src/")).toEqual({
      kind: "container",
      sessionId: "ses-1",
    });
  });

  test("the docker host takes only chores under mirror, bin and run", () => {
    for (const cwd of [
      "/home/ops/frm/mirror",
      "/home/ops/frm/mirror/repo.git",
      "/home/ops/frm/bin",
      "/home/ops/frm/run/x",
    ]) {
      expect(route(["git", "fetch", "origin/main"], cwd)).toEqual({
        kind: "host",
      });
    }
    expect(
      route(
        [
          "git",
          "-C",
          "/home/ops/frm/mirror/r.git",
          "--git-dir=/home/ops/frm/mirror/r.git",
          "rev-parse",
          "refs/heads/main",
        ],
        "/home/ops/frm/run",
        { PATH: "/usr/bin:/bin", HOME: "/home/ops" },
      ),
    ).toEqual({ kind: "host" });
    expect(route(["tee", "-a", "/dev/null"], "/home/ops/frm/mirror")).toEqual({
      kind: "host",
    });
  });

  test.each([
    ["a cwd in a session's host root", ["ls"], "/home/ops/frm/work/ses-1"],
    ["remote_root itself", ["ls"], "/home/ops/frm"],
    ["a cwd outside remote_root", ["ls"], "/tmp"],
    ["a relative cwd", ["ls"], "home/neat/frm/run"],
    ["a cwd with ..", ["ls"], "/home/ops/frm/run/../work/ses-1"],
    ["a container path naming no session", ["ls"], "/frm/s/bad id"],
    [
      "git -C into a session",
      ["git", "-C", "/home/ops/frm/work/ses-1", "status"],
      "/home/ops/frm/mirror",
    ],
    [
      "--git-dir= into a session",
      ["git", "--git-dir=/home/ops/frm/work/ses-1/.git", "log"],
      "/home/ops/frm/mirror",
    ],
    [
      "a relative path into a session",
      ["tee", "../work/ses-1/f"],
      "/home/ops/frm/run",
    ],
    [
      "an argument outside remote_root",
      ["cat", "/etc/passwd"],
      "/home/ops/frm/run",
    ],
    [
      "a program inside a session",
      ["/home/ops/frm/work/ses-1/evil"],
      "/home/ops/frm/run",
    ],
  ] as const)("refuses %s", (_what, argv, cwd) => {
    expect(refusal(argv, cwd)).toMatchObject({ class: "validation" });
  });

  test("refuses an env value that points into a session", () => {
    expect(
      refusal(["git", "log"], "/home/ops/frm/mirror", {
        GIT_DIR: "/home/ops/frm/work/ses-1/.git",
      }),
    ).toMatchObject({ class: "validation" });
    expect(
      refusal(["git", "log"], "/home/ops/frm/mirror", {
        PATH: "/usr/bin:/home/ops/frm/work/ses-1/bin",
      }),
    ).toMatchObject({ class: "validation" });
  });

  test("normalPath drops a trailing slash and refuses anything else unnormal", () => {
    expect(normalPath("/a/b/", "p")).toBe("/a/b");
    expect(normalPath("/", "p")).toBe("/");
    for (const bad of ["a/b", "/a//b", "/a/./b", "/a/../b"]) {
      expect(() => normalPath(bad, "p")).toThrow();
    }
  });
});
