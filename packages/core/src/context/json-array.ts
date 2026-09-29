// json-array: a JSON array of objects keeps its first and last items, its error items and a few
// schema outliers; each run of the rest becomes one string element with a count and a schema. The
// output is valid JSON. Pure and deterministic: JSON.parse/stringify are exactly specified, keys
// sort by code unit, Map iterates in insertion order.
import {
  ERROR_BUDGET_BYTES,
  JSON_HEAD_ITEMS,
  JSON_MAX_OUTLIERS,
  JSON_MIN_ITEMS,
  JSON_TAIL_ITEMS,
  PRECISION_DIGITS,
  PRECISION_EXPONENT_DIGITS,
  isErrorLine,
} from "./constants.js";
import { utf8Bytes } from "./text.js";

type JsonObject = { readonly [key: string]: unknown };

export type JsonArrayVerdict =
  /** Not JSON, or no array of enough objects: the line rules may try. */
  | { readonly kind: "skip" }
  | {
      readonly kind: "decline";
      readonly reason: "precision" | "errors_over_budget";
    }
  | {
      readonly kind: "body";
      /** The JSON text, without the marker. */
      readonly text: string;
      readonly items: number;
      readonly omittedItems: number;
      readonly errorItems: number;
    };

const SKIP: JsonArrayVerdict = { kind: "skip" };

const isObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Keys whose non-empty value makes an item an error item, compared lower-cased. */
const ERROR_KEYS: ReadonlySet<string> = new Set([
  "error",
  "errors",
  "exception",
]);

/** `null`, `false`, `0`, `""`, `[]` and `{}` say "no error". */
function isEmpty(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0;
  if (isObject(v)) return Object.keys(v).length === 0;
  return v === null || v === false || v === 0 || v === "";
}

/** A string value matching the error pattern, or a non-empty error key, anywhere inside. */
export function isErrorItem(item: JsonObject): boolean {
  const stack: unknown[] = [item];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") {
      if (isErrorLine(v)) return true;
    } else if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (isObject(v)) {
      for (const [key, x] of Object.entries(v)) {
        if (ERROR_KEYS.has(key.toLowerCase()) && !isEmpty(x)) return true;
        stack.push(x);
      }
    }
  }
  return false;
}

const QUOTE = 0x22;
const MINUS = 0x2d;
const BACKSLASH = 0x5c;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isExponent = (c: number) => c === 0x65 || c === 0x45; // e E
const isSign = (c: number) => c === 0x2b || c === MINUS; // + -

/** The index just past the string whose opening quote is at `start - 1`. */
function skipString(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) return i + 1;
    i += c === BACKSLASH ? 2 : 1;
  }
  return i;
}

/** The index just past a run of digits (and dots, when `dots`), and the digits in it. */
function digitRun(text: string, start: number, dots: boolean) {
  let i = start;
  let digits = 0;
  for (; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (isDigit(c)) digits += 1;
    else if (!(dots && c === 0x2e)) break;
  }
  return { end: i, digits };
}

/**
 * Whether a number literal outside the strings of valid JSON `text` would not survive a parse and
 * re-serialise: 16+ mantissa digits, a 3+ digit exponent, or a negative zero (`-0`, `-0.0e5`:
 * JSON.stringify writes `0`).
 */
export function hasImpreciseNumber(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) {
      i = skipString(text, i + 1);
      continue;
    }
    if (!isDigit(c)) {
      i += 1;
      continue;
    }
    const mantissa = digitRun(text, i, true);
    if (mantissa.digits >= PRECISION_DIGITS) return true;
    const negative = text.charCodeAt(i - 1) === MINUS;
    if (negative && !/[1-9]/.test(text.slice(i, mantissa.end))) return true;
    i = mantissa.end;
    if (i < text.length && isExponent(text.charCodeAt(i))) {
      i += isSign(text.charCodeAt(i + 1)) ? 2 : 1;
      const exponent = digitRun(text, i, false);
      if (exponent.digits >= PRECISION_EXPONENT_DIGITS) return true;
      i = exponent.end;
    }
  }
  return false;
}

interface Target {
  /** The top-level object holding the array, or null when the array is the top level. */
  readonly holder: JsonObject | null;
  readonly key: string;
  readonly items: readonly unknown[];
}

/** The array to compress: the top level, or the top-level object's array with the most items. */
function target(value: unknown): Target | null {
  if (Array.isArray(value)) return { holder: null, key: "", items: value };
  if (!isObject(value)) return null;
  let best: Target | null = null;
  for (const [key, v] of Object.entries(value)) {
    if (Array.isArray(v) && (best === null || v.length > best.items.length)) {
      best = { holder: value, key, items: v };
    }
  }
  return best;
}

const parse = (text: string): { value: unknown } | null => {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null; // not JSON: the line rules may try
  }
};

const keySet = (item: JsonObject) =>
  JSON.stringify(Object.keys(item).toSorted());

/** The most frequent key set; a tie goes to the one seen first. */
function dominant(sets: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const set of sets) counts.set(set, (counts.get(set) ?? 0) + 1);
  let best: string | undefined;
  let most = 0;
  for (const [set, n] of counts) {
    if (n > most) [best, most] = [set, n];
  }
  return best;
}

const typeName = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

/** `{key:type|type,…}` over `items`, keys and types in first-seen order. */
function schemaOf(items: readonly JsonObject[]): string {
  const types = new Map<string, string[]>();
  for (const item of items) {
    for (const [key, v] of Object.entries(item)) {
      const seen = types.get(key) ?? [];
      const name = typeName(v);
      types.set(key, seen.includes(name) ? seen : [...seen, name]);
    }
  }
  const fields = [...types].map(([key, names]) => `${key}:${names.join("|")}`);
  return `{${fields.join(",")}}`;
}

/** Which items to keep: head, tail, errors, then the first outliers not already kept. */
function keptIndices(
  items: readonly JsonObject[],
  errors: readonly boolean[],
): ReadonlySet<number> {
  const n = items.length;
  const kept = new Set<number>();
  items.forEach((_, i) => {
    if (i < JSON_HEAD_ITEMS || i >= n - JSON_TAIL_ITEMS || errors[i]) {
      kept.add(i);
    }
  });
  const sets = items.map(keySet);
  const main = dominant(sets);
  const outliers = sets
    .flatMap((set, i) => (set !== main && !kept.has(i) ? [i] : []))
    .slice(0, JSON_MAX_OUTLIERS);
  return new Set([...kept, ...outliers]);
}

const gapNote = (gap: readonly JsonObject[]) =>
  `… ${gap.length} items omitted; schema ${schemaOf(gap)}`;

/** Kept items in order, each run of the rest replaced by one counted gap string. */
function withGaps(
  items: readonly JsonObject[],
  kept: ReadonlySet<number>,
): unknown[] {
  const out: unknown[] = [];
  let start = 0; // where the current run of omitted items began
  for (let i = 0; i <= items.length; i += 1) {
    if (i < items.length && !kept.has(i)) continue;
    if (i > start) out.push(gapNote(items.slice(start, i)));
    if (i < items.length) out.push(items[i]);
    start = i + 1;
  }
  return out;
}

export function jsonArrayRule(text: string): JsonArrayVerdict {
  // No pre-check: JSON.parse stops at a log's first character that cannot be JSON.
  const parsed = parse(text);
  if (parsed === null) return SKIP;
  const found = target(parsed.value);
  if (found === null || found.items.length < JSON_MIN_ITEMS) return SKIP;
  const items = found.items;
  if (!items.every(isObject)) return SKIP;
  if (hasImpreciseNumber(text)) return { kind: "decline", reason: "precision" };
  const errors = items.map(isErrorItem);
  const errorBytes = items.reduce(
    (sum, item, i) => (errors[i] ? sum + utf8Bytes(JSON.stringify(item)) : sum),
    0,
  );
  if (errorBytes > ERROR_BUDGET_BYTES) {
    return { kind: "decline", reason: "errors_over_budget" };
  }
  const kept = keptIndices(items, errors);
  const array = withGaps(items, kept);
  const value =
    found.holder === null ? array : { ...found.holder, [found.key]: array };
  const pretty = text.trim().includes("\n");
  return {
    kind: "body",
    text: JSON.stringify(value, null, pretty ? 2 : undefined),
    items: items.length,
    omittedItems: items.length - kept.size,
    errorItems: errors.filter(Boolean).length,
  };
}
