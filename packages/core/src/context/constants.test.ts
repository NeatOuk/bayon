import { describe, expect, test } from "vitest";
import { isErrorLine } from "./constants.js";

// What the error pattern keeps, one row per shape it documents, and what it must not catch.
describe("isErrorLine: the lines no rule ever drops or folds", () => {
  test.each([
    // Words, any case, anywhere.
    "Error: connection refused",
    "TypeError: Cannot read properties of undefined",
    "java.lang.NullPointerException",
    "fatal: not a git repository",
    "Traceback (most recent call last):",
    " FAIL  src/a.test.ts > adds",
    "--- FAIL: TestTotal (0.00s)",
    "FAILED tests/test_orders.py::test_total - AssertionError",
    "  2 failing", // mocha's summary
    "npm ERR! code ELIFECYCLE",
    "thread 'main' panicked at src/main.rs:4:5:", // Rust
    "error[E0308]: mismatched types", // Rust
    "src/x.ts(10,5): error TS2322: Type 'string' is not assignable", // tsc
    "src/x.ts:10:5 - error TS2322: Type 'string' is not assignable", // tsc, pretty
    "  3:5  error  'x' is defined but never used  no-unused-vars", // eslint
    // Test runners' failure glyphs.
    "  ✕ retries item 1 (12ms)", // Jest
    " × src/a.test.ts > adds 8ms", // Vitest
    "  ✖ adds (1.2ms)", // Node's test runner, Mocha
    "✗ builds the index", // bats
    "  ✘  1 [chromium] › a.spec.ts:3:1 › opens", // Playwright
    "❌ deploy check",
    "not ok 3 - adds two numbers", // TAP
    "    not ok 1 - nested subtest",
    // Stack frames.
    "    at Object.<anonymous> (/work/src/app.test.ts:42:17)",
    "\tat com.example.Orders.total(Orders.java:88) ~[classes/:?]",
    "\tat java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)",
    '  File "/work/app.py", line 12, in <module>',
    "\t/usr/local/go/src/runtime/panic.go:884 +0x213",
    // pytest's detail and pointer lines: case matters.
    "E       assert 90 == 81",
    "E        +  where 90 = total(order)",
    ">       assert total(order) == 81",
    ">   x = compute()",
  ])("%j is an error line", (line) => expect(isErrorLine(line)).toBe(true));

  test.each([
    "GET /items/12 200 in 3ms",
    "  ✓ adds (3ms)",
    "warning: unused variable",
    "e       lower-case e is not pytest's", // the cased pattern stays cased
    "E assert with one space",
    "Everything went fine",
    "> app@1.0.0 build", // npm's script banner
    "> a quoted line",
    ">> two markers",
    "  at least three of them", // prose, no :line
    "nothing is not okay here",
    "",
  ])("%j is not", (line) => expect(isErrorLine(line)).toBe(false));
});
