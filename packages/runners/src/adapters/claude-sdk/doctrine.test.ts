// the doctrine the adapter appends to the system prompt, read where the executor keeps
// the worktree. Every case runs twice: on this host (a local executor), and through the fixed
// program a container runs, by a stand-in that is a container to the adapter but runs here (as
// home-file.test.ts's is).
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
import {
  LocalExecutor,
  SlotCounter,
  type Argv,
  type Executor,
} from "@bayon/executors";
import { afterAll, describe, expect, test } from "vitest";
import {
  DOCTRINE_CAP_BYTES,
  DOCTRINE_FILES,
  readDoctrine,
  truncationMarker,
} from "./doctrine.js";
import { DEFAULTS } from "./registration.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "frm-sdk-doctrine-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const local = new LocalExecutor({ id: "local", slots: new SlotCounter(4) });

/** A container to the adapter, running on this host; it records every argv it is handed. */
function standIn(): { readonly ex: Executor; readonly argv: Argv[] } {
  const argv: Argv[] = [];
  const ex: Executor = {
    id: "ctr-stand-in",
    kind: "container",
    capabilities: { pty: false },
    envPath: process.env["PATH"] ?? "/usr/bin:/bin",
    prepare: (spec) => local.prepare(spec),
    exec: (a, opts) => {
      argv.push(a);
      return local.exec(a, opts);
    },
    pty: (a, opts) => local.pty(a, opts),
    probe: (ref) => local.probe(ref),
    cleanup: (ref, mode) => local.cleanup(ref, mode),
    capacity: () => local.capacity(),
    health: (limits) => local.health(limits),
  };
  return { ex, argv };
}

let n = 0;
/** A worktree holding `files` (path under it → content). */
function worktree(files: Record<string, string> = {}): string {
  const dir = join(base, `w${++n}`);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

test("what is delivered is what is hashed: the two root files, and no settings file", () => {
  expect(DEFAULTS.hashInputs).toEqual([...DOCTRINE_FILES]);
  expect(DOCTRINE_FILES).toEqual(["CLAUDE.md", ".claude/CLAUDE.md"]);
  expect(DEFAULTS.settingSources).toEqual([]);
});

describe.each([
  ["on this host", () => local],
  ["in a container", () => standIn().ex],
])("readDoctrine %s", (_where, executor) => {
  test("no file, or empty files, is no doctrine", async () => {
    expect(await readDoctrine(executor(), worktree())).toEqual({
      ok: true,
      value: undefined,
    });
    const empty = worktree({ "CLAUDE.md": "", ".claude/CLAUDE.md": "" });
    expect(await readDoctrine(executor(), empty)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("both files, root first, each under its own heading; CLAUDE.local.md is not read", async () => {
    const dir = worktree({
      "CLAUDE.md": "root rules\n",
      ".claude/CLAUDE.md": "dot rules\n",
      "CLAUDE.local.md": "personal rules\n",
    });
    const read = await readDoctrine(executor(), dir);
    if (!read.ok || read.value === undefined) throw new Error("no doctrine");
    const text = read.value;
    expect(text).toContain(
      "Contents of CLAUDE.md (project instructions, checked into the codebase):\n\nroot rules\n",
    );
    expect(text).toContain(
      "Contents of .claude/CLAUDE.md (project instructions, checked into the codebase):\n\ndot rules\n",
    );
    expect(text.indexOf("root rules")).toBeLessThan(text.indexOf("dot rules"));
    expect(text).not.toContain("personal rules");
    expect(text).not.toContain("[truncated");
  });

  test("an @import is passed on as written, not followed", async () => {
    const dir = worktree({
      "CLAUDE.md": "See @docs/more.md\n",
      "more.md": "imported text\n",
    });
    const read = await readDoctrine(executor(), dir);
    expect(read.ok && read.value).toContain("See @docs/more.md");
    expect(read.ok && read.value).not.toContain("imported text");
  });

  test("past the cap: the content stops at it, with one marker line, and the next file is named only", async () => {
    const big = "x".repeat(DOCTRINE_CAP_BYTES + 10_000);
    const dir = worktree({
      "CLAUDE.md": big,
      ".claude/CLAUDE.md": "dot rules",
    });
    const read = await readDoctrine(executor(), dir);
    if (!read.ok || read.value === undefined) throw new Error("no doctrine");
    const text = read.value;
    expect(text).toContain(`\n${truncationMarker("CLAUDE.md")}`);
    expect(text).toContain(truncationMarker(".claude/CLAUDE.md"));
    expect(text).not.toContain("dot rules");
    expect(text.match(/x{2,}/)?.[0].length).toBe(DOCTRINE_CAP_BYTES);
    // The cap plus the framing: nothing near the file's full size.
    expect(bytes(text)).toBeLessThan(DOCTRINE_CAP_BYTES + 2_000);
  });

  test("the cap is shared: the second file gets what the first left", async () => {
    const first = "a".repeat(DOCTRINE_CAP_BYTES - 5);
    const dir = worktree({
      "CLAUDE.md": first,
      ".claude/CLAUDE.md": "bbbbbbbbbb",
    });
    const read = await readDoctrine(executor(), dir);
    if (!read.ok || read.value === undefined) throw new Error("no doctrine");
    expect(read.value).toContain(`${first}\n`);
    expect(read.value).toContain(
      `bbbbb\n${truncationMarker(".claude/CLAUDE.md")}`,
    );
    expect(read.value).not.toContain(truncationMarker("CLAUDE.md"));
  });

  test("a character the cap cuts in half is left out, not garbled", async () => {
    // "é" is two bytes: the cap falls between them.
    const dir = worktree({
      "CLAUDE.md": `${"a".repeat(DOCTRINE_CAP_BYTES - 1)}é and more`,
    });
    const read = await readDoctrine(executor(), dir);
    if (!read.ok || read.value === undefined) throw new Error("no doctrine");
    expect(read.value).not.toContain("�");
    expect(read.value).toContain(
      `${"a".repeat(DOCTRINE_CAP_BYTES - 1)}\n${truncationMarker("CLAUDE.md")}`,
    );
  });

  test("a symlink inside the worktree is followed (CLAUDE.md -> AGENTS.md)", async () => {
    const dir = worktree({ "AGENTS.md": "shared agent rules\n" });
    symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
    const read = await readDoctrine(executor(), dir);
    expect(read.ok && read.value).toContain("shared agent rules");
  });

  test("a file that resolves outside the worktree, or is not a file, is refused", async () => {
    const secret = join(base, `outside-${++n}.txt`);
    writeFileSync(secret, "operator's file\n");
    const out = worktree();
    symlinkSync(secret, join(out, "CLAUDE.md"));
    expect(await readDoctrine(executor(), out)).toEqual({
      ok: false,
      error: expect.objectContaining({
        class: "validation",
        message: "CLAUDE.md resolves outside the worktree",
      }),
    });
    const up = worktree();
    symlinkSync(secret, join(up, ".claude", "CLAUDE.md"));
    expect(await readDoctrine(executor(), up)).toMatchObject({
      ok: false,
      error: { message: ".claude/CLAUDE.md resolves outside the worktree" },
    });
    const dir = worktree();
    mkdirSync(join(dir, "CLAUDE.md"));
    expect(await readDoctrine(executor(), dir)).toMatchObject({
      ok: false,
      error: {
        class: "validation",
        message: "CLAUDE.md is not a regular file",
      },
    });
  });

  test("a FIFO in its place is refused at once, never waited on", async () => {
    const dir = worktree();
    execFileSync("mkfifo", [join(dir, "CLAUDE.md")]);
    expect(await readDoctrine(executor(), dir)).toMatchObject({
      ok: false,
      error: {
        class: "validation",
        message: "CLAUDE.md is not a regular file",
      },
    });
  });

  test("a dangling symlink, or .claude as a file, is no doctrine", async () => {
    const dangling = worktree();
    symlinkSync("nowhere.md", join(dangling, "CLAUDE.md"));
    expect(await readDoctrine(executor(), dangling)).toEqual({
      ok: true,
      value: undefined,
    });
    const flat = join(base, `w${++n}`);
    mkdirSync(flat);
    writeFileSync(join(flat, ".claude"), "not a directory");
    expect(await readDoctrine(executor(), flat)).toEqual({
      ok: true,
      value: undefined,
    });
  });
});

test("in a container, one fixed program per file, the paths as its arguments", async () => {
  const { ex, argv } = standIn();
  const dir = worktree({ "CLAUDE.md": "rules" });
  expect((await readDoctrine(ex, dir)).ok).toBe(true);
  expect(argv).toHaveLength(DOCTRINE_FILES.length);
  for (const [i, rel] of DOCTRINE_FILES.entries()) {
    expect(argv[i]?.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(argv[i]?.slice(3, 6)).toEqual(["frm-doctrine", dir, rel]);
  }
});
