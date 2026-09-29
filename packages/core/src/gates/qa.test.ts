import { describe, expect, test } from "vitest";
import { ARGV_WORDS_MAX } from "./argv.js";
import { lintArgv } from "./lint.js";
import {
  QA_GLOB_MAX,
  QA_PLACEHOLDERS,
  QA_TEXT_SNIFF_BYTES,
  QA_TIMEOUT_DEFAULT_MS,
  QA_TIMEOUT_MAX_MS,
  QA_TIMEOUT_MIN_MS,
  QA_UNRUNNABLE_EXITS,
  matchGlob,
  qaArgv,
  qaReport,
  qaReportGlob,
  qaSecretName,
  isReservedEnvName,
  qaJunit,
  qaSubstitute,
  qaTimeoutOf,
  qaVerdict,
  redacted,
  scrubSecrets,
  scrubbableText,
  type QaRun,
} from "./qa.js";
import { QA_JUNIT_CASES_MAX, parseJUnit } from "./junit.js";

// The qa_harness gate's rules: what a project may declare as its harness, what the
// placeholders do, and what an exit code means. Nothing here names a framework, a file or a report
// format — the fixtures are deliberately anonymous, because the rule under test is that Bayon knows
// only "a command that exits non-zero when the project is broken".

const unwrapErr = (r: ReturnType<typeof qaArgv>): string =>
  r.ok ? "(no error)" : r.error.message;

describe("qaArgv: the argv rule", () => {
  test("a plain command is its words", () => {
    expect(qaArgv("make check")).toEqual({
      ok: true,
      value: ["make", "check"],
    });
    expect(qaArgv("  ./scripts/verify   --fast  ")).toEqual({
      ok: true,
      value: ["./scripts/verify", "--fast"],
    });
  });

  test("no command at all is refused, naming where to set one", () => {
    for (const blank of [null, undefined, "", "   "]) {
      const r = qaArgv(blank);
      expect(r.ok, String(blank)).toBe(false);
      expect(unwrapErr(r)).toMatch(/no QA command/);
    }
  });

  // The mutation check: drop the metacharacter refusal and every one of these becomes a command run
  // literally as arguments, failing in a way that reads as a broken project rather than as the
  // misconfiguration it is.
  test("a shell metacharacter is refused, with the fix named", () => {
    for (const cmd of [
      "a && b",
      "a; b",
      "a | b",
      "a > out",
      "a < in",
      "a $(b)",
      "a `b`",
      'a "b"',
      "a 'b'",
      "a *.txt",
      "a b?",
      "a [b]",
      "a #b",
      "a ~b",
      "a\nb",
      "a\\b",
      "a!b",
      "a (b)",
    ]) {
      const r = qaArgv(cmd);
      expect(r.ok, cmd).toBe(false);
      expect(unwrapErr(r), cmd).toMatch(/is not an argv/);
    }
  });

  test("over the word cap is refused", () => {
    const long = Array.from({ length: ARGV_WORDS_MAX + 1 }, () => "w").join(
      " ",
    );
    const r = qaArgv(long);
    expect(r.ok).toBe(false);
    expect(unwrapErr(r)).toMatch(/over the 32-word cap/);
    expect(
      qaArgv(Array.from({ length: ARGV_WORDS_MAX }, () => "w").join(" ")).ok,
    ).toBe(true);
  });

  test("the three placeholders pass; an unknown one and a bare brace do not", () => {
    expect(
      qaArgv("run --case={ticket} --ref={external_key} --on={branch}"),
    ).toEqual({
      ok: true,
      value: [
        "run",
        "--case={ticket}",
        "--ref={external_key}",
        "--on={branch}",
      ],
    });
    const typo = qaArgv("run --case={tickt}");
    expect(typo.ok).toBe(false);
    expect(unwrapErr(typo)).toMatch(/no such placeholder: \{tickt\}/);
    for (const bad of ["run {", "run }", "run {ticket", "run a}b"]) {
      expect(qaArgv(bad).ok, bad).toBe(false);
    }
  });

  test("lint's rule refuses a brace, because lint has no placeholders", () => {
    expect(lintArgv("run {ticket}").ok).toBe(false);
    expect(lintArgv("pnpm -w lint")).toEqual({
      ok: true,
      value: ["pnpm", "-w", "lint"],
    });
  });
});

describe("qaSubstitute: the placeholders", () => {
  const values = {
    ticket: "PROJ-7",
    external_key: "EXT-12",
    branch: "agent/PROJ-7",
  };

  test("each is filled, per word, without re-splitting", () => {
    expect(
      qaSubstitute(["run", "--case={ticket}", "--on={branch}"], values),
    ).toEqual(["run", "--case=PROJ-7", "--on=agent/PROJ-7"]);
    expect(QA_PLACEHOLDERS).toEqual(["ticket", "external_key", "branch"]);
  });

  test("a value with a space stays one argument: there is no shell to split it", () => {
    const out = qaSubstitute(["run", "{ticket}"], {
      ...values,
      ticket: "two words",
    });
    expect(out).toEqual(["run", "two words"]);
    expect(out).toHaveLength(2);
  });

  // `qaArgv` refuses an unknown placeholder at the door, so the harness never sees one. Called on
  // its own — a rerun of a row written before that check, or a caller that skips it — the word is
  // left exactly as it stands rather than replaced with `undefined`.
  test("a placeholder it does not know is left alone", () => {
    expect(qaSubstitute(["run", "--x={nope}", "{ticket}"], values)).toEqual([
      "run",
      "--x={nope}",
      "PROJ-7",
    ]);
  });

  test("an absent external key is the empty string, not the placeholder", () => {
    expect(
      qaSubstitute(["run", "--ref={external_key}"], {
        ...values,
        external_key: "",
      }),
    ).toEqual(["run", "--ref="]);
  });
});

describe("qaTimeoutOf: the project's clock, or the default", () => {
  test("blank is the default; a value is held to the bounds", () => {
    expect(qaTimeoutOf(null)).toBe(QA_TIMEOUT_DEFAULT_MS);
    expect(qaTimeoutOf(undefined)).toBe(QA_TIMEOUT_DEFAULT_MS);
    expect(qaTimeoutOf(600_000)).toBe(600_000);
    // Out of range either way: the bound, not a refusal — the value is already stored.
    expect(qaTimeoutOf(1)).toBe(QA_TIMEOUT_MIN_MS);
    expect(qaTimeoutOf(99_999_999)).toBe(QA_TIMEOUT_MAX_MS);
  });
});

describe("qaVerdict: what an exit code means", () => {
  const run = (o: Partial<QaRun> = {}): QaRun => ({
    argv: ["make", "check"],
    exitCode: 0,
    output: "all good\n",
    logPath: "/a/qa.log",
    ...o,
  });

  test("exit 0 passes", () => {
    expect(qaVerdict(run())).toEqual({ state: "passed" });
  });

  test("any other exit is one blocking finding naming the command", () => {
    const v = qaVerdict(run({ exitCode: 1, output: "2 checks failed\n" }));
    expect(v.state).toBe("failed");
    if (v.state !== "failed") return;
    expect(v.findings).toHaveLength(1);
    const [f] = v.findings;
    expect(f?.severity).toBe("blocker");
    expect(f?.summary).toBe("`make check` exited 1");
    expect(f?.detail_md).toContain("make check");
    expect(f?.detail_md).toContain("/a/qa.log");
    expect(f?.detail_md).toContain("2 checks failed");
  });

  // The mutation check: make these code failures and a fixer is staffed against a bug that does not
  // exist, which is the mistake an earlier change exists to prevent, in QA's clothing.
  test("a command that never ran is a reviewer error, not the code's", () => {
    const never = qaVerdict(run({ exitCode: null, output: "ENOENT" }));
    expect(never.state).toBe("reviewer_error");
    for (const code of QA_UNRUNNABLE_EXITS) {
      const v = qaVerdict(run({ exitCode: code }));
      expect(v.state, String(code)).toBe("reviewer_error");
      if (v.state !== "reviewer_error") continue;
      expect(v.message).toMatch(/could not be run at all/);
      expect(v.message).toContain("make check");
    }
    expect(QA_UNRUNNABLE_EXITS).toEqual([125, 126, 127]);
    // …and an ordinary non-zero exit beside them still is the code's.
    expect(qaVerdict(run({ exitCode: 124 })).state).toBe("failed");
    expect(qaVerdict(run({ exitCode: 128 })).state).toBe("failed");
  });

  test("a JUnit report adds a finding per failed case, after the command's", () => {
    const junit = parseJUnit(
      `<testsuite name="s" tests="3">
         <testcase classname="a.b" name="one"/>
         <testcase classname="a.b" name="two"><failure message="expected 1, got 2"/></testcase>
         <testcase classname="a.c" name="three"><error message="blew up"/></testcase>
       </testsuite>`,
    );
    const v = qaVerdict(run({ exitCode: 1, junit }));
    expect(v.state).toBe("failed");
    if (v.state !== "failed") return;
    expect(v.findings.map((f) => f.summary)).toEqual([
      "`make check` exited 1",
      "QA case failed: a.b › two",
      "QA case errored: a.c › three",
    ]);
    expect(v.findings[1]?.detail_md).toBe("expected 1, got 2");
    expect(v.findings[0]?.detail_md).toContain("2 of 3 case(s) failed");
  });

  test("a case with no suite and no message still reads as a finding", () => {
    const junit = parseJUnit(
      `<testsuite><testcase name="alone"><failure/></testcase></testsuite>`,
    );
    const v = qaVerdict(run({ exitCode: 1, junit }));
    if (v.state !== "failed") throw new Error("expected a failure");
    expect(v.findings[1]).toMatchObject({
      summary: "QA case failed: alone",
      detail_md: "The report gave no message for this case.",
    });
  });

  test("more failed cases than the cap says so on the command's own finding", () => {
    const many = Array.from(
      { length: QA_JUNIT_CASES_MAX + 3 },
      (_, i) =>
        `<testcase classname="c" name="n${String(i)}"><failure message="m"/></testcase>`,
    ).join("");
    const junit = parseJUnit(`<testsuite>${many}</testsuite>`);
    const v = qaVerdict(run({ exitCode: 1, junit }));
    if (v.state !== "failed") throw new Error("expected a failure");
    expect(v.findings[0]?.detail_md).toContain(
      `the first ${String(QA_JUNIT_CASES_MAX)} are listed separately`,
    );
    expect(v.findings).toHaveLength(QA_JUNIT_CASES_MAX + 1);
  });

  test("a malformed JUnit report costs nothing but a note", () => {
    const v = qaVerdict(run({ exitCode: 1, junit: parseJUnit("not xml") }));
    expect(v.state).toBe("failed");
    if (v.state !== "failed") return;
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]?.detail_md).toContain("could not be read");
  });
});

describe("the configuration's own checks", () => {
  test("a secret is named, never valued", () => {
    for (const good of ["TOKEN", "A", "A_B_1"]) {
      expect(qaSecretName(good), good).toEqual({ ok: true, value: good });
    }
    for (const bad of ["", "lower", "1LEAD", "A-B", "A B", "A$"]) {
      expect(qaSecretName(bad).ok, bad).toBe(false);
    }
  });

  // The LOW the review found: `envFloor` is applied last, on purpose, so a secret of one of those
  // names is silently thrown away. Hearing nothing is worse than hearing no — the harness would run
  // with foreman's value and the failure would read as a broken credential.
  test("a secret may not be named one foreman sets for every job", () => {
    // The floor's own names, and the two families reserved around it. `job-env.test.ts` holds the
    // real `envFloor` against this shape, so a name added to the floor cannot slip past it.
    for (const name of [
      "HOME",
      "TMPDIR",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "GIT_AUTHOR_NAME",
    ]) {
      expect(isReservedEnvName(name), name).toBe(true);
      const refused = qaSecretName(name);
      expect(refused.ok, name).toBe(false);
      expect(refused.ok ? "" : refused.error.message).toContain(
        "set by foreman for every job",
      );
    }
    // Their neighbours are fine: the reservation is `HOME`, `TMPDIR`, `XDG_*` and `GIT_*`, and
    // nothing that merely reads like one.
    for (const fine of ["HOME_DIR", "MY_TMPDIR", "GITHUB_TOKEN", "QA_TOKEN"]) {
      expect(isReservedEnvName(fine), fine).toBe(false);
      expect(qaSecretName(fine).ok, fine).toBe(true);
    }
  });

  test("a report glob stays inside the worktree, and is a glob not a script", () => {
    for (const good of ["out.xml", "reports/*.xml", "a/**/b-?.json"]) {
      expect(qaReportGlob(good).ok, good).toBe(true);
    }
    for (const bad of ["", "/abs/out.xml", "../out.xml", "a/../../b", "a\\b"]) {
      expect(qaReportGlob(bad).ok, bad).toBe(false);
    }
    // Each refusal says which rule it broke, so an operator can fix it without guessing.
    const long = qaReportGlob("a".repeat(QA_GLOB_MAX + 1));
    expect(long.ok).toBe(false);
    expect(long.ok ? "" : long.error.message).toContain(
      `at most ${String(QA_GLOB_MAX)} characters`,
    );
    expect(qaReportGlob("a".repeat(QA_GLOB_MAX)).ok).toBe(true);
  });

  test("matchGlob: `*` inside a segment, `**` across them", () => {
    expect(matchGlob("out.xml", "out.xml")).toBe(true);
    expect(matchGlob("*.xml", "out.xml")).toBe(true);
    expect(matchGlob("*.xml", "a/out.xml")).toBe(false);
    expect(matchGlob("a/*/c.xml", "a/b/c.xml")).toBe(true);
    expect(matchGlob("a/**/c.xml", "a/c.xml")).toBe(true);
    expect(matchGlob("a/**/c.xml", "a/b/x/c.xml")).toBe(true);
    expect(matchGlob("a/**", "a/b/c.xml")).toBe(true);
    expect(matchGlob("a/**", "a")).toBe(true);
    expect(matchGlob("**/c.xml", "c.xml")).toBe(true);
    expect(matchGlob("**/c.xml", "a/b/c.xml")).toBe(true);
    expect(matchGlob("r?.xml", "r1.xml")).toBe(true);
    expect(matchGlob("r?.xml", "r12.xml")).toBe(false);
    // A dot is a dot, not a regex wildcard.
    expect(matchGlob("a.xml", "axxml")).toBe(false);
  });

  // The marker cannot carry an XML metacharacter: the scrub runs over a JUnit report before it is
  // parsed, and `<redacted:X>` ended the tag early — a named failing case became an unnamed one, the
  // redaction corrupting the report it was protecting.
  test("the redaction marker is safe inside XML, a shell and Markdown", () => {
    expect(redacted("QA_TOKEN")).toBe("[redacted:QA_TOKEN]");
    expect(redacted("QA_TOKEN")).not.toMatch(/[<>&"']/);
  });

  test("a resolved secret is scrubbed from the output by name", () => {
    expect(
      scrubSecrets("token=s3cr3tvalue done", [["TOKEN", "s3cr3tvalue"]]),
    ).toBe("token=[redacted:TOKEN] done");
    // Too short to redact usefully: redacting "1" would destroy the tail and protect nothing.
    expect(scrubSecrets("exit 1", [["N", "1"]])).toBe("exit 1");
  });
});

describe("scrubbableText: what the scrub can work on", () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  test("text comes back decoded; bytes come back null", () => {
    expect(scrubbableText(bytes("<testsuite/>"))).toBe("<testsuite/>");
    // A NUL in the first 8 KiB is the usual binary tell.
    expect(scrubbableText(new Uint8Array([0x41, 0x00, 0x42]))).toBeNull();
    // …and so is anything that is not UTF-8, wherever it sits.
    expect(scrubbableText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
    // UTF-8 past the sniff window still decodes whole.
    const long = `${"a".repeat(QA_TEXT_SNIFF_BYTES + 10)}é`;
    expect(scrubbableText(bytes(long))).toBe(long);
  });
});

// The three-pass scrub of the JUnit path: the copy is scrubbed, the raw text again, and then each
// field the parse produced. A finding's `detail_md` is compiled into the next fix session's prompt
// (§8.2), so this is the one path where a miss puts a secret in front of a model.
describe("qaJunit: scrubbed on both sides of the parse", () => {
  const SECRET = [["QA_TOKEN", "s3cr3t-value"]] as const;

  test("a secret in a message, a name or a classname is gone from the parse", () => {
    const parsed = qaJunit(
      `<testsuite><testcase classname="pkg.s3cr3t-value" name="login s3cr3t-value">` +
        `<failure message="401 for s3cr3t-value"/></testcase></testsuite>`,
      SECRET,
    );
    expect(parsed.failures).toEqual([
      {
        suite: "pkg.[redacted:QA_TOKEN]",
        name: "login [redacted:QA_TOKEN]",
        message: "401 for [redacted:QA_TOKEN]",
        kind: "failure",
      },
    ]);
  });

  // The second pass is not decoration: `&#115;3cr3t-value` is not in the raw bytes at all, and
  // `unescapeXml` is what makes it.
  test("a secret only an entity spells after decoding is scrubbed by the second pass", () => {
    const parsed = qaJunit(
      `<testsuite><testcase classname="c" name="n">` +
        `<failure message="token &#115;3cr3t-value"/></testcase></testsuite>`,
      SECRET,
    );
    expect(parsed.failures[0]?.message).toBe("token [redacted:QA_TOKEN]");
  });

  test("a case with no suite and no message survives the scrub unchanged", () => {
    const parsed = qaJunit(
      `<testsuite><testcase name="n"><failure/></testcase></testsuite>`,
      SECRET,
    );
    expect(parsed.failures).toEqual([
      { suite: null, name: "n", message: null, kind: "failure" },
    ]);
  });

  test("with no secrets the parse is untouched", () => {
    const xml = `<testsuite><testcase classname="c" name="n"><failure message="m"/></testcase></testsuite>`;
    expect(qaJunit(xml)).toEqual(qaJunit(xml, []));
  });
});

test("qaReport's sentinel matches the findings it carries", () => {
  const text = qaReport("proj", []);
  expect(text).toContain("FINDINGS: 0");
  expect(text).toContain("passes its QA command");
  const one = qaReport("proj", [
    {
      severity: "blocker",
      summary: "s",
      file: null,
      line: null,
      category: "qa",
      detail_md: "d",
    },
  ]);
  expect(one).toContain("FINDINGS: 1");
  expect(one).toContain("fails its QA command");
});
