// Seeded builders for the context rules' tests: a small PRNG (no dependency), random logs and JSON
// arrays with planted errors, and two realistic blocks. Not product code (excluded from coverage).

/** mulberry32: a seeded generator of floats in [0, 1), the same sequence on every platform. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;

/** Our marker, whole-line: the rule, the counts, the path. */
export const MARKER_LINE =
  /^\[frm-ctx ctx1\] \d+ lines, \d+ KB → \d+ lines kept \((json-array|dedupe|head-tail|dedupe\+head-tail): \d+ of \d+ (items|lines) omitted; \d+ error (items|lines) kept\)\. Original: .+ — read it with offset\/limit or grep it\.$/;

const int = (rand: Rand, lo: number, hi: number) =>
  lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(rand: Rand, list: readonly T[]): T =>
  list[Math.floor(rand() * list.length)] as T;

/** Words that match no part of the error pattern: plain log text, multi-byte text included. */
const WORDS = [
  "alpha",
  "beta",
  "gamma",
  "request",
  "served",
  "cache",
  "hit",
  "worker",
  "queue",
  "tick",
  "user",
  "done",
  "café",
  "naïve",
  "東京",
  "📦",
  "🚀",
] as const;

/** Lines the error pattern matches, one per shape it knows. */
export const ERROR_SAMPLES = [
  "Error: connection refused 127.0.0.1:5432",
  "TypeError: Cannot read properties of undefined (reading 'id')",
  "    at Object.<anonymous> (/work/src/app.test.ts:42:17)",
  "\tat com.example.Orders.total(Orders.java:88)",
  " FAIL  src/orders/total.test.ts > applies the discount",
  " × src/orders/total.test.ts > applies the discount 8ms",
  "✗ builds the index",
  "panic: runtime error: index out of range [5] with length 3",
  "Traceback (most recent call last):",
  '  File "/work/app.py", line 12, in <module>',
  "\t/usr/local/go/src/runtime/panic.go:884 +0x213",
  "npm ERR! code ELIFECYCLE",
  "fatal: not a git repository",
  "thread 'main' panicked at src/main.rs:4:5",
  "  ✕ retries item 1 (12ms)",
  "E       assert 90 == 81",
  ">       assert total(order) == 81",
  "not ok 3 - adds two numbers",
  "❌ deploy check",
] as const;

function plainLine(rand: Rand): string {
  const words = Array.from({ length: int(rand, 1, 12) }, () =>
    rand() < 0.3 ? String(int(rand, 0, 99_999)) : pick(rand, WORDS),
  );
  return words.join(" ");
}

export interface RandomLog {
  readonly text: string;
  /** Lines the pattern matches, in order. */
  readonly errorLines: readonly string[];
}

/** A random log: plain lines, similar runs, indented and long lines, planted error lines. */
export function randomLog(rand: Rand): RandomLog {
  const lines: string[] = [];
  const target = int(rand, 150, 2500);
  const errors: string[] = [];
  while (lines.length < target) {
    const roll = rand();
    if (roll < 0.04) {
      const e = `${pick(rand, ERROR_SAMPLES)} #${lines.length}`;
      errors.push(e);
      lines.push(e);
      const trace = int(rand, 0, 40);
      for (let k = 0; k < trace; k += 1) {
        lines.push(`    ${plainLine(rand)} (/work/f${k}.ts:${k}:1)`);
      }
    } else if (roll < 0.25) {
      const template = pick(rand, WORDS);
      const run = int(rand, 2, 60);
      for (let k = 0; k < run; k += 1) {
        lines.push(`${template} ${int(rand, 0, 5000)} served in ${k}ms`);
      }
    } else if (roll < 0.27) {
      lines.push(pick(rand, ["x", "é", "🚀"]).repeat(int(rand, 1_000, 3_000)));
    } else if (roll < 0.35) {
      lines.push(`  ${plainLine(rand)}`);
    } else if (roll < 0.38) {
      lines.push("");
    } else {
      lines.push(plainLine(rand));
    }
  }
  const eol = rand() < 0.1 ? "\r\n" : "\n";
  const trailing = rand() < 0.5 ? eol : "";
  // Indented trace lines and planted ones are not the only matches: take every line that matches.
  return { text: lines.join(eol) + trailing, errorLines: errors };
}

export interface RandomJson {
  readonly text: string;
  readonly errorItems: readonly unknown[];
  readonly pretty: boolean;
}

/** A random array of objects: one dominant schema, outliers, and planted error items. */
export function randomJsonArray(rand: Rand, wrap: boolean): RandomJson {
  const n = int(rand, 8, 600);
  const errorItems: unknown[] = [];
  const items = Array.from({ length: n }, (_, i) => {
    const base: Record<string, unknown> = {
      id: i,
      name: `${pick(rand, WORDS)}-${int(rand, 0, 999)}`,
      count: int(rand, 0, 10_000),
      tags: [pick(rand, WORDS), pick(rand, WORDS)],
      active: rand() < 0.5,
      owner: { login: pick(rand, WORDS), site_admin: false },
    };
    const roll = rand();
    if (roll < 0.03) {
      const item = { ...base, status: "failed" };
      errorItems.push(item);
      return item;
    }
    if (roll < 0.05) {
      const item = { ...base, error: { code: int(rand, 1, 9), detail: "x" } };
      errorItems.push(item);
      return item;
    }
    if (roll < 0.06) {
      const item = { ...base, result: { errors: [pick(rand, WORDS)] } };
      errorItems.push(item);
      return item;
    }
    if (roll < 0.1) return { ...base, extra: pick(rand, WORDS) };
    if (roll < 0.12) return { ...base, error: null, errors: [] };
    return base;
  });
  const value = wrap ? { total: n, page: 1, items } : items;
  const pretty = rand() < 0.5;
  const text = JSON.stringify(value, null, pretty ? 2 : undefined);
  return { text: rand() < 0.5 ? `${text}\n` : text, errorItems, pretty };
}

const TESTS = [
  "creates a user",
  "rejects a duplicate email",
  "lists orders by date",
  "applies the discount",
  "rounds the total",
  "sends the receipt",
  "retries a timeout",
  "keeps the cart",
] as const;

/** A 2000-line test run: request logs, passing tests, and three failures with their traces. */
export function realisticTestLog(): string {
  const rand = seeded(2_000);
  const lines: string[] = [" RUN  v5.0.0 /work/app", ""];
  const failAt = new Set([9, 27, 41]);
  for (let file = 0; lines.length < 1_990; file += 1) {
    const name = `src/${pick(rand, WORDS)}/case-${file}.test.ts`;
    for (let r = int(rand, 8, 40); r > 0; r -= 1) {
      const ms = int(rand, 1, 40);
      const at = `2026-09-26T10:${String(file % 60).padStart(2, "0")}:${String(r % 60).padStart(2, "0")}.${String(int(rand, 0, 999)).padStart(3, "0")}Z`;
      lines.push(
        `[api] ${at} INFO  GET /v1/items/${int(rand, 1, 9_999)} 200 in ${ms}ms`,
      );
    }
    TESTS.forEach((t, k) =>
      lines.push(` ✓ ${name} > ${t} #${k} ${int(rand, 1, 90)}ms`),
    );
    if (failAt.has(file)) {
      lines.push(
        ` × ${name} > applies the discount 8ms`,
        "   → expected 90 to be 81 // Object.is equality",
        "",
        ` FAIL  ${name} > applies the discount`,
        "AssertionError: expected 90 to be 81 // Object.is equality",
        "",
        "- Expected",
        "+ Received",
        "",
        "- 81",
        "+ 90",
        "",
        ` ❯ ${name}:42:25`,
        "     40|   const total = applyDiscount(order, 0.1);",
        "     41|   expect(total).toBe(81);",
        "       |                 ^",
        "    at applyDiscount (/work/app/src/orders/total.ts:17:9)",
        "    at /work/app/src/orders/total.test.ts:42:25",
      );
    }
  }
  lines.push(
    "",
    " Test Files  3 failed | 47 passed (50)",
    "      Tests  3 failed | 397 passed (400)",
    "   Start at  10:00:00",
    "   Duration  41.20s (transform 1.2s, setup 0ms, collect 3.4s, tests 30.1s)",
  );
  return `${lines.join("\n")}\n`;
}

/** 500 issues as a CLI prints them: pretty JSON, a few failing ones, a few with a milestone. */
export function realisticJson(): string {
  const rand = seeded(500);
  const issues = Array.from({ length: 500 }, (_, i) => {
    const title =
      i % 97 === 13
        ? `CI fails on Node 22 in job ${i}`
        : `${pick(rand, TESTS)} for ${pick(rand, WORDS)}`;
    const issue: Record<string, unknown> = {
      number: 1_000 + i,
      title,
      state: rand() < 0.7 ? "OPEN" : "CLOSED",
      labels: [{ name: pick(rand, ["bug", "docs", "perf", "ui"]) }],
      author: { login: `${pick(rand, WORDS)}${int(rand, 1, 99)}` },
      createdAt: `2026-0${int(rand, 1, 9)}-1${int(rand, 0, 9)}T0${int(rand, 0, 9)}:00:00Z`,
      comments: int(rand, 0, 40),
    };
    return i % 61 === 7 ? { ...issue, milestone: { title: "v2" } } : issue;
  });
  return `${JSON.stringify(issues, null, 2)}\n`;
}

/** Blocks whose output must not depend on the process or locale; Turkish casing included. */
export function determinismSamples(): string[] {
  const turkish = Array.from({ length: 300 }, (_, i) =>
    i % 50 === 0 ? `FAİL İSTANBUL ıi ${i}` : `satır ${i} ılık İyi`,
  ).join("\n");
  return [
    realisticTestLog(),
    realisticJson(),
    randomLog(seeded(11)).text,
    randomLog(seeded(12)).text,
    randomJsonArray(seeded(13), false).text,
    randomJsonArray(seeded(14), true).text,
    turkish,
  ];
}
