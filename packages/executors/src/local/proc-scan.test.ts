// The local orphan scan: pure parsers,
// the scan through a stand-in ps for both layouts, and real processes on this host. A sentinel
// secret in a child's environment never comes back in a result or an error.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { SlotCounter } from "../slots.js";
import { LocalExecutor } from "./local.js";
import { readProc } from "./proc-info.js";
import {
  excludedPids,
  listTaggedProcs,
  parseCommands,
  parseRows,
  runPsWith,
  tagsOf,
  type ProcRow,
  type RunPs,
} from "./proc-scan.js";

const TAG = "fh-0123456789abcdef01234567";
const OTHER = "fh-fedcba9876543210fedcba98";
const SENTINEL = "sk-sentinel-4f1c9a7e-do-not-leak";
const WAIT = { timeout: 10_000, interval: 50 };

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterAll(() => {
  for (const c of children) {
    if (c.pid === undefined || c.exitCode !== null || c.signalCode !== null)
      continue;
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {
      // gone already
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A waiting program leading its own group, with exactly this environment (and PATH). */
const WAITS: readonly [string, ...string[]] = [
  // node, not /bin/sleep: macOS hides a platform binary's environment from `ps -E`.
  process.execPath,
  "-e",
  "setTimeout(() => {}, 30000)",
];

function sleeper(
  env: Readonly<Record<string, string>>,
  argv: readonly [string, ...string[]] = WAITS,
): ChildProcess {
  const [file, ...args] = argv;
  const child = spawn(file, args, {
    env: { PATH: process.env["PATH"] ?? "/bin:/usr/bin", ...env },
    detached: true,
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

const START = Date.UTC(2026, 8, 12, 15, 21, 40) / 1000;
const row = (pid: number, o: Partial<Omit<ProcRow, "pid">> = {}): string => {
  const r = { ppid: 1, pgid: pid, uid: 501, stat: "S", ...o };
  return `  ${pid} ${r.ppid} ${r.pgid} ${r.uid} ${o.zombie === true ? "Z" : r.stat}   Sat Sep 12 15:21:40 2026`;
};

describe("the pure parsers", () => {
  test("tagsOf: exactly one of each tag, else null", () => {
    expect(tagsOf(["A=1", `FRM_HOME_TAG=${TAG}`, "FRM_SESSION_ID=s"])).toEqual({
      homeTag: TAG,
      sessionId: "s",
    });
    expect(tagsOf([`FRM_HOME_TAG=${TAG}`])).toBeNull();
    expect(tagsOf(["FRM_SESSION_ID=s"])).toBeNull();
    expect(
      tagsOf([`FRM_HOME_TAG=${TAG}`, "FRM_SESSION_ID=s", "FRM_SESSION_ID=x"]),
    ).toBeNull();
    expect(
      tagsOf([
        `FRM_HOME_TAG=${TAG}`,
        `FRM_HOME_TAG=${OTHER}`,
        "FRM_SESSION_ID=s",
      ]),
    ).toBeNull();
    expect(tagsOf([`XFRM_HOME_TAG=${TAG}`, "FRM_SESSION_ID=s"])).toBeNull();
  });

  test("parseRows reads pid, ppid, pgid, uid, zombie and start; a line it cannot read is skipped", () => {
    expect(
      parseRows(
        [
          row(812),
          row(900, { ppid: 812, pgid: 812, zombie: true }),
          "junk",
        ].join("\n"),
      ),
    ).toEqual([
      { pid: 812, ppid: 1, pgid: 812, uid: 501, zombie: false, start: START },
      { pid: 900, ppid: 812, pgid: 812, uid: 501, zombie: true, start: START },
    ]);
  });

  test("parseCommands keeps each record's first line: a continuation line is nobody's", () => {
    const m = parseCommands(
      "  12 sleep 30 A=1\nFRM_SESSION_ID=forged\n  13 sh",
    );
    expect([...m.entries()]).toEqual([
      [12, "sleep 30 A=1"],
      [13, "sh"],
    ]);
  });

  test("excludedPids: the scanner and every ancestor, up the ppid chain", () => {
    const rows = parseRows(
      [row(50, { ppid: 40 }), row(40, { ppid: 30 }), row(30), row(60)].join(
        "\n",
      ),
    );
    expect([...excludedPids(rows, 50)].toSorted()).toEqual([30, 40, 50]);
  });
});

describe("the scan through a stand-in ps", () => {
  const env = (sid: string, tag = TAG) =>
    `PATH=/bin SECRET=${SENTINEL} FRM_HOME_TAG=${tag} FRM_SESSION_ID=${sid}`;
  const meta = [
    row(100), // ours
    row(101), // tags in argv only
    row(102), // a newline splits its env: the continuation is nobody's
    row(103, { uid: 502 }), // another user
    row(104, { zombie: true }), // a zombie
    row(105, { ppid: 99 }), // the scanner
    row(99), // its parent
    row(106, { pgid: 105 }), // in the scanner's group
    row(107), // another home
    row(108), // two session ids
  ].join("\n");
  const plain = [
    "  100 sleep 30",
    `  101 sleep 30 FRM_HOME_TAG=${TAG} FRM_SESSION_ID=S-argv`,
    "  102 sleep 30",
    "  103 sleep 30",
    "  104 sleep 30",
    "  105 node scan",
    "  99 node parent",
    "  106 sleep 30",
    "  107 sleep 30",
    "  108 sleep 30",
  ].join("\n");
  const withEnv = [
    `  100 sleep 30 ${env("S-ours")}`,
    `  101 sleep 30 FRM_HOME_TAG=${TAG} FRM_SESSION_ID=S-argv PATH=/bin`,
    `  102 sleep 30 PATH=/bin FOO=a`,
    `FRM_HOME_TAG=${TAG} FRM_SESSION_ID=S-forged`,
    `  103 sleep 30 ${env("S-uid")}`,
    `  104 sleep 30 ${env("S-zombie")}`,
    `  105 node scan ${env("S-self")}`,
    `  99 node parent ${env("S-parent")}`,
    `  106 sleep 30 ${env("S-group")}`,
    `  107 sleep 30 ${env("S-other", OTHER)}`,
    `  108 sleep 30 ${env("S-twice")} FRM_SESSION_ID=S-again`,
  ].join("\n");
  const ps: RunPs = async (args) =>
    args.some((a) => a.includes("lstart"))
      ? meta
      : args.includes("-E")
        ? withEnv
        : plain;

  test("darwin: only ours; argv, a split line, another uid, a zombie, the scanner's ancestry and group, another home and two ids are not", async () => {
    const found = await listTaggedProcs({
      homeTag: TAG,
      uid: 501,
      selfPid: 105,
      platform: "darwin",
      ps,
    });
    expect(found).toEqual([
      {
        pid: 100,
        start: START,
        uid: 501,
        pgid: 100,
        sessionId: "S-ours",
        homeTag: TAG,
      },
    ]);
    expect(JSON.stringify(found)).not.toContain(SENTINEL);
  });

  test("an inherited session id is never listed", async () => {
    const found = await listTaggedProcs({
      homeTag: TAG,
      uid: 501,
      selfPid: 105,
      inheritedSessionId: "S-ours",
      platform: "darwin",
      ps,
    });
    expect(found).toEqual([]);
  });

  test("linux: each same-uid candidate's environ, NUL-split; a value holding another tag is only a value", async () => {
    const environ: Record<number, string> = {
      100: `PATH=/bin\0SECRET=${SENTINEL}\0FRM_HOME_TAG=${TAG}\0FRM_SESSION_ID=S-ours\0`,
      101: `FOO=a FRM_HOME_TAG=${TAG} FRM_SESSION_ID=S-forged\0PATH=/bin\0`,
      102: `FOO=x\nFRM_HOME_TAG=${TAG}\0FRM_SESSION_ID=S-nl\0`,
      103: `FRM_HOME_TAG=${TAG}\0FRM_SESSION_ID=S-uid\0`,
    };
    const read: number[] = [];
    const found = await listTaggedProcs({
      homeTag: TAG,
      uid: 501,
      selfPid: 105,
      platform: "linux",
      ps,
      readEnviron: async (pid) => {
        read.push(pid);
        const text = environ[pid];
        return text === undefined ? null : Buffer.from(text);
      },
    });
    expect(found.map((p) => p.sessionId)).toEqual(["S-ours"]);
    expect(read).not.toContain(103); // another uid's environ is never read
    expect(JSON.stringify(found)).not.toContain(SENTINEL);
  });
});

describe("secrets never leave the scan (HIGH-2)", () => {
  test("a ps that fails with an environment on its output: the error names the ps and nothing it printed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frm-ps-"));
    dirs.push(dir);
    const fake = join(dir, "ps");
    writeFileSync(
      fake,
      `#!/bin/sh\necho "SECRET=${SENTINEL}"\necho "SECRET=${SENTINEL}" >&2\nexit 3\n`,
    );
    chmodSync(fake, 0o755);
    const thrown: unknown = await runPsWith(fake)(["-A", "-E"]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toMatchObject({ class: "internal" });
    const error = thrown as Error & { cause?: unknown };
    expect(error.message).toBe("ps -A failed (3)");
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(thrown)).not.toContain(SENTINEL);
    expect(String(thrown)).not.toContain(SENTINEL);
  });
});

describe("the scan of this host's real processes", { timeout: 20_000 }, () => {
  test("both tags of ours are listed at the pid's start time; one tag, another home's, argv only or a newline-forged value are not; the sentinel never comes back", async () => {
    const both = sleeper({
      FRM_HOME_TAG: TAG,
      FRM_SESSION_ID: "S-both",
      SECRET: SENTINEL,
    });
    sleeper({ FRM_HOME_TAG: TAG, SECRET: SENTINEL });
    sleeper({ FRM_SESSION_ID: "S-only", SECRET: SENTINEL });
    sleeper({ FRM_HOME_TAG: OTHER, FRM_SESSION_ID: "S-other" });
    sleeper({}, [
      "sh",
      "-c",
      "sleep 30",
      `FRM_HOME_TAG=${TAG}`,
      "FRM_SESSION_ID=S-argv",
    ]);
    sleeper({ FOO: `a\nFRM_HOME_TAG=${TAG} FRM_SESSION_ID=S-forged` });
    await vi.waitFor(async () => {
      const found = await listTaggedProcs({ homeTag: TAG });
      expect(found.map((p) => p.sessionId)).toEqual(["S-both"]);
      const info = await readProc(both.pid ?? 0);
      expect(found[0]).toMatchObject({
        pid: both.pid,
        start: info?.start,
        uid: process.getuid?.(),
      });
      expect(JSON.stringify(found)).not.toContain(SENTINEL);
    }, WAIT);
  });

  test("LocalExecutor.listOwned refs pin the start time: a ref with another start time is a reused pid, and cleanup sends it nothing", async () => {
    const ex = new LocalExecutor({
      id: "local",
      slots: new SlotCounter(1),
      homeTag: TAG,
    });
    sleeper({ FRM_HOME_TAG: TAG, FRM_SESSION_ID: "S-ref" });
    const owned = await vi.waitFor(async () => {
      const mine = (await ex.listOwned()).filter(
        (o) => o.sessionId === "S-ref",
      );
      expect(mine).toMatchObject([{ kind: "process", homeTag: TAG }]);
      return mine;
    }, WAIT);
    const ref = owned[0]?.ref ?? "";
    const [, pid, start] = ref.split(":").map(Number);
    await ex.cleanup(`local:${pid}:${(start ?? 0) - 1}`, "hard");
    expect(await ex.probe(ref)).toBe("alive");
    await ex.cleanup(ref, "hard");
    await vi.waitFor(
      async () => expect(await ex.probe(ref)).toBe("dead"),
      WAIT,
    );
  });

  test.runIf(process.platform === "darwin")(
    "macOS: a platform binary hides its environment from ps -E, so a tagged /bin/sleep is never listed (fail-safe: left alone)",
    async () => {
      const hidden = sleeper(
        { FRM_HOME_TAG: TAG, FRM_SESSION_ID: "S-platform" },
        ["/bin/sleep", "30"],
      );
      await vi.waitFor(async () => {
        expect(await readProc(hidden.pid ?? 0)).not.toBeNull();
      }, WAIT);
      const found = await listTaggedProcs({ homeTag: TAG });
      expect(found.map((p) => p.sessionId)).not.toContain("S-platform");
    },
  );

  test("without a home tag, listOwned lists nothing", async () => {
    const ex = new LocalExecutor({ id: "local", slots: new SlotCounter(1) });
    sleeper({ FRM_HOME_TAG: TAG, FRM_SESSION_ID: "S-untagged-executor" });
    expect(await ex.listOwned()).toEqual([]);
  });
});
