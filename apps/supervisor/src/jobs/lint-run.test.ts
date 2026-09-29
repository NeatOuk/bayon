import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { lintFindings } from "@bayon/core";
import { LINT_OUTPUT_MAX, runCommand, runLintJob } from "./lint-run.js";

// The lint_check gate's commands, against a real directory and real child processes:
// the part worth pinning is which failure is the fleet's and which is the builder's -- and, since
//, that a command which *tries* to write the supervisor's home cannot.

const root = mkdtempSync(join(tmpdir(), "frm-lint-run-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const logPath = (): string => join(root, `lint-${++n}.log`);

/** A node one-liner as an argv, so every test runs a real process with no shell anywhere. */
const node = (script: string): [string, ...string[]] => [
  process.execPath,
  "-e",
  script,
];

const REPO = "foreman";

/**
 * The supervisor's own home, stood in for so the hostile half of these tests can be run for real:
 * the directory a repo-declared command must never reach, and which the parent environment below
 * carries every name that would take it there.
 */
const SUPERVISOR_HOME = join(root, "supervisor-home");
/** This session's private home and tmp (`jobHome`'s answer), where its commands are confined. */
const AT = { home: join(root, "session-home"), tmp: join(root, "session-tmp") };
for (const dir of [SUPERVISOR_HOME, AT.home, AT.tmp]) {
  mkdirSync(dir, { recursive: true });
}

/** The job's own environment, as hostile as it can be short of a bug in `buildEnv`. */
const ENV = {
  PATH: process.env["PATH"],
  HOME: SUPERVISOR_HOME,
  TMPDIR: SUPERVISOR_HOME,
  XDG_CONFIG_HOME: join(SUPERVISOR_HOME, ".config"),
  XDG_CACHE_HOME: join(SUPERVISOR_HOME, ".cache"),
  XDG_DATA_HOME: join(SUPERVISOR_HOME, ".local", "share"),
  XDG_STATE_HOME: join(SUPERVISOR_HOME, ".local", "state"),
};

/** Every path under `dir`, relative to it: what a marker hunt reads. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)));
}

/** How long a spawned child may take to start under a loaded, parallel test run. */
const WAIT = { timeout: 10_000, interval: 10 };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH: gone
  }
}

// A repo's declared commands are repo-controlled code -- `pnpm -w lint` resolves through
// a `package.json` script a builder agent can edit -- run as the supervisor's own uid. Which names
// the child env holds is job-env.test.ts's; what these do is run a command that actually *tries* to
// reach the supervisor's home and watch it fail, because a test that lists keys passes happily
// against a list that is still short one name.
describe("a repo command cannot reach the supervisor's home", () => {
  // Every name that would take it there is in the parent env above, set to the supervisor's home.
  const PLANTS = [
    "HOME",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ];
  const planter = `
    const fs = require('node:fs'), p = require('node:path');
    for (const name of ${JSON.stringify(PLANTS)}) {
      const dir = process.env[name];
      if (!dir) { process.stdout.write('NO ' + name); process.exit(9); }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p.join(dir, 'PLANTED'), name);
    }
    process.stdout.write('all clean');
  `;

  test("its writes land in this session's home, and the legitimate work still passes", async () => {
    const log = logPath();
    const r = await runLintJob({
      cwd: root,
      repoId: REPO,
      install: null,
      lint: node(planter),
      logPath: log,
      env: ENV,
      at: AT,
    });
    // The marker never appears where the supervisor keeps its dotfiles. Not "the key is set" --
    // the file is not there, after a command that did everything it could to put it there.
    expect(tree(SUPERVISOR_HOME)).toEqual([]);
    // It did land -- so the command ran, wrote, and was simply confined. A test that only asserted
    // the absence above would pass just as well against a command that never started.
    expect(tree(AT.home)).toContain("PLANTED");
    // And the job's real work is untouched: a clean exit, the log written, no finding.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.exitCode).toBe(0);
    expect(lintFindings(REPO, r.value)).toEqual([]);
    expect(readFileSync(log, "utf8")).toContain("all clean");
  });

  // The other half, and the reason `HOME` alone is not the fix: floor reaches only the
  // git *we* invoke. A repo's own `git` call read the host's system config and whatever
  // `$HOME/.gitconfig` the install command that ran a moment earlier had just written -- and
  // `core.pager`, `core.sshCommand` and `credential.helper` are all command lines.
  test("its git reads no global config, not even one planted in the session's own home", async () => {
    writeFileSync(
      join(AT.home, ".gitconfig"),
      "[user]\n\tname = planted-by-the-repo\n",
    );
    writeFileSync(
      join(SUPERVISOR_HOME, ".gitconfig"),
      "[user]\n\tname = the-operator\n",
    );
    const e = await runCommand(["git", "config", "--get", "user.name"], {
      // A temp directory, so nothing here is a repository and no repo-local config can answer.
      cwd: root,
      env: ENV,
      at: AT,
    });
    expect(e.output).not.toContain("planted-by-the-repo");
    expect(e.output).not.toContain("the-operator");
    expect(e.output.trim()).toBe("");
    // `git config --get` with nothing to get exits 1: the command ran, and found no value.
    expect(e.code).toBe(1);
  });
});

describe("runCommand", () => {
  test("an exit code and the two streams interleaved", async () => {
    const e = await runCommand(
      node(
        "process.stdout.write('out');process.stderr.write('err');process.exit(3)",
      ),
      { cwd: root, env: ENV, at: AT },
    );
    expect(e.code).toBe(3);
    expect(e.output).toContain("out");
    expect(e.output).toContain("err");
    expect(e.overflow).toBe(false);
  });

  // A command that is not on PATH never runs at all: an `error`, not an exit. Reported with no
  // code, so the finding says "did not exit normally" rather than reading as a clean pass.
  test("a command that does not exist has no code, and its message survives", async () => {
    const e = await runCommand(["frm-no-such-linter-9e1a"], {
      cwd: root,
      env: ENV,
      at: AT,
    });
    expect(e.code).toBeNull();
    expect(e.output).not.toBe("");
  });

  test("output past the cap is marked, and stops being collected", async () => {
    const e = await runCommand(
      node(
        `const s='x'.repeat(100000);for(let i=0;i<40;i++)process.stdout.write(s);`,
      ),
      { cwd: root, env: ENV, at: AT },
    );
    expect(e.overflow).toBe(true);
    // Past the cap nothing more is kept: a linter that writes forever cannot exhaust this process.
    // The cap is tested with the chunk counted, so it is a bound and not a bound plus one chunk.
    expect(e.output.length).toBeGreaterThan(LINT_OUTPUT_MAX / 2);
    expect(e.output.length).toBeLessThanOrEqual(LINT_OUTPUT_MAX);
  }, 20_000);

  // A pipe read ends where the kernel filled the buffer, not where a character does. Decoding each
  // chunk on its own (`d.toString("utf8")`) turns every straddling character into two replacement
  // characters — in the tail a finding quotes back to the builder. The offset byte is what makes
  // the split land mid-character at the 64 KiB boundary.
  test("a multi-byte character split across two pipe reads survives whole", async () => {
    const n = 200_000;
    const e = await runCommand(
      node(`process.stdout.write('x' + '\\u00e9'.repeat(${String(n)}))`),
      { cwd: root, env: ENV, at: AT },
    );
    expect(e.code).toBe(0);
    expect(e.output).not.toContain("�");
    expect(e.output.length).toBe(n + 1);
    expect(e.output.split("é").length - 1).toBe(n);
  }, 20_000);

  // The default stdio gives the child a stdin pipe nobody ever writes to or ends, so a command that
  // asks a question blocks on a read that only the gate's wall clock can end. `ignore` is an
  // immediate EOF: this child sees `end` and exits, rather than running out this test's timeout.
  test("the child gets no stdin: a command that reads it sees EOF at once", async () => {
    const e = await runCommand(
      node(
        "process.stdin.resume();process.stdin.on('end',()=>process.exit(7))",
      ),
      { cwd: root, env: ENV, at: AT },
    );
    expect(e.code).toBe(7);
  }, 20_000);

  // Both lessons are packages/executors' git.ts's, copied rather than relearned (review, LOW-1).
  // `pnpm -w lint` is a supervisor of its own: killing the process we spawned leaves its
  // descendants running repo-controlled code as the supervisor's uid, after the kill switch or the
  // gate clock has already said stop.
  test("a stop kills the whole tree, not only the command that fronts it", async () => {
    const pidFile = join(root, "grandchild.pid");
    const stop = new AbortController();
    const pending = runCommand(
      node(
        `const {spawn}=require('node:child_process');const fs=require('node:fs');
         const gc=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);
         fs.writeFileSync(process.argv[1],String(gc.pid));
         setInterval(()=>{},1000);`,
      ).concat(pidFile) as [string, ...string[]],
      { cwd: root, env: ENV, at: AT, signal: stop.signal },
    );
    const gc = await vi.waitFor(() => {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(pid).toBeGreaterThan(1);
      return pid;
    }, WAIT);
    stop.abort();
    expect((await pending).code).toBeNull();
    await vi.waitFor(() => expect(alive(gc)).toBe(false), WAIT);
  }, 20_000);

  // And the promise settles on the child's own exit after a kill: `close` waits for the last pipe,
  // which a descendant that left the group still holds (local/local.ts says the same).
  test("a stop settles even while a detached descendant holds the pipe", async () => {
    const pidFile = join(root, "escaped.pid");
    const stop = new AbortController();
    const pending = runCommand(
      node(
        `const {spawn}=require('node:child_process');const fs=require('node:fs');
         const gc=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],
           {detached:true,stdio:['ignore','inherit','inherit']});
         fs.writeFileSync(process.argv[1],String(gc.pid));
         setInterval(()=>{},1000);`,
      ).concat(pidFile) as [string, ...string[]],
      { cwd: root, env: ENV, at: AT, signal: stop.signal },
    );
    const escaped = await vi.waitFor(() => {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(pid).toBeGreaterThan(1);
      return pid;
    }, WAIT);
    stop.abort();
    expect((await pending).code).toBeNull();
    expect(alive(escaped)).toBe(true);
    process.kill(escaped, "SIGKILL");
  }, 20_000);
});

describe("runLintJob", () => {
  test("no install command, lint exits 0: a clean run and a log naming the command", async () => {
    const log = logPath();
    const r = await runLintJob({
      cwd: root,
      repoId: REPO,
      install: null,
      lint: node("process.stdout.write('all clean')"),
      logPath: log,
      env: ENV,
      at: AT,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.exitCode).toBe(0);
    expect(r.value.logPath).toBe(log);
    expect(lintFindings(REPO, r.value)).toEqual([]);
    const written = readFileSync(log, "utf8");
    expect(written).toContain("all clean");
    expect(written).toContain("[exit 0]");
  });

  test("the install runs first, and its output is in the log beside the lint's", async () => {
    const log = logPath();
    const r = await runLintJob({
      cwd: root,
      repoId: REPO,
      install: node("process.stdout.write('installed')"),
      lint: node("process.stdout.write('linted')"),
      logPath: log,
      env: ENV,
      at: AT,
    });
    expect(r.ok).toBe(true);
    const written = readFileSync(log, "utf8");
    expect(written.indexOf("installed")).toBeLessThan(
      written.indexOf("linted"),
    );
  });

  // The distinction this job exists to make. An install failure is the fleet's problem, so it is an
  // error the caller turns into a failed terminal event (gate: reviewer_error) — never a finding
  // blaming the builder's change for a cold cache. A lint failure is the answer the gate is for.
  test("a failing install is an error, and the lint command is never run", async () => {
    const log = logPath();
    const r = await runLintJob({
      cwd: root,
      repoId: REPO,
      install: node("process.stderr.write('no lockfile');process.exit(1)"),
      lint: node("process.stdout.write('SHOULD NOT RUN')"),
      logPath: log,
      env: ENV,
      at: AT,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("install command");
    expect(r.error.message).toContain("decides nothing about this change");
    expect(r.error.message).toContain(log);
    const written = readFileSync(log, "utf8");
    expect(written).toContain("no lockfile");
    expect(written).not.toContain("SHOULD NOT RUN");
  });

  test("a failing lint is a clean result with a non-zero exit: one blocker naming the command", async () => {
    const log = logPath();
    const r = await runLintJob({
      cwd: root,
      repoId: REPO,
      install: null,
      lint: node("process.stdout.write('[warn] src/a.ts');process.exit(1)"),
      logPath: log,
      env: ENV,
      at: AT,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.exitCode).toBe(1);
    const [finding, ...rest] = lintFindings(REPO, r.value);
    expect(rest).toEqual([]);
    expect(finding?.severity).toBe("blocker");
    expect(finding?.summary).toContain(process.execPath);
    expect(finding?.detail_md).toContain("[warn] src/a.ts");
    expect(finding?.detail_md).toContain(log);
  });

  test("an empty install command is no install at all", async () => {
    const r = await runLintJob({
      cwd: root,
      repoId: REPO,
      install: [],
      lint: node("process.exit(0)"),
      logPath: logPath(),
      env: ENV,
      at: AT,
    });
    expect(r.ok).toBe(true);
  });

  // We killed it at the cap, so `code: null` is ours and not the command's. Reported as a LintRun
  // it became `lintFindings`' "did not exit normally" — one blocker against the builder's change
  // for a verbose monorepo lint that was on its way to exiting 0. It is the fleet's failure, so it
  // is an `err` (the gate ends `reviewer_error`), exactly as a failing install is.
  test("a lint killed at the output cap is the fleet's failure, not a blocker on the change", async () => {
    const log = logPath();
    const r = await runLintJob({
      cwd: root,
      repoId: REPO,
      install: null,
      // Floods well past the cap. It declares no failure of its own and would exit 0 when its
      // writes drained — which the kill at the cap makes sure nobody ever learns.
      lint: node(
        `const s='x'.repeat(100000);for(let i=0;i<40;i++)process.stdout.write(s);`,
      ),
      logPath: log,
      env: ENV,
      at: AT,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("killed at the cap");
    expect(r.error.message).toContain("decides nothing about this change");
    expect(r.error.message).toContain(log);
    // The log is still written first, so the evidence path the message names exists.
    expect(readFileSync(log, "utf8")).toContain("output truncated");
  }, 20_000);

  // The install path discarded its `write()` Result: the message still said `Full output: <path>`
  // for a file that does not exist, and the install's output — carried nowhere else — was gone.
  test("an install failure whose log cannot be written carries its output inline instead", async () => {
    const r = await runLintJob({
      cwd: root,
      repoId: REPO,
      install: node("process.stderr.write('ENOLOCKFILE here');process.exit(1)"),
      lint: node("process.stdout.write('SHOULD NOT RUN')"),
      // A directory where a file must go: mkdir succeeds, writeFile cannot.
      logPath: root,
      env: ENV,
      at: AT,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("install command");
    expect(r.error.message).toContain("cannot write");
    // Never a path that was never written.
    expect(r.error.message).not.toContain(`Full output: ${root}`);
    expect(r.error.message).toContain("ENOLOCKFILE here");
  });

  test("a log path that cannot be written is an error, not a silent pass", async () => {
    const r = await runLintJob({
      cwd: root,
      repoId: REPO,
      install: null,
      lint: node("process.exit(0)"),
      // A directory where a file must go: mkdir succeeds, writeFile cannot.
      logPath: root,
      env: ENV,
      at: AT,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("cannot write");
  });
});
