import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalEvent } from "@bayon/core";
import { toCanonical, type EventRow } from "@bayon/db";
import { afterAll, expect, test } from "vitest";
import {
  HEAD_LINES,
  PAYLOAD_MAX_BYTES,
  REASONING_ROW_BYTES,
  TAIL_LINES,
  TOOL_RESULT_MAX_BYTES,
  capEvent,
} from "./cap.js";

const dir = mkdtempSync("/tmp/frm-cap-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const toolDir = join(dir, "tool");
const bytes = (s: string | null | undefined) => Buffer.byteLength(s ?? "");
const base = { ts: 1, runner_type: "fixture.tool" } as const;

const toolResult = (text: string, callId: string): CanonicalEvent => ({
  ...base,
  kind: "tool_result",
  status: "ok",
  text,
  payload: { call_id: callId },
});

/** The row as the API would read it back. */
const readBack = (
  e: CanonicalEvent,
  s: ReturnType<typeof capEvent>,
): EventRow => ({
  id: 1,
  session_id: "s",
  run_id: null,
  ts: e.ts,
  kind: e.kind,
  runner_type: e.runner_type,
  tool_name: e.tool_name ?? null,
  status: e.status ?? null,
  exit_code: null,
  text: s.text,
  payload_json: s.payload_json,
  payload_path: s.payload_path,
  bytes_original: s.bytes_original,
  truncated: s.truncated,
  raw_offset: 0,
});

test("a small tool result stays in the row, its size recorded", () => {
  const s = capEvent(toolResult("hello\nworld", "c1"), {
    toolDir,
    rawOffset: 10,
  });
  expect(s).toEqual({
    text: "hello\nworld",
    payload_json: '{"call_id":"c1"}',
    payload_path: null,
    bytes_original: 11,
    truncated: 0,
  });
  expect(existsSync(join(toolDir, "c1.txt"))).toBe(false);
});

test("over 200 lines: head 60 + tail 60 in the row, the rest in <call-id>.txt (§8.5)", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
  const text = lines.join("\n");
  const s = capEvent(toolResult(text, "call-big"), { toolDir, rawOffset: 20 });
  const path = join(toolDir, "call-big.txt");
  expect(readFileSync(path, "utf8")).toBe(text);
  expect(s).toMatchObject({
    payload_path: path,
    truncated: 1,
    bytes_original: bytes(text),
  });
  const kept = s.text ?? "";
  expect(bytes(kept)).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
  expect(kept.startsWith(lines.slice(0, HEAD_LINES).join("\n"))).toBe(true);
  expect(kept.endsWith(lines.slice(-TAIL_LINES).join("\n"))).toBe(true);
  expect(kept).not.toContain("\nline 100\n");
  expect(kept).toContain(path);
  expect(JSON.parse(s.payload_json ?? "")).toEqual({
    call_id: "call-big",
    output_path: path,
  });
});

test("over 8 KB on one line: cut to 8 KB, never mid-character", () => {
  const text = "é".repeat(10_000);
  const s = capEvent(toolResult(text, "call-wide"), { toolDir, rawOffset: 30 });
  expect(bytes(s.text)).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
  expect(s.text).not.toContain("�");
  expect(s.text?.startsWith("éé")).toBe(true);
  expect(s.text?.endsWith("éé")).toBe(true);
  expect(readFileSync(join(toolDir, "call-wide.txt"), "utf8")).toBe(text);
});

test("a call id that is not a plain file name never becomes a path", () => {
  const s = capEvent(toolResult("x\n".repeat(300), "../../etc/passwd"), {
    toolDir,
    rawOffset: 40,
  });
  expect(s.payload_path).toBe(join(toolDir, "40-tool_result.txt"));
});

test("reasoning keeps 4 KB in the row and the full text on disk (§4)", () => {
  const text = "why ".repeat(3_000);
  const e: CanonicalEvent = { ...base, kind: "reasoning", text, payload: {} };
  const s = capEvent(e, { toolDir, rawOffset: 50 });
  expect(s.text).toBe(text.slice(0, REASONING_ROW_BYTES));
  expect(s).toMatchObject({ truncated: 1, bytes_original: 12_000 });
  expect(readFileSync(s.payload_path ?? "", "utf8")).toBe(text);
  const short = capEvent({ ...e, text: "brief" }, { toolDir, rawOffset: 51 });
  expect(short).toMatchObject({ text: "brief", truncated: 0 });
  expect(short.payload_path).toBeNull();
});

test("a payload over 8 KB goes to disk, the row keeps a valid smaller one", () => {
  const e: CanonicalEvent = {
    ...base,
    kind: "tool_call",
    tool_name: "write",
    payload: {
      call_id: "call-w",
      input: { path: "a.txt", content: "x".repeat(20_000) },
    },
  };
  const s = capEvent(e, { toolDir, rawOffset: 60 });
  const path = join(toolDir, "60-tool_call.json");
  expect(s).toMatchObject({
    payload_path: path,
    truncated: 1,
    bytes_original: bytes(JSON.stringify(e.payload)),
  });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(e.payload);
  expect(bytes(s.payload_json)).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
  expect(toCanonical(readBack(e, s))).toMatchObject({
    kind: "tool_call",
    payload: { call_id: "call-w", input: { path: "a.txt" } },
  });
});

test("a long list is shortened, and the row still parses as its kind", () => {
  const items = Array.from({ length: 2_000 }, (_, i) => ({
    text: `task ${i} ${"-".repeat(40)}`,
    status: "pending" as const,
  }));
  const e: CanonicalEvent = { ...base, kind: "todo", payload: { items } };
  const s = capEvent(e, { toolDir, rawOffset: 70 });
  expect(bytes(s.payload_json)).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
  const back = toCanonical(readBack(e, s));
  expect(back.kind).toBe("todo");
  expect(back.payload).toMatchObject({ truncated_payload: true });
});

test("any other text over 8 KB is cut to 8 KB with the full text on disk", () => {
  const text = "a".repeat(9_000);
  const e: CanonicalEvent = {
    ...base,
    kind: "assistant_text",
    text,
    payload: {},
  };
  const s = capEvent(e, { toolDir, rawOffset: 80 });
  expect(bytes(s.text)).toBe(TOOL_RESULT_MAX_BYTES);
  expect(readFileSync(s.payload_path ?? "", "utf8")).toBe(text);
});
