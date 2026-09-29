// Fetching a session's commit back out of a container, through the loopback: the far
// end is `git upload-pack` inside that session's own container, and the pack is received by the
// supervisor's own git into its own bare mirror. Nothing here runs git on the docker host, and the
// only thing the fetch may write in the mirror is the pin ref the supervisor named.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { SlotCounter } from "../slots.js";
import { ContainerExecutor } from "./container.js";
import { installFakeDocker } from "./fake-docker.js";
import { LoopbackTransport } from "./loopback.js";
import { fetchMirror } from "./mirror.js";
import { CONTAINER_PATHS, layoutOf } from "./route.js";
import { RemoteScripts } from "./scripts.js";
import type { ProgramSpec } from "./transport.js";

const PATH = process.env["PATH"] ?? "/usr/bin:/bin";
const base = realpathSync(mkdtempSync(join(tmpdir(), "frm-fetch-")));
const executors: ContainerExecutor[] = [];
afterAll(async () => {
  for (const e of executors) await e.close();
  rmSync(base, { recursive: true, force: true });
});

const GIT_ENV = {
  PATH,
  HOME: base,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "frm",
  GIT_AUTHOR_EMAIL: "frm@example.invalid",
  GIT_COMMITTER_NAME: "frm",
  GIT_COMMITTER_EMAIL: "frm@example.invalid",
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const SID = "S-fetch";
const CTR = "ctr-loop";
const FULL = `c${"0".repeat(62)}1`;

/** The supervisor's own bare mirror of the repo, at the base commit only. */
function world() {
  const home = mkdtempSync(join(base, "w-"));
  const remote = join(home, "remote");
  const work = join(remote, "work");
  const src = join(home, "src");
  mkdirSync(join(work, SID), { recursive: true });
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "a.txt"), "one\n");
  git(src, "add", "a.txt");
  git(src, "commit", "-q", "-m", "base");
  const mirror = join(home, "mirror.git");
  git(home, "clone", "-q", "--bare", src, mirror);
  // The session's own clone, as the workspace step leaves it: a commit only it holds.
  const repo = join(work, SID, "repo");
  git(work, "clone", "-q", src, repo);
  writeFileSync(join(repo, "b.txt"), "two\n");
  git(repo, "add", "b.txt");
  git(repo, "commit", "-q", "-m", "work");
  const head = git(repo, "rev-parse", "HEAD");
  const docker = installFakeDocker(join(home, "fake"), CTR);
  // The session's "container", as the stand-in docker keeps them: one file per session.
  writeFileSync(join(docker.state, SID), `${FULL}\n`);
  const executor = new ContainerExecutor({
    id: CTR,
    slots: new SlotCounter(1),
    frmHome: home,
    config: {
      ssh: { host: "loopback", user: "frm", identity_ref: "file:/dev/null" },
      remote_root: remote,
      image: "frm/test",
      min_free_pct: 0,
      env_path: `${dirname(process.execPath)}:/usr/bin:/bin`,
    },
    transport: new LoopbackTransport({ ...docker.env, HOME: home }),
    paths: { sessions: work, run: join(remote, "run"), shim: "/opt/frm/s.mjs" },
  });
  executors.push(executor);
  return { home, remote, work, repo, mirror, head, executor };
}

const scripts = (root: string) =>
  new RemoteScripts(CTR, layoutOf(root), CONTAINER_PATHS, "a".repeat(64));

describe("a gate's subject fetched back out of a container", () => {
  test("upload-pack runs in the session's container, and the commit lands under the pin ref", async () => {
    const w = world();
    expect(() => git(w.mirror, "cat-file", "-t", w.head)).toThrow();
    await w.executor.mirrors.fetchFromSession({
      localMirror: w.mirror,
      sessionId: SID,
      dir: w.repo,
      refspecs: [`+${w.head}:refs/frm/gate/g1`],
      signal: AbortSignal.timeout(30_000),
    });
    expect(git(w.mirror, "cat-file", "-t", w.head)).toBe("commit");
    expect(git(w.mirror, "rev-parse", "refs/frm/gate/g1")).toBe(w.head);
    // Only the ref that was asked for: no branch of the session's, no FETCH_HEAD.
    expect(
      git(w.mirror, "for-each-ref", "--format=%(refname)", "refs/frm/"),
    ).toBe("refs/frm/gate/g1");
    expect(readdirSync(w.mirror)).not.toContain("FETCH_HEAD");
  }, 60_000);

  test("a session whose container is not running is refused, and the mirror is untouched", async () => {
    const w = world();
    rmSync(join(w.home, "fake", "docker-state", SID));
    await expect(
      w.executor.mirrors.fetchFromSession({
        localMirror: w.mirror,
        sessionId: SID,
        dir: w.repo,
        refspecs: [`+${w.head}:refs/frm/gate/g1`],
        signal: AbortSignal.timeout(30_000),
      }),
    ).rejects.toMatchObject({
      class: "spawn_failed",
      message: expect.stringContaining("no running container"),
    });
    expect(
      git(w.mirror, "for-each-ref", "--format=%(refname)", "refs/frm/"),
    ).toBe("");
  }, 60_000);
});

describe("what the fetch may name", () => {
  const NOWHERE: ProgramSpec = {
    file: "/bin/sh",
    args: ["-c", "exit 0"],
    env: {},
    release: () => undefined,
  };
  const refuses = (refspecs: readonly string[]) =>
    expect(
      fetchMirror({
        localMirror: base,
        refspecs,
        program: NOWHERE,
        path: PATH,
        signal: AbortSignal.timeout(10_000),
        what: "test fetch",
      }),
    ).rejects.toMatchObject({ class: "validation" });

  test("a ref as the source, a deletion, or any destination but a pin ref", async () => {
    const sha = "a".repeat(40);
    // A ref the session could move under us is never the source: only an id already read.
    await refuses([`+refs/heads/frm/${SID}:refs/frm/gate/g1`]);
    await refuses([`:refs/frm/gate/g1`]);
    await refuses([`+${sha}:refs/heads/main`]);
    await refuses([`+${sha}:refs/frm/gate/g1 --upload-pack=evil`]);
    await refuses([]);
  });

  test("upload-pack is refused outside the session's own root, and for another session's", () => {
    const s = scripts("/srv/frm");
    expect(s.uploadPack("0123456789ab", "S1", "/frm/s/S1/repo")).toContain(
      "docker exec -i 0123456789ab env ",
    );
    // The label guard is the same one every other exec here carries.
    expect(s.uploadPack("0123456789ab", "S1", "/frm/s/S1")).toContain(
      'frm.executor"}}',
    );
    for (const dir of ["/frm/s/S2/repo", "/frm/s", "/srv/frm/mirror/r.git"]) {
      expect(() => s.uploadPack("0123456789ab", "S1", dir)).toThrow(
        /not in the root of session S1/,
      );
    }
    // `within` is a bare prefix test and PATH admits `..`: a dir is normalized before either runs,
    // or `/frm/s/S1/../../../srv/frm/mirror/other.git` would serve a mirror on the docker host.
    for (const dir of [
      "/frm/s/S1/../../../srv/frm/mirror/other.git",
      "/frm/s/S1/..",
      "/frm/s/S1/./repo",
      "/frm/s//S1/repo",
      "../frm/s/S1/repo",
    ]) {
      expect(() => s.uploadPack("0123456789ab", "S1", dir)).toThrow(
        /absolute, normalized path/,
      );
    }
    expect(() => s.uploadPack("nope", "S1", "/frm/s/S1/repo")).toThrow(
      /container id/,
    );
  });
});
