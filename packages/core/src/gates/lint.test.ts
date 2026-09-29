import { describe, expect, test } from "vitest";
import {
  LINT_ARGV_MAX,
  LINT_CATEGORY,
  LINT_TAIL_CHARS,
  LINT_TAIL_LINES,
  lintArgv,
  lintCommandLine,
  lintFindings,
  lintReport,
  lintTail,
  type LintRun,
} from "./lint.js";
import { countSentinel, parseReviewOutput } from "./findings.js";

// The `lint_check` gate's rules: what may be run, and what a run's exit means.

describe("lintArgv", () => {
  test("a plain command is its words", () => {
    expect(lintArgv("pnpm -w lint")).toEqual({
      ok: true,
      value: ["pnpm", "-w", "lint"],
    });
  });

  test("surrounding and repeated whitespace is not an argument", () => {
    expect(lintArgv("  make\t  lint  ")).toEqual({
      ok: true,
      value: ["make", "lint"],
    });
  });

  test.each([null, undefined, "", "   "])(
    "%p is refused, naming the row to set",
    (cmd) => {
      const r = lintArgv(cmd);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.class).toBe("validation");
      expect(r.error.message).toContain("repos.lint_cmd");
      expect(r.error.message).toContain("pnpm -w lint");
    },
  );

  // It is run with no shell (the house rule for operator-declared commands), so a value that only
  // means something to a shell must be refused rather than passed through as literal arguments —
  // which would fail in a way that reads like a lint failure instead of a misconfiguration.
  test.each([
    ["&&", "eslint . && prettier --check ."],
    ["||", "eslint . || true"],
    [";", "eslint .; prettier -c ."],
    ["|", "eslint . | tee out"],
    [">", "eslint . > out.txt"],
    ["<", "lint < input"],
    ["$", "eslint $DIR"],
    ["backtick", "eslint `pwd`"],
    ["double quote", 'eslint "src dir"'],
    ["single quote", "eslint 'src dir'"],
    ["backslash", "eslint src\\ dir"],
    ["glob star", "eslint src/*.ts"],
    ["question mark", "eslint src/?.ts"],
    ["bracket", "eslint src/[ab].ts"],
    ["brace", "eslint src/{a,b}.ts"],
    ["bang", "eslint !src"],
    ["hash", "eslint . # fast"],
    ["tilde", "eslint ~/src"],
    ["newline", "eslint .\nprettier -c ."],
    ["carriage return", "eslint .\rprettier -c ."],
    ["parens", "eslint (src)"],
  ])("a %s is refused, and the refusal says what to do instead", (_, cmd) => {
    const r = lintArgv(cmd);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("is not an argv");
    expect(r.error.message).toContain("package script");
  });

  test("a command over the word cap is refused", () => {
    const long = Array.from({ length: LINT_ARGV_MAX + 1 }, () => "x").join(" ");
    const r = lintArgv(long);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain(`over the ${String(LINT_ARGV_MAX)}-word`);
  });

  test("a command exactly at the word cap is allowed", () => {
    const at = Array.from({ length: LINT_ARGV_MAX }, () => "x").join(" ");
    expect(lintArgv(at).ok).toBe(true);
  });
});

test("lintCommandLine puts an argv back as one readable line", () => {
  expect(lintCommandLine(["pnpm", "-w", "lint"])).toBe("pnpm -w lint");
});

describe("lintTail", () => {
  test("short output comes back whole, without its trailing blank lines", () => {
    expect(lintTail("one\ntwo\n\n")).toBe("one\ntwo");
  });

  test("only the last lines survive: a linter's count is at the end, not the start", () => {
    const many = Array.from({ length: LINT_TAIL_LINES + 10 }, (_, i) =>
      String(i),
    ).join("\n");
    const tail = lintTail(many);
    expect(tail.split("\n")).toHaveLength(LINT_TAIL_LINES);
    expect(tail.split("\n").at(-1)).toBe(String(LINT_TAIL_LINES + 9));
    expect(tail).not.toContain("\n0\n");
  });

  test("a single enormous line is cut to the character cap and marked", () => {
    const tail = lintTail("x".repeat(LINT_TAIL_CHARS * 2));
    expect(tail.startsWith("…\n")).toBe(true);
    expect(tail).toHaveLength(LINT_TAIL_CHARS + 2);
  });
});

const run = (o: Partial<LintRun> = {}): LintRun => ({
  argv: ["pnpm", "-w", "lint"],
  exitCode: 1,
  output: "src/a.ts\n[warn] Code style issues found.",
  logPath: "/frm/artifacts/gates/G1/lint.log",
  ...o,
});

describe("lintFindings", () => {
  test("exit 0 is a clean repo: no finding at all", () => {
    expect(lintFindings("foreman", run({ exitCode: 0 }))).toEqual([]);
  });

  // The ticket's Done-when: the refusal must name the exact command to run. This finding is what
  // reaches the next builder — the `fix` template's findings section is compiled from these rows.
  test("a non-zero exit is one blocker naming the command, the repo and the log", () => {
    const [finding, ...rest] = lintFindings("foreman", run());
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      severity: "blocker",
      category: LINT_CATEGORY,
      file: null,
      line: null,
    });
    expect(finding?.summary).toBe("`pnpm -w lint` exited 1 in repo foreman");
    expect(finding?.detail_md).toContain("Run `pnpm -w lint` in your worktree");
    expect(finding?.detail_md).toContain("/frm/artifacts/gates/G1/lint.log");
    expect(finding?.detail_md).toContain("[warn] Code style issues found.");
  });

  test("a process that never exited normally says so rather than naming a code", () => {
    const [finding] = lintFindings("foreman", run({ exitCode: null }));
    expect(finding?.summary).toBe(
      "`pnpm -w lint` did not exit normally (killed, or it never started) in repo foreman",
    );
  });
});

describe("lintReport", () => {
  test("a clean repo: the summary says so and the sentinel declares none", () => {
    const text = lintReport("foreman", []);
    expect(text).toContain("lint_check: repo foreman is clean.");
    expect(countSentinel(text)).toBe(0);
  });

  // C2: a script gate has no output schema, so collect() reads the findings heuristically and
  // refuses the review unless the FINDINGS line declares exactly as many as it read. Both halves
  // come from one list here, so they agree by construction — this is the test that they do.
  test("the embedded ReviewOutput and the sentinel agree, and parse back", () => {
    const findings = lintFindings("foreman", run());
    const text = lintReport("foreman", findings);
    expect(countSentinel(text)).toBe(findings.length);
    const parsed = parseReviewOutput(text, false);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.findings).toEqual(findings);
  });
});
