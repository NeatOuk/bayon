import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_QA_CONFIG, type QaConfigFields, type Result } from "@bayon/core";
import { afterAll, describe, expect, test } from "vitest";
import { runQaJob, type QaJobResult } from "./qa-run.js";

// The qa_harness gate's job, against a real directory and real child processes. What is
// worth pinning is what the lint job pins one status earlier: which failure is the project's and
// which is the fleet's — and that neither the timeout nor the output cap can be mistaken for a
// broken change.
//
// Every fixture harness is a script written into the worktree and named as `node <path>`. That is
// both what a real QA command looks like (`qaArgv` refuses anything with a shell character in it,
// so a one-liner is not expressible) and a deliberate absence: naming a real test runner here would
// be this repository's habits leaking into a control plane meant for any project.

const root = mkdtempSync(join(tmpdir(), "frm-qa-run-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
interface Places {
  readonly cwd: string;
  readonly artifactsDir: string;
}

/** A fresh worktree and artifacts pair per case. */
function places(): Places {
  const id = `case-${String(++n)}`;
  const cwd = join(root, id, "worktree");
  const artifactsDir = join(root, id, "artifacts");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  return { cwd, artifactsDir };
}

const AT = { home: join(root, "session-home"), tmp: join(root, "session-tmp") };
for (const dir of [AT.home, AT.tmp]) mkdirSync(dir, { recursive: true });

const ENV = { PATH: process.env["PATH"] };

const VALUES = {
  ticket: "PROJ-7",
  external_key: "EXT-1",
  branch: "agent/PROJ-7",
};

/** A harness script in the worktree, and the command that runs it. */
function harness(at: Places, js: string, name = "harness.js"): string {
  writeFileSync(join(at.cwd, name), js);
  return `${process.execPath} ${join(at.cwd, name)}`;
}

const config = (over: Partial<QaConfigFields> = {}): QaConfigFields => ({
  ...NO_QA_CONFIG,
  mode: "command",
  ...over,
});

function job(
  at: Places,
  over: Partial<QaConfigFields>,
  o: {
    readonly secrets?: readonly (readonly [string, string])[];
    readonly timeoutMs?: number;
  } = {},
): Promise<Result<QaJobResult>> {
  return runQaJob({
    cwd: at.cwd,
    workspaceId: "ws",
    config: config(over),
    values: VALUES,
    secrets: o.secrets ?? [],
    artifactsDir: at.artifactsDir,
    env: ENV,
    at: AT,
    timeoutMs: o.timeoutMs ?? 20_000,
    now: () => 1_000,
  });
}

function unwrap(r: Result<QaJobResult>): QaJobResult {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const logOf = (at: Places): string =>
  readFileSync(join(at.artifactsDir, "qa.log"), "utf8");

describe("the verdict a real process produces", () => {
  test("a harness that exits 0 passes, and its whole output is on disk", async () => {
    const at = places();
    const out = unwrap(
      await job(at, { cmd: harness(at, "console.log('all good')") }),
    );
    expect(out.outcome).toEqual({ state: "passed" });
    expect(out.exitCode).toBe(0);
    expect(logOf(at)).toContain("all good");
    expect(logOf(at)).toContain("[exit 0]");
    // The run's facts on disk, which collect() turns into the gate's evidence.
    const facts = JSON.parse(
      readFileSync(join(at.artifactsDir, "qa-run.json"), "utf8"),
    ) as { command: string; exit_code: number; reports: string[] };
    expect(facts).toMatchObject({ exit_code: 0, reports: [] });
    expect(facts.command).toBe(out.command);
  });

  test("a harness that exits 1 fails with one blocking finding naming it", async () => {
    const at = places();
    const out = unwrap(
      await job(at, {
        cmd: harness(at, "console.log('2 checks failed');process.exit(1)"),
      }),
    );
    expect(out.outcome.state).toBe("failed");
    if (out.outcome.state !== "failed") return;
    expect(out.outcome.findings).toHaveLength(1);
    expect(out.outcome.findings[0]?.severity).toBe("blocker");
    expect(out.outcome.findings[0]?.summary).toContain(out.command);
    expect(out.outcome.findings[0]?.detail_md).toContain("2 checks failed");
    expect(out.outcome.findings[0]?.detail_md).toContain(out.logPath);
  });

  // Each of these judged nothing, so none may read as the change being wrong.
  test("a command that is not there at all is a reviewer error", async () => {
    const at = places();
    const out = unwrap(await job(at, { cmd: join(root, "no-such-command") }));
    expect(out.outcome.state).toBe("reviewer_error");
    expect(out.exitCode).toBeNull();
  });

  test("exit 127 is a reviewer error; exit 1 beside it is the code's", async () => {
    const at = places();
    const cannot = unwrap(
      await job(at, { cmd: harness(at, "process.exit(127)", "a.js") }),
    );
    expect(cannot.outcome.state).toBe("reviewer_error");
    const at2 = places();
    const failed = unwrap(
      await job(at2, { cmd: harness(at2, "process.exit(1)", "b.js") }),
    );
    expect(failed.outcome.state).toBe("failed");
  });

  test("the project's own timeout kills it, and the gate decides nothing", async () => {
    const at = places();
    const out = unwrap(
      await job(
        at,
        { cmd: harness(at, "setTimeout(function(){}, 60000)") },
        { timeoutMs: 200 },
      ),
    );
    expect(out.outcome.state).toBe("reviewer_error");
    if (out.outcome.state !== "reviewer_error") return;
    expect(out.outcome.message).toContain("harness timeout");
    expect(logOf(at)).toContain("killed at the harness timeout");
  });

  test("the output cap kills it, and the gate decides nothing", async () => {
    const at = places();
    const out = unwrap(
      await job(at, {
        cmd: harness(
          at,
          "const line = 'x'.repeat(200) + '\\n';\nfor (let i = 0; i < 20000; i += 1) process.stdout.write(line);",
        ),
      }),
    );
    expect(out.outcome.state).toBe("reviewer_error");
    if (out.outcome.state !== "reviewer_error") return;
    expect(out.outcome.message).toContain("wrote more than");
  });
});

describe("the placeholders and the secrets", () => {
  test("{ticket} reaches the harness as one argument", async () => {
    const at = places();
    unwrap(
      await job(at, {
        cmd: `${harness(at, "require('fs').writeFileSync('seen.txt', process.argv[2])")} {ticket}`,
      }),
    );
    expect(readFileSync(join(at.cwd, "seen.txt"), "utf8")).toBe("PROJ-7");
  });

  test("a value with a space is still one argument: there is no shell to split it", async () => {
    const at = places();
    const out = await runQaJob({
      cwd: at.cwd,
      workspaceId: "ws",
      config: config({
        cmd: `${harness(at, "require('fs').writeFileSync('seen.txt', String(process.argv.length) + ':' + process.argv[2])")} {branch}`,
      }),
      values: { ...VALUES, branch: "two words" },
      secrets: [],
      artifactsDir: at.artifactsDir,
      env: ENV,
      at: AT,
      timeoutMs: 20_000,
      now: () => 1_000,
    });
    unwrap(out);
    expect(readFileSync(join(at.cwd, "seen.txt"), "utf8")).toBe("3:two words");
  });

  // §14: a secret goes into the child's env and nowhere else — past the allowlist, under the floor.
  test("a named secret reaches the harness's env and is scrubbed from the output", async () => {
    const at = places();
    const out = unwrap(
      await job(
        at,
        { cmd: harness(at, "console.log('token=' + process.env.QA_TOKEN)") },
        { secrets: [["QA_TOKEN", "s3cr3t-value"]] },
      ),
    );
    expect(out.outcome).toEqual({ state: "passed" });
    expect(logOf(at)).toContain("token=[redacted:QA_TOKEN]");
    expect(logOf(at)).not.toContain("s3cr3t-value");
  });

  test("the floor still wins: a secret cannot move the harness out of its own home", async () => {
    const at = places();
    unwrap(
      await job(
        at,
        { cmd: harness(at, "console.log('home=' + process.env.HOME)") },
        { secrets: [["HOME", join(root, "somewhere-else")]] },
      ),
    );
    expect(logOf(at)).toContain(`home=${AT.home}`);
  });

  test("nothing of ours reaches the harness: the allowlist still holds", async () => {
    const at = places();
    unwrap(
      await job(at, {
        cmd: harness(at, "console.log('db=' + String(process.env.FRM_DB))"),
      }),
    );
    expect(logOf(at)).toContain("db=undefined");
  });
});

// §14, Invariant 11: a harness is handed secrets by name, and a verbose failure echoes what it was
// given — into its report file as readily as onto its stdout. Every path a harness's bytes take to a
// stored row, an artifact or a prompt goes through the one scrub.
describe("the scrub reaches every copy, not just the output", () => {
  const SECRET = [["QA_TOKEN", "s3cr3t-value"]] as const;

  test("a report that holds a secret is scrubbed in the artifact copy", async () => {
    const at = places();
    const out = unwrap(
      await job(
        at,
        {
          cmd: harness(
            at,
            "require('fs').writeFileSync('out.xml', '<r>failed with token=' + process.env.QA_TOKEN + '</r>')",
          ),
          reports: ["out.xml"],
        },
        { secrets: SECRET },
      ),
    );
    const copied = readFileSync(out.reports[0] ?? "", "utf8");
    expect(copied).toContain("token=[redacted:QA_TOKEN]");
    expect(copied).not.toContain("s3cr3t-value");
    // The source in the worktree is the project's own file and is left alone.
    expect(readFileSync(join(at.cwd, "out.xml"), "utf8")).toContain(
      "s3cr3t-value",
    );
    expect(out.binaryReports).toEqual([]);
  });

  test("a secret in a JUnit message is scrubbed in the finding it becomes", async () => {
    const at = places();
    writeFileSync(
      join(at.cwd, "junit.xml"),
      `<testsuite name="s" tests="1"><testcase classname="c" name="login s3cr3t-value">` +
        `<failure message="expected 200, got 401 for token s3cr3t-value"/></testcase></testsuite>`,
    );
    const out = unwrap(
      await job(
        at,
        {
          cmd: harness(at, "process.exit(1)"),
          reports: ["junit.xml"],
          junit: "junit.xml",
        },
        { secrets: SECRET },
      ),
    );
    expect(out.outcome.state).toBe("failed");
    if (out.outcome.state !== "failed") return;
    // `detail_md` is what §8.2 compiles into the next fix session's prompt.
    const said = JSON.stringify(out.outcome.findings);
    expect(said).not.toContain("s3cr3t-value");
    expect(said).toContain("[redacted:QA_TOKEN]");
  });

  // The parse *makes* text: `&#115;3cr3t-value` is not in the raw bytes, but the finding would
  // carry it. That is why the scrub runs on both sides of the parse.
  test("a secret an XML entity only spells after decoding is scrubbed too", async () => {
    const at = places();
    writeFileSync(
      join(at.cwd, "junit.xml"),
      `<testsuite><testcase classname="c" name="n">` +
        `<failure message="token &#115;3cr3t-value rejected"/></testcase></testsuite>`,
    );
    const out = unwrap(
      await job(
        at,
        {
          cmd: harness(at, "process.exit(1)"),
          reports: ["junit.xml"],
          junit: "junit.xml",
        },
        { secrets: SECRET },
      ),
    );
    if (out.outcome.state !== "failed") throw new Error("expected a failure");
    expect(JSON.stringify(out.outcome.findings)).not.toContain("s3cr3t-value");
  });

  test("a report that is not text is copied byte for byte and flagged", async () => {
    const at = places();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe]);
    writeFileSync(join(at.cwd, "shot.png"), bytes);
    const out = unwrap(
      await job(
        at,
        { cmd: harness(at, "process.exit(0)"), reports: ["shot.png"] },
        { secrets: SECRET },
      ),
    );
    const copied = out.reports[0] ?? "";
    expect(readFileSync(copied)).toEqual(bytes);
    // …and it is named as not scrubbed, so the evidence can say so.
    expect(out.binaryReports).toEqual([copied]);
    const facts = JSON.parse(
      readFileSync(join(at.artifactsDir, "qa-run.json"), "utf8"),
    ) as { binary_reports?: string[] };
    expect(facts.binary_reports).toEqual([copied]);
  });
});

describe("the reports", () => {
  test("what the globs match is copied into the gate's artifacts", async () => {
    const at = places();
    mkdirSync(join(at.cwd, "out"), { recursive: true });
    writeFileSync(join(at.cwd, "out", "a.xml"), "<testsuite/>");
    writeFileSync(join(at.cwd, "out", "b.txt"), "not matched");
    const out = unwrap(
      await job(at, {
        cmd: harness(at, "process.exit(0)"),
        reports: ["out/*.xml"],
      }),
    );
    expect(out.reports).toEqual([
      join(at.artifactsDir, "qa-reports", "out", "a.xml"),
    ]);
    expect(readFileSync(out.reports[0] ?? "", "utf8")).toBe("<testsuite/>");
  });

  test("a JUnit report the project named adds a finding per failed case", async () => {
    const at = places();
    writeFileSync(
      join(at.cwd, "junit.xml"),
      `<testsuite name="s" tests="2"><testcase classname="c" name="ok"/>` +
        `<testcase classname="c" name="bad"><failure message="nope"/></testcase></testsuite>`,
    );
    const out = unwrap(
      await job(at, {
        cmd: harness(at, "process.exit(1)"),
        reports: ["junit.xml"],
        junit: "junit.xml",
      }),
    );
    expect(out.outcome.state).toBe("failed");
    if (out.outcome.state !== "failed") return;
    expect(out.outcome.findings.map((f) => f.summary)).toEqual([
      expect.stringContaining("exited 1"),
      "QA case failed: c › bad",
    ]);
  });
});

test("a command the argv rule refuses is not run at all", async () => {
  const at = places();
  const refused = await job(at, { cmd: "make check && echo done" });
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.error.message).toContain("is not an argv");
});
