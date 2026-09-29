// Pin refs in a docker host's mirrors: the executor's two dedicated host
// operations, listPins and dropPins, through the loopback into real bare repositories under a
// stand-in remote_root. They read and delete refs/frm/{gate,pin}/<id> and nothing else; a mirror or
// repository reached through a symlink is refused; a hostile name or ref never reaches a shell.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { GIT_ENV_FLOOR_SH, SAFE_GIT } from "../git.js";
import { SlotCounter } from "../slots.js";
import { ContainerExecutor } from "./container.js";
import { LoopbackTransport } from "./loopback.js";
import { MAX_PIN_REFS, parsePins, RemoteScripts } from "./scripts.js";
import { CONTAINER_PATHS, layoutOf } from "./route.js";
import type { RemoteChild } from "./transport.js";

/** `git` with SAFE_GIT, as a script line spells it. */
const SAFE_GIT_LINE = `env ${GIT_ENV_FLOOR_SH} ${["git", ...SAFE_GIT].join(" ")}`;

const PATH = process.env["PATH"] ?? "/usr/bin:/bin";
const base = realpathSync(mkdtempSync(join(tmpdir(), "frm-pins-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
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

const work = join(base, "work");
mkdirSync(work);
git(work, "init", "-q", "-b", "main");
writeFileSync(join(work, "a.txt"), "one\n");
git(work, "add", "a.txt");
git(work, "commit", "-q", "-m", "one");
const sha = git(work, "rev-parse", "HEAD");

/** A loopback that records every command it starts. */
class SpyTransport extends LoopbackTransport {
  readonly started: string[] = [];
  override start(command: string, signal: AbortSignal): Promise<RemoteChild> {
    this.started.push(command);
    return super.start(command, signal);
  }
}

function executorAt(root: string) {
  const spy = new SpyTransport({ PATH, HOME: base });
  const ex = new ContainerExecutor({
    id: "ctr-loop",
    slots: new SlotCounter(1),
    frmHome: base,
    config: {
      ssh: { host: "loopback", user: "frm", identity_ref: "file:/dev/null" },
      remote_root: root,
      image: "frm/test",
      min_free_pct: 0,
    },
    transport: spy,
    paths: { sessions: join(root, "work"), run: join(root, "run"), shim: "/x" },
  });
  return { ex, spy };
}

/** A bare mirror `<dir>/<name>.git` holding the work repo's main and `refs` at its head. */
function mirror(dir: string, name: string, refs: readonly string[]): string {
  const repo = join(dir, `${name}.git`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--bare", repo);
  git(repo, "fetch", "-q", work, "+refs/heads/main:refs/heads/main");
  for (const ref of refs) git(repo, "update-ref", ref, sha);
  return repo;
}
const refsOf = (repo: string): string[] =>
  git(repo, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean);

describe("pin refs in a docker host's mirrors", { timeout: 30_000 }, () => {
  test("listPins reads refs/frm/gate and refs/frm/pin of every mirror, and nothing else", async () => {
    const root = join(base, "list");
    const m = join(root, "mirror");
    mirror(m, "repo_1", [
      "refs/frm/gate/g1",
      "refs/frm/pin/S1",
      "refs/frm/other/x",
      "refs/frm/gate/deep/x",
      "refs/heads/frm/S1",
    ]);
    mirror(m, "repo_2", ["refs/frm/gate/g2"]);
    // A repository reached through a symlink is not ours to read: skipped.
    mirror(join(base, "elsewhere-list"), "evil", ["refs/frm/gate/e1"]);
    symlinkSync(join(base, "elsewhere-list", "evil.git"), join(m, "evil.git"));
    mkdirSync(join(m, "notes"));
    const { ex } = executorAt(root);
    const pins = await ex.mirrors.listPins();
    expect(
      [...pins].toSorted((a, b) =>
        `${a.name} ${a.ref}`.localeCompare(`${b.name} ${b.ref}`),
      ),
    ).toEqual([
      { name: "repo_1", ref: "refs/frm/gate/g1" },
      { name: "repo_1", ref: "refs/frm/pin/S1" },
      { name: "repo_2", ref: "refs/frm/gate/g2" },
    ]);
  });

  test("dropPins deletes exactly the refs given; a missing ref, repository or mirror is a no-op", async () => {
    const root = join(base, "drop");
    const repo = mirror(join(root, "mirror"), "repo_1", [
      "refs/frm/gate/g1",
      "refs/frm/pin/S1",
      "refs/frm/gate/g2",
      "refs/frm/other/x",
    ]);
    const { ex } = executorAt(root);
    await ex.mirrors.dropPins("repo_1", [
      "refs/frm/gate/g1",
      "refs/frm/pin/S1",
      "refs/frm/pin/absent",
    ]);
    expect(refsOf(repo).toSorted()).toEqual([
      "refs/frm/gate/g2",
      "refs/frm/other/x",
      "refs/heads/main",
    ]);
    await ex.mirrors.dropPins("repo_9", ["refs/frm/gate/g9"]);
    const nowhere = executorAt(join(base, "never-made"));
    expect(await nowhere.ex.mirrors.listPins()).toEqual([]);
    await nowhere.ex.mirrors.dropPins("repo_1", ["refs/frm/gate/g1"]);
  });

  test("a mirror directory or repository reached through a symlink is refused, and nothing there changes", async () => {
    const elsewhere = join(base, "elsewhere-bent");
    const outside = mirror(elsewhere, "repo_1", ["refs/frm/gate/g1"]);
    const bent = join(base, "bent");
    mkdirSync(bent);
    symlinkSync(elsewhere, join(bent, "mirror"));
    const { ex } = executorAt(bent);
    await expect(ex.mirrors.listPins()).rejects.toMatchObject({
      class: "validation",
      message: expect.stringContaining("refused"),
    });
    await expect(
      ex.mirrors.dropPins("repo_1", ["refs/frm/gate/g1"]),
    ).rejects.toMatchObject({ class: "validation" });
    const linked = join(base, "linked");
    mkdirSync(join(linked, "mirror"), { recursive: true });
    symlinkSync(outside, join(linked, "mirror", "repo_1.git"));
    await expect(
      executorAt(linked).ex.mirrors.dropPins("repo_1", ["refs/frm/gate/g1"]),
    ).rejects.toMatchObject({ class: "validation" });
    expect(refsOf(outside)).toContain("refs/frm/gate/g1");
  });

  test("a hostile ref or mirror name is refused before any command starts", async () => {
    const root = join(base, "hostile");
    const repo = mirror(join(root, "mirror"), "repo_1", ["refs/frm/gate/g1"]);
    const { ex, spy } = executorAt(root);
    const refs = [
      "refs/heads/main",
      "refs/frm/gate/../heads/main",
      "refs/frm/gate/..",
      "refs/frm/gate/a b",
      "refs/frm/gate/$(touch pwned)",
      "refs/frm/gate/a;rm -rf /",
      "refs/frm/gate/x`id`",
      "refs/frm/gate/x'y",
      "refs/frm/gate/",
      "refs/frm/gate/x/y",
      "refs/frm/other/x",
      "refs/frm/pin/a\nrefs/heads/main",
      `refs/frm/gate/${"a".repeat(65)}`,
      "+refs/frm/gate/x",
      ":refs/frm/gate/x",
      "refs/frm/gate/x:refs/heads/main",
      "refs/frm/gate/x*",
      "REFS/FRM/GATE/x",
    ];
    for (const ref of refs) {
      await expect(
        ex.mirrors.dropPins("repo_1", [ref]),
        JSON.stringify(ref),
      ).rejects.toMatchObject({ class: "validation" });
      // One bad ref spoils the batch: nothing of it runs.
      await expect(
        ex.mirrors.dropPins("repo_1", ["refs/frm/gate/g1", ref]),
      ).rejects.toMatchObject({ class: "validation" });
    }
    for (const name of [
      "../x",
      "a b",
      "$(id)",
      "repo;x",
      "",
      "a".repeat(65),
      "repo/../x",
      "repo_1.git",
    ]) {
      await expect(
        ex.mirrors.dropPins(name, ["refs/frm/gate/g1"]),
        JSON.stringify(name),
      ).rejects.toMatchObject({ class: "validation" });
    }
    await expect(ex.mirrors.dropPins("repo_1", [])).rejects.toMatchObject({
      class: "validation",
    });
    await expect(
      ex.mirrors.dropPins(
        "repo_1",
        Array.from(
          { length: MAX_PIN_REFS + 1 },
          (_, i) => `refs/frm/pin/s${i}`,
        ),
      ),
    ).rejects.toMatchObject({ class: "validation" });
    expect(spy.started).toEqual([]);
    expect(refsOf(repo)).toContain("refs/frm/gate/g1");
  });

  test("both scripts are valid sh, and the drop re-checks each ref's prefix on the host", () => {
    const scripts = new RemoteScripts(
      "ctr-loop",
      layoutOf("/home/ops/frm"),
      CONTAINER_PATHS,
      "a".repeat(64),
    );
    const drop = scripts.dropPins("repo_1", [
      "refs/frm/gate/g1",
      "refs/frm/pin/S1",
    ]);
    for (const script of [scripts.listPins(), drop]) {
      execFileSync("sh", ["-n", "-c", script]);
    }
    expect(drop).toContain(
      'case "$ref" in refs/frm/gate/*|refs/frm/pin/*) ;; *) echo "refused: $ref"; exit 4 ;; esac',
    );
    expect(drop).toContain(
      `printf 'delete %s\\n' refs/frm/gate/g1 refs/frm/pin/S1 | ${SAFE_GIT_LINE} --git-dir="$d" update-ref --stdin`,
    );
    expect(drop).not.toMatch(/push|receive-pack|--mirror|\sgc\s|prune/);
  });

  test("parsePins keeps well-formed pin lines only", () => {
    expect(
      parsePins(
        [
          "repo_1 refs/frm/gate/g1",
          "repo_1 refs/frm/gate/g1",
          "repo_1 refs/frm/gate/deep/x",
          "repo_1 refs/heads/main",
          "bad name refs/frm/gate/g1",
          "repo_2 refs/frm/pin/S2",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      { name: "repo_1", ref: "refs/frm/gate/g1" },
      { name: "repo_2", ref: "refs/frm/pin/S2" },
    ]);
  });
});
