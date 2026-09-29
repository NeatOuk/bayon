// The conformance workspace on a container executor over the loopback: the
// real ContainerExecutor and its scripts on a stand-in docker, so the push into its mirror, the
// clone in the "container" and every read run as on a docker host, only locally.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { systemClock } from "@bayon/core";
import { unwrap } from "@bayon/db/testing";
import {
  FaultExecutor,
  createLocalWorkspace,
  type SessionDirs,
  type WorkspacePort,
} from "@bayon/runners/conformance";
import { pino } from "pino";
import { afterAll, beforeAll, expect, test } from "vitest";
import { DEFAULT_SETTINGS } from "../lifecycle/settings.js";
import { tempHome } from "../lifecycle/testing/fixtures.js";
import { pendingOf } from "./recover.js";
import {
  CONFORMANCE_MIRROR,
  remoteWorkspace,
} from "./remote-workspace-port.js";
import { loopbackContainer, type Loopback } from "./testing.js";

const CTR = "ctr-ws";
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let home: ReturnType<typeof tempHome>;
let ctr: Loopback;

beforeAll(() => {
  home = tempHome("frm-rws-");
  ctr = loopbackContainer(home.path, CTR);
});

afterAll(async () => {
  await ctr.executor.close();
  home.cleanup();
});

async function port(
  run: string,
): Promise<{ readonly w: WorkspacePort; readonly journal: string }> {
  const dir = join(home.path, "runs", run);
  mkdirSync(dir, { recursive: true });
  const journal = join(dir, "placed");
  const w = unwrap(
    await remoteWorkspace({
      root: join(dir, "work"),
      journal,
      executor: ctr.executor,
      exec: {
        settings: DEFAULT_SETTINGS,
        clock: systemClock,
        frmHome: home.path,
        path: process.env["PATH"] ?? "",
        log: pino({ level: "silent" }),
      },
      scratchRoot: join(home.path, "scratch"),
    }),
  );
  return { w, journal };
}

/** As the harness opens a session: placed, prepared by the executor, then created. */
async function open(w: WorkspacePort, sid: string): Promise<SessionDirs> {
  const root = await w.place(sid);
  await ctr.executor.prepare({ sessionId: sid, root });
  return w.create(sid);
}

/**
 * The first test's timeout, from what it runs: two ports (the fixture seeded with five
 * host gits, then pushed into the executor's mirror), two sessions opened (five prepare scripts,
 * then the clone in the container) and two disposes, about 120 processes. Idle it takes 1.0-1.5 s;
 * beside one or two concurrent full suites, 2.1 s median and 3.7 s worst of 40 runs, too close to
 * vitest's 5 s default. Each budget is about 3x the worst loaded run of its operation: a port
 * 0.82 s, an open 1.28 s (a file's first also pays macOS's check of the freshly written stand-in
 * docker on its first exec, 0.2-0.6 s), a dispose 0.27 s; the three host reads (0.11 s) fit the
 * slack. Past the sum it is a hang (a lock, a prompt), not load.
 */
const PORT_MS = 2_500;
const OPEN_MS = 4_000;
const DISPOSE_MS = 1_000;
const TWO_RUNS_MS = 2 * PORT_MS + 2 * OPEN_MS + 2 * DISPOSE_MS;

test(
  "the fixture is pushed under its content address, and each session clones it in its container",
  async () => {
    const { w, journal } = await port("r1");
    const d = await open(w, "S1");
    const mirror = join(ctr.remoteRoot, "mirror", `${CONFORMANCE_MIRROR}.git`);
    const ref = `refs/heads/fixture-${d.baseSha.slice(0, 12)}`;
    const refs = () =>
      git(mirror, "for-each-ref", "--format=%(refname) %(objectname)");
    expect(refs()).toBe(`${ref} ${d.baseSha}`);
    const root = join(ctr.remoteRoot, "work", "S1");
    expect(d).toMatchObject({
      root,
      cwd: join(root, "work"),
      homeDir: join(root, ".frm", "home"),
      tmpDir: join(root, ".frm", "tmp"),
    });
    expect(git(d.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("frm/S1");
    expect(git(d.cwd, "rev-parse", "HEAD")).toBe(d.baseSha);
    expect(readFileSync(journal, "utf8")).toBe(`placed ${CTR} S1\n`);
    // Another run commits the same fixture: the same commit, so its push changes nothing.
    const again = await port("r2");
    expect((await open(again.w, "S2")).baseSha).toBe(d.baseSha);
    expect(refs()).toBe(`${ref} ${d.baseSha}`);
    await w.dispose();
    await again.w.dispose();
  },
  TWO_RUNS_MS,
);

test("reads answer from the session's container, as the reference's do from its own worktree", async () => {
  const { w } = await port("r3");
  const d = await open(w, "S3");
  const ref = await createLocalWorkspace();
  try {
    const local = await ref.create("S3L");
    for (const cwd of [d.cwd, local.cwd]) {
      writeFileSync(join(cwd, "README.md"), "# conformance fixture\nmore\n");
      writeFileSync(join(cwd, "NOTES.md"), "conformance\n");
      rmSync(join(cwd, "add.js"));
      mkdirSync(join(cwd, "state", "deep"), { recursive: true });
      writeFileSync(join(cwd, "state", "deep", "a.json"), "{}");
    }
    ctr.executor.cwds.length = 0;
    expect(await w.diff(d.cwd)).toEqual(await ref.diff(local.cwd));
    for (const cwd of [d.cwd, local.cwd]) {
      writeFileSync(join(cwd, "state", "locked"), "secret");
      chmodSync(join(cwd, "state", "locked"), 0o000); // hashed as empty, never an abort (L1)
    }
    const snap = await w.snapshot(join(d.cwd, "state"));
    expect(snap).toEqual(await ref.snapshot(join(local.cwd, "state")));
    expect([...snap.keys()].sort()).toEqual(["deep/a.json", "locked"]);
    expect(await w.exists(join(d.cwd, "NOTES.md"))).toBe(true);
    expect(await w.exists(join(d.cwd, "add.js"))).toBe(false);
    expect(await w.read(join(d.cwd, "NOTES.md"))).toBe("conformance\n");
    expect(await w.read(join(d.cwd, "missing"))).toBeUndefined();
    // Every read ran in the session's container, rooted at its root.
    expect(ctr.executor.cwds.length).toBeGreaterThan(0);
    expect(new Set(ctr.executor.cwds)).toEqual(new Set([d.root]));
  } finally {
    await ref.dispose();
    await w.dispose();
  }
});

test("paths with .., under no session, and outputs over their cap are refused; the fault wrapper never sees a read", async () => {
  const { w } = await port("r4");
  const d = await open(w, "S4");
  const fault = new FaultExecutor(ctr.executor);
  ctr.executor.cwds.length = 0;
  await expect(w.read(`${d.cwd}/../../S1/work/README.md`)).rejects.toThrow(
    /\.\./,
  );
  await expect(w.read("/etc/hosts")).rejects.toThrow(/no session/);
  await expect(w.exists("relative/path")).rejects.toThrow(/not absolute/);
  expect(ctr.executor.cwds).toEqual([]); // refused before anything ran
  writeFileSync(join(d.cwd, "big.txt"), "x".repeat(1024 * 1024 + 16));
  await expect(w.read(join(d.cwd, "big.txt"))).rejects.toThrow(/over/);
  await w.diff(d.cwd);
  await w.snapshot(d.homeDir);
  // Test 3's no_respawn counts the runner's processes per cwd: no read may add one.
  expect(fault.argvOf(d.cwd)).toEqual([]);
  expect(fault.argvOf(d.root)).toEqual([]);
  await w.dispose();
});

test("a scratch dir is made in each later session, and its snapshot is the union of every copy", async () => {
  const { w } = await port("r5");
  await open(w, "S5");
  const decoy = await w.scratch("decoy-home");
  expect(w.scratchCopies?.(decoy)).toBe(0);
  await open(w, "S6");
  await open(w, "S7");
  expect(w.scratchCopies?.(decoy)).toBe(2);
  expect(existsSync(decoy)).toBe(true); // this host's dir stands in for each container's /tmp
  expect((await w.snapshot(decoy)).size).toBe(0);
  writeFileSync(join(decoy, "state.json"), "{}");
  expect([...(await w.snapshot(decoy)).keys()].sort()).toEqual([
    "S6/state.json",
    "S7/state.json",
  ]);
  await w.dispose();
});

test("release frees a session's container and root by label and journals it; dispose frees the rest, or says what it left", async () => {
  const { w, journal } = await port("r6");
  const d = await open(w, "S8");
  expect((await ctr.executor.listOwned()).map((o) => o.sessionId)).toContain(
    "S8",
  );
  await w.release?.("S8");
  expect(
    (await ctr.executor.listOwned()).map((o) => o.sessionId),
  ).not.toContain("S8");
  expect(existsSync(d.root)).toBe(false);
  await open(w, "S9");
  ctr.executor.failRelease = true;
  await expect(w.dispose()).rejects.toThrow(/S9/);
  ctr.executor.failRelease = false;
  expect([...pendingOf(readFileSync(journal, "utf8")).keys()]).toEqual(["S9"]);
  await w.dispose();
  expect(pendingOf(readFileSync(journal, "utf8")).size).toBe(0);
  expect(
    (await ctr.executor.listOwned()).map((o) => o.sessionId),
  ).not.toContain("S9");
});
