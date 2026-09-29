import { expect, test } from "vitest";
import {
  QA_JUNIT_CASES_MAX,
  QA_JUNIT_MESSAGE_MAX,
  parseJUnit,
  unescapeXml,
} from "./junit.js";

// The JUnit reader. It never throws: a file it cannot make sense of yields no cases and
// says so, leaving the harness's exit code to decide the gate. The dialects below are the shape
// every runner shares — attributes, self-closing cases, nested suites — and no runner's own quirks.

const SUITE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="outer" tests="4" failures="2">
    <testcase classname="pack.One" name="passes" time="0.01"/>
    <testcase classname="pack.One" name="fails" time="0.02">
      <failure message="expected &lt;1&gt; got &lt;2&gt;" type="AssertionError">stack</failure>
    </testcase>
    <testcase classname="pack.Two" name="errors">
      <error message="boom &amp; bust"/>
    </testcase>
    <testcase name="no class" />
  </testsuite>
</testsuites>`;

test("reads the failed cases, their suite, name and message", () => {
  const parsed = parseJUnit(SUITE);
  expect(parsed.malformed).toBe(false);
  expect(parsed.cases).toBe(4);
  expect(parsed.total).toBe(2);
  expect(parsed.failures).toEqual([
    {
      suite: "pack.One",
      name: "fails",
      message: "expected <1> got <2>",
      kind: "failure",
    },
    {
      suite: "pack.Two",
      name: "errors",
      message: "boom & bust",
      kind: "error",
    },
  ]);
});

test("a passing report has no failures and is not malformed", () => {
  const parsed = parseJUnit(
    `<testsuite name="s" tests="1"><testcase classname="c" name="n"/></testsuite>`,
  );
  expect(parsed).toMatchObject({
    total: 0,
    cases: 1,
    malformed: false,
    failures: [],
  });
});

test("single quotes, a missing message and a missing name all read", () => {
  const parsed = parseJUnit(
    `<testsuite><testcase classname='c' name='n'><failure/></testcase>` +
      `<testcase><failure message=""/></testcase></testsuite>`,
  );
  expect(parsed.failures).toEqual([
    { suite: "c", name: "n", message: null, kind: "failure" },
    { suite: null, name: "(unnamed case)", message: null, kind: "failure" },
  ]);
});

test("a report cut off mid-write keeps what it held", () => {
  const cut = SUITE.slice(
    0,
    SUITE.indexOf('<testcase classname="pack.Two"') + 80,
  );
  const parsed = parseJUnit(cut);
  expect(parsed.malformed).toBe(false);
  expect(parsed.failures.map((f) => f.name)).toEqual(["fails"]);
});

test("text that is not a report at all is malformed, and contributes nothing", () => {
  for (const text of [
    "",
    "not xml",
    '{"json": true}',
    "<html><body>x</body></html>",
  ]) {
    const parsed = parseJUnit(text);
    expect(parsed.malformed, JSON.stringify(text)).toBe(true);
    expect(parsed.failures, JSON.stringify(text)).toEqual([]);
    expect(parsed.total).toBe(0);
  }
  // An empty but well-formed report is not malformed: it simply has no cases.
  expect(parseJUnit("<testsuites/>").malformed).toBe(false);
});

test("the listed cases are capped, and the true total is still counted", () => {
  const many = Array.from(
    { length: QA_JUNIT_CASES_MAX + 5 },
    (_, i) =>
      `<testcase classname="c" name="n${String(i)}"><failure message="m"/></testcase>`,
  ).join("");
  const parsed = parseJUnit(`<testsuite>${many}</testsuite>`);
  expect(parsed.failures).toHaveLength(QA_JUNIT_CASES_MAX);
  expect(parsed.total).toBe(QA_JUNIT_CASES_MAX + 5);
  expect(parseJUnit(`<testsuite>${many}</testsuite>`, 2).failures).toHaveLength(
    2,
  );
});

test("a message longer than the cap is cut, with the marker", () => {
  const long = "x".repeat(QA_JUNIT_MESSAGE_MAX + 50);
  const parsed = parseJUnit(
    `<testsuite><testcase classname="c" name="n"><failure message="${long}"/></testcase></testsuite>`,
  );
  const message = parsed.failures[0]?.message ?? "";
  expect(message).toHaveLength(QA_JUNIT_MESSAGE_MAX);
  expect(message.endsWith("…")).toBe(true);
  // One under the cap is kept whole.
  const short = "y".repeat(QA_JUNIT_MESSAGE_MAX);
  expect(
    parseJUnit(
      `<testsuite><testcase name="n"><failure message="${short}"/></testcase></testsuite>`,
    ).failures[0]?.message,
  ).toBe(short);
});

test("unescapeXml handles the five entities and numeric references, and leaves the rest", () => {
  expect(unescapeXml("&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;")).toBe(
    `<a> & "b" 'c'`,
  );
  expect(unescapeXml("&#65;&#x42;")).toBe("AB");
  expect(unescapeXml("&nbsp; &#x110000;")).toBe("&nbsp; &#x110000;");
});
