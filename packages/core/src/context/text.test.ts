import { describe, expect, test } from "vitest";
import {
  cutLine,
  lineCount,
  needsCompression,
  splitText,
  utf8Bytes,
} from "./text.js";

const HIGH = "\ud83d"; // the first half of 😀
const LOW = "\ude00";

describe("utf8Bytes counts as an encoder writes", () => {
  test.each([
    ["", 0],
    ["abc", 3],
    ["é", 2],
    ["東", 3],
    ["😀", 4],
    [`a${HIGH}`, 4], // a lone high surrogate at the end: U+FFFD
    [`${HIGH}a`, 4], // a high surrogate not followed by a low one
    [LOW, 3], // a lone low surrogate
  ])("%j → %i", (s, bytes) => {
    expect(utf8Bytes(s)).toBe(bytes);
    expect(bytes).toBe(new TextEncoder().encode(s).length);
  });
});

describe("lineCount: a final line break ends a line", () => {
  test.each([
    ["", 1],
    ["a", 1],
    ["a\n", 1],
    ["a\nb", 2],
    ["a\nb\n", 2],
    ["\n\n", 2],
    ["a\r\nb\r\n", 2],
  ])("%j → %i", (text, lines) => expect(lineCount(text)).toBe(lines));
});

describe("needsCompression: over 8 KB or over 200 lines", () => {
  test.each([
    ["x".repeat(8192), false],
    ["x".repeat(8193), true],
    ["é".repeat(4096), false], // 8192 bytes in 4096 chars
    ["é".repeat(4097), true],
    ["x\n".repeat(200), false],
    ["x\n".repeat(201), true],
    [`${"x\n".repeat(200)}x`, true],
    ["", false],
  ])("%#", (text, want) => expect(needsCompression(text)).toBe(want));
});

describe("splitText", () => {
  test.each([
    ["a\nb", { lines: ["a", "b"], eol: "\n", trailing: false }],
    ["a\nb\n", { lines: ["a", "b"], eol: "\n", trailing: true }],
    ["a\r\nb\r\n", { lines: ["a", "b"], eol: "\r\n", trailing: true }],
    ["a\r\nb", { lines: ["a", "b"], eol: "\r\n", trailing: false }],
    // A leading line break has no \r before it: LF.
    ["\na\r\nb", { lines: ["", "a", "b"], eol: "\n", trailing: false }],
    // The first line break decides; a stray \r\n later is still split, a lone \r is content.
    ["a\nb\r\nc\rd", { lines: ["a", "b", "c\rd"], eol: "\n", trailing: false }],
    ["", { lines: [""], eol: "\n", trailing: false }],
    ["one", { lines: ["one"], eol: "\n", trailing: false }],
  ])("%j", (text, want) => expect(splitText(text)).toEqual(want));
});

describe("cutLine: at a code-point boundary, never inside a surrogate pair", () => {
  test("a line that fits is unchanged", () => {
    expect(cutLine("x".repeat(10), 10)).toBe("x".repeat(10));
    expect(cutLine("", 10)).toBe("");
  });

  test("ASCII is cut at the byte budget", () => {
    expect(cutLine("x".repeat(15), 10)).toBe(`${"x".repeat(10)}…[+5 chars]`);
  });

  test("a pair that would straddle the budget is left whole on the cut side", () => {
    const line = `a${"😀".repeat(10)}`; // 1 + 40 bytes
    const out = cutLine(line, 10); // a + 2 emoji = 9 bytes; a third would be 13
    expect(out).toBe(`a😀😀…[+${line.length - 5} chars]`);
    const kept = out.slice(0, out.indexOf("…"));
    expect(kept.at(-1)).toBe(LOW);
  });

  test("two- and three-byte characters stop before the budget", () => {
    expect(cutLine("ééé", 5)).toBe("éé…[+1 chars]");
    expect(cutLine("東東東", 7)).toBe("東東…[+1 chars]");
  });

  test("a lone surrogate counts three bytes", () => {
    expect(cutLine(`${HIGH}${HIGH}${HIGH}`, 6)).toBe(
      `${HIGH}${HIGH}…[+1 chars]`,
    );
  });
});
