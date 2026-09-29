// Design an earlier change §5: every MCP result is capped (§8.5). Over its cap the full text goes to the
// session's logs/tool/ and the agent gets head, one marker line and tail, within the cap.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTruncationMarker, type Result } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { capResult } from "./cap.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "frm-mcp-cap-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const toolDir = join(dir, "sessions", "S1", "logs", "tool");
const limits = { bytes: 8 * 1024, lines: 200 };
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const lines = (s: string) => s.split("\n").length;
const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

test("a result within its cap passes unchanged, and nothing is written", () => {
  expect(must(capResult('{"a":1}', { limits, toolDir, fileId: "f0" }))).toEqual(
    { text: '{"a":1}' },
  );
  expect(existsSync(join(toolDir, "mcp-f0.txt"))).toBe(false);
});

test("over the byte cap: the full text goes to logs/tool/mcp-<id>.txt (0600), the agent gets head, marker and tail", () => {
  const text = "x".repeat(20_000);
  const capped = must(capResult(text, { limits, toolDir, fileId: "f1" }));
  const file = join(toolDir, "mcp-f1.txt");
  expect(readFileSync(file, "utf8")).toBe(text);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(bytes(capped.text)).toBeLessThanOrEqual(limits.bytes);
  expect(parseTruncationMarker(capped.text)).toEqual({
    lines: 1,
    bytes: 20_000,
    path: file,
  });
});

test("over the line cap: the first 60 and the last 60 lines survive", () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const capped = must(capResult(text, { limits, toolDir, fileId: "f2" }));
  const kept = capped.text.split("\n");
  expect(kept.slice(0, 60)).toEqual(text.split("\n").slice(0, 60));
  expect(kept.slice(-60)).toEqual(text.split("\n").slice(-60));
  expect(lines(capped.text)).toBeLessThanOrEqual(limits.lines);
  expect(parseTruncationMarker(capped.text)?.lines).toBe(500);
});

test("lowered caps still hold: head and tail shrink to fit", () => {
  const small = { bytes: 1024, lines: 40 };
  const text = Array.from({ length: 500 }, (_, i) => `row ${i}`).join("\n");
  const capped = must(
    capResult(text, { limits: small, toolDir, fileId: "f3" }),
  );
  expect(lines(capped.text)).toBeLessThanOrEqual(small.lines);
  expect(bytes(capped.text)).toBeLessThanOrEqual(small.bytes);
  expect(parseTruncationMarker(capped.text)?.path).toBe(
    join(toolDir, "mcp-f3.txt"),
  );
});

test("multibyte text is never cut inside a character", () => {
  const capped = must(
    capResult("é".repeat(10_000), { limits, toolDir, fileId: "f4" }),
  );
  expect(capped.text).not.toContain("�");
  expect(bytes(capped.text)).toBeLessThanOrEqual(limits.bytes);
});

test("without a runtime dir the result is still cut, with no path to claim", () => {
  const capped = must(
    capResult("y".repeat(20_000), { limits, toolDir: null, fileId: "f5" }),
  );
  expect(bytes(capped.text)).toBeLessThanOrEqual(limits.bytes);
  expect(parseTruncationMarker(capped.text)).toBeUndefined();
  expect(capped.text).toContain("not kept");
});
