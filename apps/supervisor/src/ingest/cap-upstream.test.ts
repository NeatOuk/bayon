// A tool result capped upstream (the API's MCP backstop) arrives under the cap
// with one marker line. Ingest records the marker's facts, but only for a file in this session's
// logs/tool/: an agent can print a fake marker.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { truncationMarker, type CanonicalEvent } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { capEvent } from "./cap.js";

const dir = realpathSync(mkdtempSync("/tmp/frm-cap-up-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const toolDir = join(dir, "logs", "tool");
mkdirSync(toolDir, { recursive: true });
const full = join(toolDir, "mcp-01J.txt");
writeFileSync(full, "x".repeat(9_000));
writeFileSync(join(dir, "outside.txt"), "secret");
symlinkSync(join(dir, "outside.txt"), join(toolDir, "link.txt"));

const result = (
  text: string,
  kind: "tool_result" | "assistant_text" = "tool_result",
): CanonicalEvent =>
  kind === "tool_result"
    ? {
        ts: 1,
        runner_type: "x.tool",
        kind,
        status: "ok",
        text,
        payload: { call_id: "c1" },
      }
    : { ts: 1, runner_type: "x.text", kind, text, payload: {} };

const projection = (path: string) =>
  ["head", truncationMarker({ lines: 300, bytes: 9_000, path }), "tail"].join(
    "\n",
  );

test("a marker naming a file in this session's logs/tool/ sets truncated, bytes_original, payload_path", () => {
  const text = projection(full);
  const s = capEvent(result(text), { toolDir, rawOffset: 5 });
  expect(s).toMatchObject({
    text,
    payload_path: full,
    bytes_original: 9_000,
    truncated: 1,
  });
});

test("a marker naming a path outside logs/tool/, a missing file or a symlink out is ignored", () => {
  for (const path of [
    join(dir, "outside.txt"),
    join(toolDir, "..", "..", "outside.txt"),
    join(toolDir, "gone.txt"),
    join(toolDir, "link.txt"),
    "relative/logs/tool/mcp-01J.txt",
  ]) {
    const s = capEvent(result(projection(path)), { toolDir, rawOffset: 5 });
    expect(s, path).toMatchObject({ payload_path: null, truncated: 0 });
  }
});

test("two markers, or a marker outside a tool result, are ignored", () => {
  const twice = `${projection(full)}\n${truncationMarker({ lines: 1, bytes: 1, path: full })}`;
  expect(capEvent(result(twice), { toolDir, rawOffset: 5 })).toMatchObject({
    truncated: 0,
  });
  expect(
    capEvent(result(projection(full), "assistant_text"), {
      toolDir,
      rawOffset: 5,
    }),
  ).toMatchObject({ truncated: 0, payload_path: null });
});
