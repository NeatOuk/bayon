import { describe, expect, test } from "vitest";
import {
  hasImpreciseNumber,
  isErrorItem,
  jsonArrayRule,
  type JsonArrayVerdict,
} from "./json-array.js";

const item = (i: number, extra: Record<string, unknown> = {}) => ({
  id: i,
  name: `n${i}`,
  ...extra,
});
const items = (n: number) => Array.from({ length: n }, (_, i) => item(i));

function body(v: JsonArrayVerdict) {
  if (v.kind !== "body") throw new Error(`expected a body, got ${v.kind}`);
  return v;
}
const parsedBody = (v: JsonArrayVerdict): unknown => JSON.parse(body(v).text);

describe("isErrorItem", () => {
  test.each([
    [{ a: "ok" }, false],
    [{ status: "failed" }, true],
    [{ msg: "TypeError: x" }, true],
    [{ deep: { list: [1, true, null, { note: "panic: boom" }] } }, true],
    [{ deep: { list: [1, true, null, { note: "fine" }] } }, false],
    [{ Error: "x" }, true], // any case
    [{ exception: { type: "x" } }, true],
    [{ errors: ["x"] }, true],
    [{ error: 1 }, true],
    [{ error: true }, true],
    [{ result: { error: "boom" } }, true], // a nested key counts too
    // Empty values say "no error".
    [{ error: null }, false],
    [{ error: false }, false],
    [{ error: 0 }, false],
    [{ error: "" }, false],
    [{ errors: [] }, false],
    [{ exception: {} }, false],
    [{ errorCount: 3 }, false], // not one of the keys, and a number is no string
  ])("%j → %s", (value, want) => expect(isErrorItem(value)).toBe(want));
});

describe("hasImpreciseNumber scans literals outside strings", () => {
  test.each([
    ["[1,2,3]", false],
    ["123456789012345", false], // 15 digits
    ["1234567890123456", true], // 16
    ["1.23456789012345", false],
    ["1.234567890123456", true],
    ["-0.000000000000001", true], // leading zeros are digits too
    ['["1234567890123456"]', false], // inside a string
    ['["a\\"1234567890123456"]', false], // an escaped quote does not end it
    ['{"k":1e99}', false],
    ['{"k":1E+99}', false],
    ['{"k":1e-400}', true],
    ['{"k":1e308}', true],
    ["2e5", false],
    ["2e", false], // an exponent without digits (not JSON; no crash)
    ['"unterminated 1234567890123456', false],
    // A negative zero parses to -0 and serialises as 0.
    ["-0", true],
    ["[1,-0]", true],
    ["[-0.0]", true],
    ['{"k":-0e5}', true],
    ["[0, 0.0, -5, -0.5, -10, 1e-0]", false],
    ['["-0"]', false],
  ])("%j → %s", (text, want) => expect(hasImpreciseNumber(text)).toBe(want));
});

describe("jsonArrayRule: when it applies", () => {
  test.each([
    ["not JSON", "plain log line\nanother"],
    ["a JSON scalar", '"just a string"'],
    ["an object without arrays", '{"a":1,"b":{"c":2}}'],
    ["fewer than 8 items", JSON.stringify(items(7))],
    ["an item that is not an object", JSON.stringify([...items(8), 3])],
    ["an item that is an array", JSON.stringify([...items(8), [1]])],
    ["an item that is null", JSON.stringify([...items(8), null])],
    [
      "an array of numbers",
      JSON.stringify(Array.from({ length: 50 }, (_, i) => i)),
    ],
  ])("%s → skip", (_, text) => {
    expect(jsonArrayRule(text)).toEqual({ kind: "skip" });
  });

  test("a 16-digit number declines, before any rewriting", () => {
    const text = JSON.stringify([
      ...items(20),
      item(20, { big: "12345678901234567" }),
    ]);
    expect(jsonArrayRule(text).kind).toBe("body"); // as a string it is fine
    const raw = text.replace('"12345678901234567"', "12345678901234567");
    expect(jsonArrayRule(raw)).toEqual({
      kind: "decline",
      reason: "precision",
    });
  });

  test("error items over 16 KB decline", () => {
    const big = "failed ".repeat(600); // ~4 KB each
    const list = [
      ...items(10),
      ...Array.from({ length: 5 }, (_, i) => item(i, { big })),
    ];
    expect(jsonArrayRule(JSON.stringify(list))).toEqual({
      kind: "decline",
      reason: "errors_over_budget",
    });
    const fewer = [
      ...items(10),
      ...Array.from({ length: 3 }, (_, i) => item(i, { big })),
    ];
    expect(jsonArrayRule(JSON.stringify(fewer)).kind).toBe("body");
  });
});

describe("jsonArrayRule: what it keeps", () => {
  test("head 5, tail 3, and one counted gap with the gap's schema", () => {
    const v = body(jsonArrayRule(JSON.stringify(items(100))));
    expect(JSON.parse(v.text)).toEqual([
      ...items(5),
      "… 92 items omitted; schema {id:number,name:string}",
      ...items(100).slice(97),
    ]);
    expect(v).toMatchObject({ items: 100, omittedItems: 92, errorItems: 0 });
  });

  test("error items stay in place, splitting the gap", () => {
    const list = items(40).map((x, i) =>
      i === 20
        ? { ...x, status: "FAIL" }
        : i === 21
          ? { ...x, error: "boom" }
          : x,
    );
    const out = parsedBody(jsonArrayRule(JSON.stringify(list))) as unknown[];
    expect(out).toEqual([
      ...list.slice(0, 5),
      "… 15 items omitted; schema {id:number,name:string}",
      list[20],
      list[21],
      "… 15 items omitted; schema {id:number,name:string}",
      ...list.slice(37),
    ]);
    expect(body(jsonArrayRule(JSON.stringify(list))).errorItems).toBe(2);
  });

  test("up to 10 schema outliers not kept already; a tie of key sets goes to the first", () => {
    // 20 of each key set: {id,name} is seen first, so the {id,name,x} items are the outliers.
    const list = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? item(i) : item(i, { x: i }),
    );
    const out = parsedBody(jsonArrayRule(JSON.stringify(list))) as {
      id: number;
      x?: number;
    }[];
    const outliers = out.filter((x) => typeof x === "object" && "x" in x);
    // Items 1 and 3 are in the head: kept anyway, not counted among the 10.
    expect(outliers.map((x) => x.id)).toEqual([
      1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 37, 39,
    ]);
  });

  test("a gap's schema lists every type a key had, in first-seen order", () => {
    const ks = ["s", 1, true, null, [1], { a: 1 }, "again"];
    const list = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: i, k: "head" })),
      ...ks.map((k, i) => ({ id: 5 + i, k })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: 12 + i, k: "tail" })),
    ];
    const out = parsedBody(jsonArrayRule(JSON.stringify(list))) as unknown[];
    expect(out.filter((x) => typeof x === "string")).toEqual([
      "… 7 items omitted; schema {id:number,k:string|number|boolean|null|array|object}",
    ]);
  });

  test("the top-level object's array with the most items is the one compressed", () => {
    const value = { total: 3, small: items(8), rows: items(50), tail: "x" };
    const out = parsedBody(jsonArrayRule(JSON.stringify(value))) as Record<
      string,
      unknown
    >;
    expect(Object.keys(out)).toEqual(["total", "small", "rows", "tail"]);
    expect(out.small).toEqual(items(8));
    expect((out.rows as unknown[]).length).toBe(9);
  });

  test("of two arrays with as many items, the first", () => {
    const value = { a: items(20), b: items(20) };
    const out = parsedBody(jsonArrayRule(JSON.stringify(value))) as Record<
      string,
      unknown[]
    >;
    expect(out.a?.length).toBe(9);
    expect(out.b?.length).toBe(20);
  });

  test("pretty in, pretty out; compact in, compact out", () => {
    const list = items(30);
    expect(body(jsonArrayRule(JSON.stringify(list))).text).not.toContain("\n");
    const pretty = body(
      jsonArrayRule(`${JSON.stringify(list, null, 4)}\n`),
    ).text;
    expect(pretty.split("\n")[1]).toBe("  {");
  });

  test("with every item kept there is nothing omitted", () => {
    const v = body(jsonArrayRule(JSON.stringify(items(8))));
    expect(v.omittedItems).toBe(0);
    expect(JSON.parse(v.text)).toEqual(items(8));
  });

  test("a __proto__ key stays an own property", () => {
    const text = `{"__proto__":{"polluted":true},"rows":${JSON.stringify(items(20))}}`;
    const out = parsedBody(jsonArrayRule(text)) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["__proto__", "rows"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
